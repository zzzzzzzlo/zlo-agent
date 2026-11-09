import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { InMemoryCredentialStore, type AssistantMessage } from '@earendil-works/pi-ai'
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { ModelUnavailableError } from './execution.ts'
import type { AgentExecution, ExecutionConfig, ExecutionResult, ExecutionSession, ExecutionTool, ModelRoute, RuntimeEvent, SessionRef } from './execution.ts'

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
      throw new ModelUnavailableError('Pi could not load its model and credential configuration')
    })
    return this.runtime
  }

  async validateRoute(route: ModelRoute): Promise<void> {
    await this.resolveModel(await this.getRuntime(), route)
  }

  private async resolveModel(runtime: ModelRuntime, route?: ModelRoute) {
    if (!route) throw new ModelUnavailableError('Choose a Pi provider and model explicitly')
    // These built-ins use direct environment credentials. Bedrock and Vertex can
    // also discover file/profile credentials even with an empty credential store.
    if (this.environmentOnly && !['openai', 'anthropic', 'google', 'deepseek'].includes(route.provider)) {
      throw new ModelUnavailableError('This Pi provider is not enabled for environment authentication')
    }
    const model = runtime.getModel(route.provider, route.model)
    if (!model) throw new ModelUnavailableError('Unknown Pi model route')
    const auth = await runtime.checkAuth(model.provider).catch(() => undefined)
    if (!auth) throw new ModelUnavailableError('Pi model provider has no configured authentication')
    return model
  }

  async open(config: ExecutionConfig): Promise<ExecutionSession> {
    const cwd = await realpath(config.cwd)
    await mkdir(config.sessionDirectory, { recursive: true })
    const directory = await realpath(config.sessionDirectory)
    const modelRuntime = await this.getRuntime()
    let model = config.route && await this.resolveModel(modelRuntime, config.route)
    if (!config.session && !model) throw new ModelUnavailableError('Choose a Pi provider and model explicitly')

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
    const route = { provider: model.provider, model: model.id }
    let stopping = false
    const customTools = config.tools.map(tool => asPiTool(tool, () => stopping))
    const { session } = await createAgentSession({
      cwd,
      modelRuntime,
      model,
      sessionManager: manager,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
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
    const providerMessages = new WeakSet<AssistantMessage>()
    const emit = (event: RuntimeEvent): void => {
      try { config.onEvent(event) } catch { /* A subscriber cannot break the Pi loop. */ }
    }
    const prepareRequest = session.agent.prepareRequest
    session.agent.prepareRequest = async (request, signal) => {
      signal?.throwIfAborted()
      const prepared = await prepareRequest?.(request, signal)
      signal?.throwIfAborted()
      if (!stopping) emit({ type: 'model.request_started' })
      if (stopping) throw new Error('Run is stopping')
      return prepared ?? undefined
    }
    const stream = session.agent.streamFunction
    session.agent.streamFunction = async (model, context, options) => {
      const response = await stream(model, context, options)
      // Pi may report a runtime exception as a synthetic assistant error. Track the
      // actual provider responses without subscribing to or consuming their events.
      void response.result().then(message => providerMessages.add(message), () => {})
      return response
    }
    const unsubscribe = session.subscribe(event => {
      if (event.type === 'agent_start' && stopping) void session.abort().catch(() => {})
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        emit({ type: 'message.delta', delta: event.assistantMessageEvent.delta })
      }
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        lastAssistant = event.message
        const { input, output, cacheRead, cacheWrite } = event.message.usage
        emit({ type: 'model.usage', input, output, cacheRead, cacheWrite })
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
            await session.prompt(prompt, { expandPromptTemplates: false })
          } catch {
            return { status: stopping ? 'interrupted' : 'runtime_error' }
          }
          if (stopping) return { status: 'interrupted' }
          return runResult(lastAssistant, lastAssistant !== undefined && providerMessages.has(lastAssistant))
        })()
        try { return await active } finally { active = undefined }
      },
      async steer(text) {
        if (!active || stopping || !session.isStreaming) throw new Error('Pi has no active run to steer')
        if (await session.steer(text) !== 'queued') throw new Error('Pi did not queue the instruction')
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
