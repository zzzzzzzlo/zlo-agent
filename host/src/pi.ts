import { randomUUID } from 'node:crypto'
import { writeHostDiagnostic } from '../../shared/diagnostics.ts'
import { mkdir, open, readFile, realpath } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { InMemoryCredentialStore, type AssistantMessage } from '@earendil-works/pi-ai'
import {
  createAgentSession,
  createExtensionRuntime,
  estimateTokens,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { ModelUnavailableError } from './execution.ts'
import type { AgentExecution, ExecutionConfig, ExecutionResult, ExecutionSession, ExecutionTool, ModelCandidate, ModelRoute, RuntimeEvent, SessionRef } from './execution.ts'

const environmentProviders = ['openai', 'anthropic', 'google', 'deepseek']

export class PiExecution implements AgentExecution {
  private runtime?: Promise<ModelRuntime>
  private readonly createRuntime: () => Promise<ModelRuntime>
  private readonly environmentOnly: boolean

  constructor(createRuntime?: () => Promise<ModelRuntime>) {
    this.environmentOnly = createRuntime === undefined
    this.createRuntime = createRuntime ?? (() => ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    }))
  }

  private async getRuntime(): Promise<ModelRuntime> {
    this.runtime ??= this.createRuntime().catch(() => {
      this.runtime = undefined
      throw modelUnavailable('Pi could not load its model and credential configuration')
    })
    return this.runtime
  }

  async validateRoute(route: ModelRoute): Promise<void> {
    await this.resolveModel(await this.getRuntime(), route)
  }

  async discoverModels(provider?: string): Promise<ModelCandidate[]> {
    const runtime = await this.getRuntime()
    const candidates = runtime.getModels(provider).filter(model =>
      (!this.environmentOnly || environmentProviders.includes(model.provider)) && model.input.includes('text'))
    const authorized = new Set((await Promise.all([...new Set(candidates.map(model => model.provider))].map(async id =>
      await runtime.checkAuth(id).catch(() => undefined) ? id : undefined))).filter(Boolean))
    return candidates.filter(model => authorized.has(model.provider)).map(model => ({
      route: { provider: model.provider, model: model.id }, contextWindow: model.contextWindow,
      input: model.input, reasoning: model.reasoning, estimatedCost: model.cost.input + model.cost.output,
    }))
  }

  private async resolveModel(runtime: ModelRuntime, route?: ModelRoute) {
    if (!route) throw modelUnavailable('Choose a Pi provider and model explicitly')
    // These built-ins use direct environment credentials. Bedrock and Vertex can
    // also discover file/profile credentials even with an empty credential store.
    if (this.environmentOnly && !environmentProviders.includes(route.provider)) {
      throw modelUnavailable('This Pi provider is not enabled for environment authentication')
    }
    const model = runtime.getModel(route.provider, route.model)
    if (!model) throw modelUnavailable('Unknown Pi model route')
    const auth = await runtime.checkAuth(model.provider).catch(() => undefined)
    if (!auth) throw modelUnavailable('Pi model provider has no configured authentication')
    return model
  }

  async open(config: ExecutionConfig): Promise<ExecutionSession> {
    const cwd = await realpath(config.cwd)
    await mkdir(config.sessionDirectory, { recursive: true })
    const directory = await realpath(config.sessionDirectory)
    const modelRuntime = await this.getRuntime()
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
    const route = { provider: model.provider, model: model.id }
    let stopping = false
    const customTools = config.tools.map(tool => asPiTool(tool, () => stopping))
    const { session } = await createAgentSession({
      cwd,
      modelRuntime,
      model,
      sessionManager: manager,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false, keepRecentTokens: Math.min(12_000, Math.floor(model.contextWindow / 4)) },
        retry: { enabled: false, provider: { maxRetries: 0 } },
        cacheWarming: 'off',
        enableAnalytics: false,
      }),
      resourceLoader: explicitResources(config.systemPrompt),
      tools: customTools.map(tool => tool.name),
      customTools,
    })

    let disposed = false
    let active: Promise<ExecutionResult> | undefined
    let stop: Promise<void> | undefined
    let lastAssistant: AssistantMessage | undefined
    let compacting = false
    const providerMessages = new WeakSet<AssistantMessage>()
    const steering = new Map<string, string>()
    const emit = (event: RuntimeEvent): void => {
      try { config.onEvent(event) } catch { /* A subscriber cannot break the Pi loop. */ }
    }
    const reserve = (estimatedInputTokens: number, maxOutputTokens: number, kind: 'prompt' | 'compaction') => {
      if (stopping) throw new Error('Run is stopping')
      config.reserveRequest?.({ route, estimatedInputTokens, maxOutputTokens, kind })
      emit({ type: 'model.request_started' })
    }
    const stream = session.agent.streamFunction
    session.agent.streamFunction = async (model, context, options) => {
      options?.signal?.throwIfAborted()
      if (model.provider !== route.provider || model.id !== route.model) throw modelUnavailable('Provider route changed inside the session')
      const maxTokens = Math.min(options?.maxTokens ?? model.maxTokens, 4096)
      reserve(Buffer.byteLength(JSON.stringify(context)), maxTokens, compacting ? 'compaction' : 'prompt')
      writeHostDiagnostic('host.model_started', traceId)
      const requestFailed = () => writeHostDiagnostic(options?.signal?.aborted ? 'host.model_interrupted' : 'host.model_failed', traceId)
      try {
        const response = await stream(model, context, { ...options, maxTokens })
        // Inspect only the completion category. Provider errors may contain request data.
        void response.result().then((message) => {
          providerMessages.add(message)
          const { input, output, cacheRead, cacheWrite, cost } = message.usage
          if (input || output || cacheRead || cacheWrite || !['aborted', 'error'].includes(message.stopReason)) {
            const estimate = cost?.total
            emit({ type: 'model.usage', input, output, cacheRead, cacheWrite,
              ...(Number.isFinite(estimate) && estimate > 0 ? { estimatedCostUsd: estimate } : {}) })
          }
          writeHostDiagnostic(message.stopReason === 'aborted' ? 'host.model_interrupted'
            : message.stopReason === 'error' || message.stopReason === 'length' ? 'host.model_failed' : 'host.model_completed', traceId)
        }, requestFailed)
        return response
      } catch (error) {
        requestFailed()
        throw error
      }
    }
    const unsubscribe = session.subscribe(event => {
      if (event.type === 'agent_start' && stopping) void session.abort().catch(() => {})
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
      const switched = previousRoute && (previousRoute.provider !== route.provider || previousRoute.modelId !== route.model)
      if (switched) await session.setModel(model)
      await checkpoint()
      if (switched) emit({ type: 'model.route_changed', route })
    } catch (error) {
      unsubscribe()
      session.dispose()
      throw error
    }
    return {
      ref, route,
      async run(prompt) {
        if (disposed || active) throw new Error('Pi session is unavailable for a new run')
        if (stopping) return { status: 'interrupted' }
        lastAssistant = undefined
        active = (async (): Promise<ExecutionResult> => {
          try {
            const contextTokens = session.messages.reduce((sum, message) => sum + estimateTokens(message), 0)
            if (session.messages.length > 6 && contextTokens > model.contextWindow * 0.7) {
              compacting = true
              try {
                const compacted = await session.compact('Keep task constraints, verified changes, and pending work with their references.')
                emit({ type: 'context.compacted', tokensBefore: compacted.tokensBefore, estimatedTokensAfter: compacted.estimatedTokensAfter })
              } finally {
                compacting = false
              }
            }
            if (stopping) return { status: 'interrupted' }
            await session.prompt(prompt, { expandPromptTemplates: false })
          } catch {
            return { status: stopping ? 'interrupted' : 'runtime_error' }
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

function explicitResources(systemPrompt: string): ResourceLoader {
  const runtime = createExtensionRuntime()
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources() {},
    async reload() {},
  }
}

function asPiTool(tool: ExecutionTool, stopping: () => boolean): ToolDefinition {
  if (!/^[a-zA-Z0-9_-]+$/.test(tool.name)) throw new Error('Invalid Pi tool name')
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    // The v1.5 tool validator accepts JSON Schema. The SDK declaration still uses TSchema.
    parameters: tool.parameters as ToolDefinition['parameters'],
    executionMode: 'sequential',
    async execute(id, args, signal) {
      if (stopping()) throw new Error('Run is stopping')
      signal?.throwIfAborted()
      const result = await tool.execute(id, args, signal)
      return { content: [{ type: 'text', text: JSON.stringify(result) ?? 'null' }], details: undefined }
    },
  }
}

function runResult(message: AssistantMessage | undefined, fromProvider: boolean): ExecutionResult {
  if (!message) return { status: 'runtime_error' }
  if (message.stopReason === 'aborted') return { status: 'interrupted' }
  if (message.stopReason !== 'stop') return { status: fromProvider ? 'model_error' : 'runtime_error' }
  return { status: 'completed', text: message.content.filter(part => part.type === 'text').map(part => part.text).join('\n') }
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
