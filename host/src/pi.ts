import { createHash, randomUUID } from 'node:crypto'
import { writeHostDiagnostic } from '../../shared/diagnostics.ts'
import { mkdir, open, readFile, realpath } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { InMemoryCredentialStore, type AssistantMessage, type ImageContent } from '@earendil-works/pi-ai'
import {
  createAgentSession,
  estimateTokens,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { ModelUnavailableError, previewImageLimits, toolImages } from './execution.ts'
import type { AgentExecution, ExecutionConfig, ExecutionResult, ExecutionSession, ExecutionTool, ModelCandidate, ModelRoute, RuntimeEvent, SessionRef, ToolImage } from './execution.ts'
import { fetchProviderCatalog, isProviderId, managedProviderIds, providerName, validProviderKey } from './model-management.ts'
import type { ProviderCatalog } from './model-management.ts'
import type { ManagedModel, ManagedProvider, ProviderId } from '../../shared/contracts/management.ts'
import type { ChatGptSession } from '../../shared/contracts/chatgpt.ts'
import { chatGptResponsesFetch, chatGptResponsesPayload } from './chatgpt-responses.ts'
import { codingResources } from './coding-resources.ts'

function fingerprint(key: string): string { return createHash('sha256').update(key).digest('hex') }

function isChatGptProvider(provider: string): boolean { return provider.startsWith('chatgpt-') }

function localRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false })
}

export class PiExecution implements AgentExecution {
  private runtime?: Promise<ModelRuntime>
  private readonly createRuntime: () => Promise<ModelRuntime>
  private readonly environmentOnly: boolean
  private readonly credentials = new Map<ProviderId, 'stored' | 'missing'>()
  private readonly catalogs = new Map<ProviderId, ProviderCatalog>()
  private readonly validatedKeys = new Map<ProviderId, { fingerprint: string; catalog: ProviderCatalog }>()
  private readonly revisions = new Map<ProviderId, number>()
  private readonly request: typeof fetch
  private chatGptRuntime?: Promise<ModelRuntime>
  private chatGptSession?: ChatGptSession

  constructor(createRuntime?: () => Promise<ModelRuntime>, request: typeof fetch = fetch) {
    this.environmentOnly = createRuntime === undefined
    this.request = request
    this.createRuntime = createRuntime ?? localRuntime
  }

  private async getRuntime(): Promise<ModelRuntime> {
    this.runtime ??= this.createRuntime().catch(() => {
      this.runtime = undefined
      throw modelUnavailable('Pi could not load its model and credential configuration')
    })
    return this.runtime
  }

  async validateRoute(route: ModelRoute): Promise<void> {
    await this.resolveModel(await this.runtimeFor(route), route)
  }

  async discoverModels(provider?: string): Promise<ModelCandidate[]> {
    const chatGpt = !provider || isChatGptProvider(provider) ? await this.chatGptModels() : []
    if (provider && isChatGptProvider(provider)) return chatGpt.filter(({ route }) => route.provider === provider)
    const runtime = await this.getRuntime()
    const candidates = runtime.getModels(provider).filter(model =>
      (!this.environmentOnly || isProviderId(model.provider)) && this.providerAllows(model.provider, model.id) && model.input.includes('text'))
    const authorized = new Set((await Promise.all([...new Set(candidates.map(model => model.provider))].map(async id =>
      await runtime.checkAuth(id).catch(() => undefined) ? id : undefined))).filter(Boolean))
    return [...candidates.filter(model => authorized.has(model.provider)).map(model => ({
      route: { provider: model.provider, model: model.id }, contextWindow: model.contextWindow,
      input: model.input, reasoning: model.reasoning, estimatedCost: model.cost.input + model.cost.output,
    })), ...chatGpt]
  }

  async setChatGptSession(session: ChatGptSession | null): Promise<ManagedModel[]> {
    if (session === null) {
      this.chatGptSession = undefined
      if (this.chatGptRuntime) await (await this.chatGptRuntime).removeRuntimeApiKey('openai')
      return []
    }
    if (!session || typeof session.profileId !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/u.test(session.profileId) ||
      typeof session.accessToken !== 'string' || !/^[\x21-\x7e]{16,16384}$/u.test(session.accessToken) ||
      session.accessToken.startsWith('sk-') || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now() ||
      session.expiresAt > Date.now() + 86_400_000 || !Array.isArray(session.models) || session.models.length > 1024 ||
      !session.models.every(id => typeof id === 'string' && /^[\w.:/-]{1,200}$/u.test(id))) {
      throw modelUnavailable('Invalid ChatGPT authorization')
    }
    try {
      this.chatGptRuntime ??= localRuntime().catch(error => { this.chatGptRuntime = undefined; throw error })
      const runtime = await this.chatGptRuntime
      await runtime.setRuntimeApiKey('openai', session.accessToken)
      this.chatGptSession = { ...session, models: [...session.models] }
      const provider = `chatgpt-${session.profileId}`
      return runtime.getModels('openai').filter(model => this.isChatGptModel(provider, model.id, model.maxTokens) && model.input.includes('text'))
        .map(model => ({ route: { provider, model: model.id }, name: model.name }))
    } catch {
      throw modelUnavailable('Pi could not enable ChatGPT authorization')
    }
  }

  private isChatGptModel(provider: string, id: string, maxTokens: number): boolean {
    const session = this.chatGptSession
    return !!session && provider === `chatgpt-${session.profileId}` && session.expiresAt > Date.now() && session.models.includes(id) &&
      Number.isSafeInteger(maxTokens) && maxTokens > 0
  }

  private async chatGptModels(): Promise<ModelCandidate[]> {
    if (!this.chatGptRuntime || !this.chatGptSession) return []
    const runtime = await this.chatGptRuntime
    if (!this.chatGptSession) return []
    const provider = `chatgpt-${this.chatGptSession.profileId}`
    return runtime.getModels('openai').filter(model => this.isChatGptModel(provider, model.id, model.maxTokens) && model.input.includes('text'))
      .map(model => ({ route: { provider, model: model.id }, contextWindow: model.contextWindow,
        input: model.input, reasoning: model.reasoning }))
  }

  private async runtimeFor(route?: ModelRoute): Promise<ModelRuntime> {
    if (!route || !isChatGptProvider(route.provider)) return this.getRuntime()
    if (!this.chatGptRuntime || !this.chatGptSession || this.chatGptSession.expiresAt <= Date.now()) {
      throw modelUnavailable('Sign in with ChatGPT to use its model catalog')
    }
    return this.chatGptRuntime
  }

  async listProviderAccounts(): Promise<ManagedProvider[]> {
    const runtime = await this.getRuntime()
    return Promise.all(managedProviderIds.map(async provider => {
      const credential = this.credentials.get(provider) ??
        (await runtime.checkAuth(provider).catch(() => undefined) ? 'environment' : 'missing')
      return this.providerAccount(runtime, provider, credential, this.catalogs.get(provider))
    }))
  }

  private providerAccount(runtime: ModelRuntime, provider: ProviderId, credential: ManagedProvider['credential'],
    catalog?: ProviderCatalog): ManagedProvider {
    const candidates = credential === 'missing' || catalog?.connection === 'unauthorized' ? [] : runtime.getModels(provider)
    return {
      id: provider, name: providerName(provider), credential, connection: catalog?.connection ?? 'untested',
      models: candidates.filter(model => model.input.includes('text') && (!catalog?.ids || catalog.ids.has(model.id)))
        .map(model => ({ route: { provider, model: model.id }, name: model.name })),
    }
  }

  async validateProviderKey(provider: ProviderId, key: string, model?: string): Promise<ManagedProvider> {
    if (!isProviderId(provider) || !validProviderKey(key) || (provider === 'openai' && !key.startsWith('sk-'))) {
      throw modelUnavailable('Invalid provider credential')
    }
    const runtime = await this.getRuntime()
    const catalog = await this.probeProvider(runtime, provider, key, model)
    if (catalog.connection === 'connected') this.validatedKeys.set(provider, { fingerprint: fingerprint(key), catalog })
    return this.providerAccount(runtime, provider, 'stored', catalog)
  }

  async testProviderAccount(provider: ProviderId, model?: string): Promise<ManagedProvider> {
    if (!isProviderId(provider)) throw modelUnavailable('Unknown API provider')
    const runtime = await this.getRuntime()
    const revision = this.revisions.get(provider)
    const configured = this.credentials.get(provider)
    const auth = configured === 'missing' ? undefined : await runtime.getAuth(provider).catch(() => undefined)
    const key = auth?.auth.apiKey
    if (!validProviderKey(key)) return this.providerAccount(runtime, provider, configured ?? 'missing')
    const catalog = await this.probeProvider(runtime, provider, key, model)
    if (revision === this.revisions.get(provider)) this.catalogs.set(provider, catalog)
    return (await this.listProviderAccounts()).find(account => account.id === provider)!
  }

  async setProviderKey(provider: ProviderId, key: string | null | undefined): Promise<void> {
    if (!isProviderId(provider) || (key != null && (!validProviderKey(key) || (provider === 'openai' && !key.startsWith('sk-'))))) {
      throw modelUnavailable('Invalid provider credential')
    }
    const runtime = await this.getRuntime()
    this.revisions.set(provider, (this.revisions.get(provider) ?? 0) + 1)
    // Suppress ambient fallback before invalidating the SDK credential. An interrupted
    // removal cannot enable another key for subsequent model requests.
    if (key === null) this.credentials.set(provider, 'missing')
    try {
      if (typeof key === 'string') await runtime.setRuntimeApiKey(provider, key)
      else await runtime.removeRuntimeApiKey(provider)
    } catch {
      throw modelUnavailable('Pi could not update provider authentication')
    }
    if (typeof key === 'string') this.credentials.set(provider, 'stored')
    else if (key === undefined) this.credentials.delete(provider)
    const validated = this.validatedKeys.get(provider)
    this.validatedKeys.delete(provider)
    if (typeof key === 'string' && validated?.fingerprint === fingerprint(key)) this.catalogs.set(provider, validated.catalog)
    else this.catalogs.delete(provider)
  }

  private async probeProvider(runtime: ModelRuntime, provider: ProviderId, key: string, modelId?: string): Promise<ProviderCatalog> {
    const signal = AbortSignal.timeout(14_000)
    const catalog = await fetchProviderCatalog(provider, key, signal, this.request)
    if (!modelId || catalog.connection !== 'connected') return catalog
    const model = catalog.ids?.has(modelId) && runtime.getModel(provider, modelId)
    if (!model || !model.input.includes('text')) throw modelUnavailable('The selected model is absent from the authenticated catalog')
    try {
      const response = await runtime.completeSimple(model, {
        messages: [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }],
      }, { apiKey: key, signal, maxTokens: 64 })
      return response.stopReason === 'stop' ? catalog : { ...catalog, connection: 'unavailable' }
    } catch {
      return { ...catalog, connection: 'unavailable' }
    }
  }

  private providerAllows(provider: string, model: string): boolean {
    if (!isProviderId(provider)) return true
    const catalog = this.catalogs.get(provider)
    return this.credentials.get(provider) !== 'missing' && catalog?.connection !== 'unauthorized' &&
      (!catalog?.ids || catalog.ids.has(model))
  }

  private async resolveModel(runtime: ModelRuntime, route?: ModelRoute) {
    if (!route) throw modelUnavailable('Choose a Pi provider and model explicitly')
    if (isChatGptProvider(route.provider)) {
      const model = runtime.getModel('openai', route.model)
      if (!model || !this.isChatGptModel(route.provider, model.id, model.maxTokens)) throw modelUnavailable('Model is unavailable through ChatGPT')
      return model
    }
    // These built-ins use direct environment credentials. Bedrock and Vertex can
    // also discover file/profile credentials even with an empty credential store.
    if (this.environmentOnly && !isProviderId(route.provider)) {
      throw modelUnavailable('This Pi provider is not enabled for environment authentication')
    }
    const model = runtime.getModel(route.provider, route.model)
    if (!model) throw modelUnavailable('Unknown Pi model route')
    if (!this.providerAllows(route.provider, route.model)) throw modelUnavailable('Provider authorization or model is unavailable')
    const auth = await runtime.checkAuth(model.provider).catch(() => undefined)
    if (!auth) throw modelUnavailable('Pi model provider has no configured authentication')
    return model
  }

  async open(config: ExecutionConfig): Promise<ExecutionSession> {
    const cwd = await realpath(config.cwd)
    await mkdir(config.sessionDirectory, { recursive: true })
    const directory = await realpath(config.sessionDirectory)
    const modelRuntime = await this.runtimeFor(config.route)
    let model = config.route && await this.resolveModel(modelRuntime, config.route)
    if (!config.session && !model) throw modelUnavailable('Choose a Pi provider and model explicitly')

    const path = config.session?.path ?? join(directory, `${randomUUID()}.jsonl`)
    if (config.session) {
      if (relative(directory, dirname(await realpath(path))) !== '') throw new Error('Pi session is outside its storage directory')
      await checkTranscript(config.session, cwd)
    } else {
      // Opening an explicitly empty file lets Pi initialize its own header immediately.
      // SessionManager.create() otherwise delays the first write until conversation starts.
      await (await open(path, 'wx', 0o600)).close()
    }
    const manager = SessionManager.open(path, directory, cwd)
    const previousRoute = manager.getBranch().findLast(entry => entry.type === 'model_change')
    model ??= await this.resolveModel(modelRuntime, previousRoute && { provider: previousRoute.provider, model: previousRoute.modelId })
    const ref = { id: manager.getSessionId(), path }
    const traceId = config.correlationId ?? randomUUID()
    const chatGpt = !!config.route && isChatGptProvider(config.route.provider)
    const route = { provider: chatGpt ? config.route!.provider : model.provider, model: model.id }
    let stopping = false
    const pendingImages = new Map<string, ToolImage[]>()
    const vision = model.input.includes('image')
    const resources = await codingResources(config.systemPrompt, config.instructionScopes, config.skillReadsAllowed, config.selectSkills)
    const enabledTools = resources.skillTool ? [...config.tools, resources.skillTool] : config.tools
    const customTools = enabledTools.map(tool => asPiTool(tool, () => stopping, vision, pendingImages))
    const { session } = await createAgentSession({
      cwd,
      modelRuntime,
      model,
      thinkingLevel: config.reasoningEffort,
      sessionManager: manager,
      settingsManager: SettingsManager.inMemory({
        compaction: { keepRecentTokens: Math.min(12_000, Math.floor(model.contextWindow / 4)) },
        // Pi retries whole requests through the metered stream. Transport-level retries would be hidden from the budget.
        retry: { provider: { maxRetries: 0 } },
        cacheWarming: 'off',
        enableAnalytics: false,
      }),
      resourceLoader: resources.loader,
      tools: customTools.map(tool => tool.name),
      customTools,
    })

    let disposed = false
    let active: Promise<ExecutionResult> | undefined
    let stop: Promise<void> | undefined
    let lastAssistant: AssistantMessage | undefined
    let compacting = false
    let recoveringOutput = false
    let outputRecoveryUsed = false
    let lastRequestHadFrames = false
    const deepSeekThinking = model.provider === 'deepseek' && model.reasoning
    // Pi may omit an unsuccessful response from the projected context after overflow recovery.
    const previousEntry = config.resumeAfterOutputLimit
      ? manager.getBranch().findLast(entry => entry.type === 'message' && entry.message.role === 'assistant')
      : undefined
    const previousAssistant = previousEntry?.type === 'message' && previousEntry.message.role === 'assistant'
      ? previousEntry.message : undefined
    const resumeOutputRecovery = deepSeekThinking && config.resumeAfterOutputLimit &&
      previousAssistant?.provider === model.provider && previousAssistant.model === model.id &&
      isThinkingOnlyTruncation(previousAssistant)
    const canRecoverOutput = () => !stopping && !outputRecoveryUsed && config.canRecoverModelOutput?.() === true
    const providerMessages = new WeakSet<AssistantMessage>()
    const steering = new Map<string, string>()
    const emit = (event: RuntimeEvent): void => {
      try { config.onEvent(event) } catch { /* A subscriber cannot break the Pi loop. */ }
    }
    const reserve = (estimatedInputTokens: number, maxOutputTokens: number, kind: 'prompt' | 'compaction') => {
      if (stopping) throw new Error('Run is stopping')
      const allowedOutput = config.reserveRequest?.({ route, estimatedInputTokens, maxOutputTokens, kind, fixedMaxOutputTokens: chatGpt })
      emit({ type: 'model.request_started' })
      return allowedOutput ?? maxOutputTokens
    }
    const stream = session.agent.streamFunction
    const canUseProvider = (provider: string, id: string, maxTokens: number) => chatGpt
      ? this.isChatGptModel(route.provider, id, maxTokens) : this.providerAllows(provider, id)
    const chatGptFetch = chatGpt ? chatGptResponsesFetch(this.request) : undefined
    session.agent.streamFunction = async (model, context, options) => {
      options?.signal?.throwIfAborted()
      if (model.provider !== (chatGpt ? 'openai' : route.provider) || model.id !== route.model) {
        throw modelUnavailable('Provider route changed inside the session')
      }
      if (!canUseProvider(model.provider, model.id, model.maxTokens)) throw modelUnavailable('Provider authorization or model is unavailable')
      // Sign in with ChatGPT omits max_output_tokens. Reserve the documented model maximum.
      // DeepSeek counts reasoning and the answer or tool arguments against the same limit.
      const requestedOutput = chatGpt ? model.maxTokens : Math.min(options?.maxTokens ?? model.maxTokens, model.maxTokens)
      // Keep valid reasoning/tool pairs. An exhausted thinking-only turn has no result to replay.
      const textContext = deepSeekThinking
        ? { ...context, messages: context.messages.filter(message => message.role !== 'assistant' || !isThinkingOnlyTruncation(message)) }
        : context
      const attached = new Set<string>()
      let requestContext = textContext
      if (!compacting && pendingImages.size) {
        if (model.input.includes('image')) requestContext = { ...textContext, messages: textContext.messages.map(message => {
          if (message.role !== 'toolResult') return message
          const images = pendingImages.get(message.toolCallId)
          if (!images) return message
          attached.add(message.toolCallId)
          const content: ImageContent[] = images.map(({ bytes }) => ({ type: 'image', mimeType: 'image/jpeg', data: bytes.toString('base64') }))
          return { ...message, content: [...message.content, ...content] }
        }) }
        for (const id of pendingImages.keys()) if (!attached.has(id)) pendingImages.delete(id)
      }
      const frames = [...attached].reduce((sum, id) => sum + (pendingImages.get(id)?.length ?? 0), 0)
      const estimatedImageTokens = frames * previewImageLimits.estimatedTokens
      const textBytes = Buffer.byteLength(JSON.stringify(textContext))
      const estimatedText = Math.ceil(textBytes / 3) + 512
      const maxTokens = reserve(estimatedText + estimatedImageTokens, requestedOutput, compacting ? 'compaction' : 'prompt')
      lastRequestHadFrames = frames > 0
      if (frames) emit({ type: 'visual.frames_sent', frames, estimatedImageTokens })
      writeHostDiagnostic('host.model_started', traceId)
      const requestFailed = () => {
        emit({ type: 'model.request_unaccounted' })
        writeHostDiagnostic(options?.signal?.aborted ? 'host.model_interrupted' : 'host.model_failed', traceId)
      }
      try {
        const response = await stream(model, requestContext, { ...options, maxTokens,
          ...(deepSeekThinking && recoveringOutput ? { reasoning: undefined } : {}),
          ...(chatGpt ? { apiKey: this.chatGptSession?.accessToken, cacheRetention: 'none' as const,
            onPayload: chatGptResponsesPayload, fetch: chatGptFetch } : {}) })
        // Inspect only the completion category. Provider errors may contain request data.
        void response.result().then((message) => {
          providerMessages.add(message)
          const { input, output, cacheRead, cacheWrite, cost } = message.usage
          // Keep pixels through a Pi request retry. A completed request consumes its images.
          if (message.stopReason !== 'error') for (const id of attached) pendingImages.delete(id)
          if (input || output || cacheRead || cacheWrite || !['aborted', 'error'].includes(message.stopReason)) {
            const estimate = chatGpt ? undefined : cost?.total
            emit({ type: 'model.usage', input, output, cacheRead, cacheWrite,
              ...(estimate !== undefined && Number.isFinite(estimate) && estimate > 0 ? { estimatedCostUsd: estimate } : {}) })
          } else emit({ type: 'model.request_unaccounted' })
          writeHostDiagnostic(message.stopReason === 'aborted' ? 'host.model_interrupted'
            : message.stopReason === 'length' ? 'host.model_output_limit'
              : message.stopReason === 'error' ? 'host.model_failed' : 'host.model_completed', traceId)
        }, requestFailed)
        return response
      } catch (error) {
        requestFailed()
        throw error
      }
    }
    const unsubscribe = session.subscribe(event => {
      if (event.type === 'agent_start' && stopping) void session.abort().catch(() => {})
      if (event.type === 'compaction_start') compacting = true
      if (event.type === 'compaction_end') {
        compacting = false
        if (event.result) emit({ type: 'context.compacted', tokensBefore: event.result.tokensBefore,
          estimatedTokensAfter: event.result.estimatedTokensAfter })
      }
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        emit({ type: 'message.delta', delta: event.assistantMessageEvent.delta })
      }
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        lastAssistant = event.message
      }
      if (event.type === 'message_end' && event.message.role === 'user') {
        const content = event.message.content
        const text = typeof content === 'string' ? content : content.map((part) => part.type === 'text' ? part.text : '').join('')
        const instructionId = steering.get(text)
        if (instructionId) {
          steering.delete(text)
          emit({ type: 'instruction.applied', instructionId })
        }
      }
    })
    const checkpoint = async (): Promise<void> => {
      await active
      await session.waitForIdle()
      await syncTranscript(ref, cwd)
    }
    const requestStop = (): Promise<void> => {
      stopping = true
      stop ??= (async () => {
        await session.abort()
        await active
      })()
      return stop
    }
    try {
      const activeNames = session.getActiveToolNames()
      if (activeNames.length !== customTools.length || activeNames.some(name => !customTools.some(tool => tool.name === name))) {
        throw new Error('Pi tools differ from the explicit host allowlist')
      }
      const switched = previousRoute && (previousRoute.provider !== model.provider || previousRoute.modelId !== route.model)
      if (switched) await session.setModel(model)
      await checkpoint()
      if (switched) emit({ type: 'model.route_changed', route })
    } catch (error) {
      unsubscribe()
      session.dispose()
      throw error
    }
    return {
      ref, route, supportsVisualInput: vision,
      async run(prompt) {
        if (disposed || active) throw new Error('Pi session is unavailable for a new run')
        if (stopping) return { status: 'interrupted' }
        lastAssistant = undefined
        active = (async (): Promise<ExecutionResult> => {
          try {
            const contextTokens = session.messages.reduce((sum, message) => sum + estimateTokens(message), 0)
            if (session.messages.length > 6 && contextTokens > model.contextWindow * 0.7) {
              await session.compact('Keep task constraints, verified changes, and pending work with their references.')
            }
            if (stopping) return { status: 'interrupted' }
            if (resumeOutputRecovery && canRecoverOutput()) {
              outputRecoveryUsed = recoveringOutput = true
              emit({ type: 'model.output_recovery', trigger: 'resume' })
            }
            await session.prompt(prompt, { expandPromptTemplates: false })
            if (deepSeekThinking && isThinkingOnlyTruncation(lastAssistant) && canRecoverOutput()) {
              outputRecoveryUsed = recoveringOutput = true
              emit({ type: 'model.output_recovery', trigger: 'automatic' })
              lastAssistant = undefined
              await session.prompt(
                'Continue the current task from the recorded tool results. Avoid repeating confirmed operations. Take the next concrete step or give the concise final answer.' +
                (lastRequestHadFrames ? ' Earlier preview images are unavailable in this request. Use a fresh preview if needed and within budget, or report that visual verification is incomplete.' : ''),
                { expandPromptTemplates: false },
              )
            }
          } catch {
            return { status: stopping ? 'interrupted' : 'runtime_error' }
          } finally {
            recoveringOutput = false
            pendingImages.clear()
          }
          if (stopping) return { status: 'interrupted' }
          return runResult(lastAssistant, lastAssistant !== undefined && providerMessages.has(lastAssistant))
        })()
        try { return await active } finally { active = undefined }
      },
      async steer(text, instructionId) {
        if (!active || stopping || !session.isStreaming) throw new Error('Pi has no active run to steer')
        const input = instructionId ? 'Additional user instruction (' + instructionId + '): ' + text : text
        if (instructionId) steering.set(input, instructionId)
        try {
          if (await session.steer(input) !== 'queued') throw new Error('Pi did not queue the instruction')
        } catch (error) {
          steering.delete(input)
          throw error
        }
      },
      requestStop,
      checkpoint,
      async dispose() {
        if (disposed) return
        disposed = true
        try { if (active) await requestStop() } finally {
          unsubscribe()
          session.dispose()
        }
      },
    }
  }
}

function modelUnavailable(message: string): ModelUnavailableError {
  writeHostDiagnostic('host.model_unavailable')
  return new ModelUnavailableError(message)
}

function asPiTool(tool: ExecutionTool, stopping: () => boolean, vision: boolean, pending: Map<string, ToolImage[]>): ToolDefinition {
  if (!/^[a-zA-Z0-9_-]+$/.test(tool.name)) throw new Error('Invalid Pi tool name')
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    promptSnippet: tool.description,
    // The v1.5 tool validator accepts JSON Schema. The SDK declaration still uses TSchema.
    parameters: tool.parameters as ToolDefinition['parameters'],
    executionMode: 'sequential',
    async execute(id, args, signal) {
      if (stopping()) throw new Error('Run is stopping')
      signal?.throwIfAborted()
      let result = await tool.execute(id, args, signal)
      if (result && typeof result === 'object' && toolImages in result) {
        const { [toolImages]: images, ...metadata } = result
        const available = previewImageLimits.count - [...pending.values()].reduce((total, frames) => total + frames.length, 0)
        const accepted = vision && Array.isArray(images) ? (images as ToolImage[]).filter(validToolImage).slice(0, available) : []
        if (accepted.length) pending.set(id, accepted)
        result = { ...metadata, visualInput: !vision ? 'unavailable_on_selected_model' : accepted.length ? 'attached_for_next_request' : 'no_frames_available',
          attachedFrames: accepted.length }
      }
      const isError = Boolean(result && typeof result === 'object' && 'ok' in result && result.ok === false)
      return { content: [{ type: 'text', text: JSON.stringify(result) ?? 'null' }], details: undefined, isError }
    },
  }
}

function validToolImage(image: ToolImage): boolean {
  return Boolean(image) && Buffer.isBuffer(image.bytes) && image.bytes.length > 4 && image.bytes.length <= previewImageLimits.bytes &&
    image.bytes[0] === 0xff && image.bytes[1] === 0xd8 && image.bytes[2] === 0xff &&
    image.bytes.at(-2) === 0xff && image.bytes.at(-1) === 0xd9 && Number.isSafeInteger(image.width) && Number.isSafeInteger(image.height) &&
    image.width >= 1 && image.width <= previewImageLimits.width && image.height >= 1 && image.height <= previewImageLimits.height
}

function runResult(message: AssistantMessage | undefined, fromProvider: boolean): ExecutionResult {
  if (!message) return { status: 'runtime_error' }
  if (message.stopReason === 'aborted') return { status: 'interrupted' }
  if (message.stopReason === 'length' && fromProvider) return { status: 'model_output_limit' }
  if (message.stopReason !== 'stop') return { status: fromProvider ? 'model_error' : 'runtime_error' }
  return { status: 'completed', text: message.content.filter(part => part.type === 'text').map(part => part.text).join('\n') }
}

function isThinkingOnlyTruncation(message: AssistantMessage | undefined): boolean {
  return message?.stopReason === 'length' && message.content.length > 0 &&
    message.content.every(block => block.type === 'thinking')
}

async function checkTranscript(ref: SessionRef, cwd: string): Promise<void> {
  const transcript = await readFile(ref.path, 'utf8')
  // Pi can skip malformed JSONL lines for interactive use. Recovery must detect lost entries.
  if (!transcript.endsWith('\n')) throw new Error('Pi session transcript is incomplete')
  const lines = transcript.trimEnd().split('\n')
  const header = JSON.parse(lines[0])
  if (header?.type !== 'session' || header.id !== ref.id || header.version !== 3 || relative(cwd, header.cwd) !== '') {
    throw new Error('Pi session header does not match its checkpoint')
  }
  const seen = new Set<string>()
  for (const line of lines.slice(1)) {
    const entry = JSON.parse(line)
    if (!entry || typeof entry.type !== 'string' || typeof entry.id !== 'string' || seen.has(entry.id)
      || (entry.parentId !== null && !seen.has(entry.parentId))) {
      throw new Error('Pi session entries do not match their checkpoint')
    }
    seen.add(entry.id)
  }
}

async function syncTranscript(ref: SessionRef, cwd: string): Promise<void> {
  await checkTranscript(ref, cwd)
  const file = await open(ref.path, 'r+')
  try { await file.sync() } finally { await file.close() }
}
