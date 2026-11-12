import { createHash, randomUUID } from 'node:crypto'
import { writeHostDiagnostic } from '../../shared/diagnostics.ts'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import type { AgentExecution } from './execution.ts'
import { createArtifactTools } from './artifact-tools.ts'
import { createBrowserTools } from './browser-tools.ts'
import { createPreviewTools } from './preview-tools.ts'
import { createFileTools } from './file-tools.ts'
import { createGitTools, ManagedGitWorktrees } from './git-tools.ts'
import { createProcessTools } from './process-tools.ts'
import { BraveSearch, createWebTools, HackerNewsSearch, publicWeb } from './web-tools.ts'
import type { ToolApprovalCommand } from '../../shared/contracts/tool-approval.ts'
import type { ChatGptSession } from '../../shared/contracts/chatgpt.ts'
import type { AgentPreferences, ManagedMemory, ManagedModel, ManagedOperation, ManagedProvider, ManagementCommand, ManagementSnapshot, PrivateCredentialCommand, ProviderId } from '../../shared/contracts/management.ts'
import type { AgentEvent, EventDraft, ModelRoute, TaskStatus, VerificationCheck, WorkspaceAccess } from './contracts/domain.ts'
import type {
  ActionResult, ArchiveConversationInput, ConversationAction, ConversationEvent, ConversationHistory,
  ConversationSummary, CreateConversationInput, CursorInput, DesktopCommand, HistoryInput,
  RenameConversationInput, SendMessageInput, SendMessageResult, SetConversationModelInput, SteerInput,
} from '../../shared/contracts/desktop.ts'
import {
  ConversationError, ConversationService, parseConversationAction, parseCreateConversation, parseRoute, parseSendMessage, parseSetConversationModel, parseSteer,
} from './conversation.ts'
import { installTaskDiagnostics } from './diagnostics.ts'
import { LocalJudgment } from './judgment.ts'
import type { JudgmentOptions } from './judgment.ts'
import { LocalMemory, ScopedContext } from './memory.ts'
import * as management from './management.ts'
import { LocalModelScheduler } from './model-scheduler.ts'
import type { ModelLimits } from './model-scheduler.ts'
import { MultiAgentOrchestrator, executionFailure, memoryScope, sameRoute } from './orchestrator.ts'
import type { HarnessMode } from './orchestrator.ts'
import { accessRank, CodingCapabilities, ExtensionRegistry } from './policies.ts'
import { probeOperation } from './reconciliation.ts'
import type { CodingProfile } from './policies.ts'
import { LocalStore } from './store.ts'
import { isStopping, TaskEngine } from './task-engine.ts'
import type { CreateTask, NodeProposal, NodeReplan, TaskSnapshot } from './task-engine.ts'
import { ToolApprovalBroker } from './tool-approval.ts'
import type { ToolApprover } from './tool-approval.ts'
import { telemetryTask } from './telemetry-projection.ts'
import { verifyWorkspace } from './verification.ts'
import { CodingWorkspace } from './workspace.ts'

interface ProviderRuntime {
  listProviderAccounts(): Promise<ManagedProvider[]>
  testProviderAccount(provider: ProviderId, model?: string): Promise<ManagedProvider>
  validateProviderKey(provider: ProviderId, key: string): Promise<ManagedProvider>
  setProviderKey(provider: ProviderId, key: string | null | undefined): Promise<void>
  setChatGptSession(session: ChatGptSession | null): Promise<ManagedModel[]>
}

export type HostCommand =
  | ToolApprovalCommand
  | { schemaVersion: 1; type: 'createTask'; requestId: string; goal: string; cwd: string; check?: VerificationCheck; route?: ModelRoute; workspaceAccess?: WorkspaceAccess }
  | { schemaVersion: 1; type: 'getTask' | 'getHistory'; taskId: string }
  | { schemaVersion: 1; type: 'listTasks' | 'getRouteStatus' }
  | { schemaVersion: 1; type: 'discoverModels'; provider?: string }
  | { schemaVersion: 1; type: 'getModelBudget'; taskId: string }
  | { schemaVersion: 1; type: 'stop' | 'resume'; taskId: string; requestId: string }
  | { schemaVersion: 1; type: 'addInstruction'; taskId: string; requestId: string; text: string }
  | { schemaVersion: 1; type: 'addTask'; taskId: string; requestId: string; goal: string; expectedVersion: number; dependencies?: string[] }
  | { schemaVersion: 1; type: 'proposePlan'; taskId: string; requestId: string; expectedVersion: number; nodes: NodeProposal[] }
  | { schemaVersion: 1; type: 'replanNode'; taskId: string; requestId: string; expectedVersion: number; nodeId: string; update: NodeReplan }
  | { schemaVersion: 1; type: 'requestModelSwitch'; taskId: string; requestId: string; route: ModelRoute }

interface ActiveTask {
  taskId: string
  abort: AbortController
  done: Promise<void>
  stopTimer?: NodeJS.Timeout
}

interface HostOptions {
  directory: string
  execution: AgentExecution
  stopTimeoutMs?: number
  runtimeId?: string
  profile?: CodingProfile
  extensions?: ExtensionRegistry
  profileId?: string
  modelLimits?: Partial<ModelLimits>
  harnessMode?: HarnessMode
  judgment?: JudgmentOptions
  defaultWorkspace?: string
  defaultRoute?: ModelRoute
  approveTool?: ToolApprover
  providerRuntime?: ProviderRuntime
}

const recoverableAfterCrash = new Set<TaskStatus>(['running', 'verifying', 'stop_requested', 'stopping'])
const defaultStopTimeoutMs = 10000

function containsPath(parent: string, child: string): boolean {
  const diff = relative(parent, child)
  return diff === '' || (diff !== '..' && !diff.startsWith('..' + sep) && !isAbsolute(diff))
}

function desktopRequestId(id: string): string {
  return 'desktop:' + createHash('sha256').update(id).digest('hex')
}

export class LocalAgentHost {
  readonly #directory: string
  readonly #store: LocalStore
  readonly #engine: TaskEngine
  readonly #conversations: ConversationService
  readonly #orchestrator: MultiAgentOrchestrator
  readonly #scheduler: LocalModelScheduler
  readonly #stopTimeoutMs: number
  readonly #profile: Readonly<CodingProfile>
  readonly #extensions: ReturnType<ExtensionRegistry['resolve']>
  readonly #capabilities: CodingCapabilities
  readonly #memory: LocalMemory
  readonly #defaultWorkspace: string
  readonly #approval: ToolApprovalBroker
  readonly #providerRuntime?: ProviderRuntime
  #agentPreferences: AgentPreferences
  #credentialMutation = false
  #active?: ActiveTask
  #closing = false
  #closed = false
  #storageFailure?: Error

  constructor(options: HostOptions) {
    mkdirSync(options.directory, { recursive: true, mode: 0o700 })
    this.#directory = realpathSync(options.directory)
    this.#stopTimeoutMs = options.stopTimeoutMs ?? defaultStopTimeoutMs
    this.#providerRuntime = options.providerRuntime
    this.#agentPreferences = {
      workspaceAccess: 'write', defaultRoute: options.defaultRoute ?? null, modelSelection: 'automatic',
      disabledTools: [], searchProvider: process.env.ZLO_AGENT_BRAVE_SEARCH_API_KEY ? 'brave' : 'hacker_news',
    }
    const worktrees = new ManagedGitWorktrees(join(this.#directory, 'worktrees'))
    this.#extensions = (options.extensions ?? new ExtensionRegistry([
      { id: 'artifact', tools: workspace => createArtifactTools(workspace, this.#directory) },
      { id: 'files', tools: createFileTools },
      { id: 'git', tools: workspace => createGitTools(workspace, worktrees) },
      { id: 'shell', tools: createProcessTools },
      { id: 'web', tools: workspace => {
        const key = process.env.ZLO_AGENT_BRAVE_SEARCH_API_KEY
        return createWebTools(workspace, { provider: this.#agentPreferences.searchProvider === 'brave' && key
          ? new BraveSearch(key) : new HackerNewsSearch(publicWeb) })
      } },
      { id: 'browser', tools: workspace => createBrowserTools(workspace) },
      { id: 'preview', tools: workspace => createPreviewTools(workspace) },
    ])).resolve(options.profileId ?? 'coding')
    this.#profile = { ...(options.profile ?? this.#extensions.profile) }
    this.#capabilities = new CodingCapabilities(this.#profile, name => this.#toolEnabled(name))
    this.#defaultWorkspace = options.defaultWorkspace ?? this.#directory + '-workspace'
    this.#approval = new ToolApprovalBroker(options.approveTool)
    this.#store = new LocalStore(join(this.#directory, 'tasks.sqlite'))
    try {
      const saved = this.#store.get<AgentPreferences>('desktop-preferences', 'v1')
      if (saved) this.#agentPreferences = management.preferences(saved)
      if (options.runtimeId) {
        this.#store.transaction(() => {
          const bound = this.#store.get<{ runtimeId: string }>('host', 'runtime')
          if (bound && bound.runtimeId !== options.runtimeId) throw new Error('Host data directory belongs to a different runtime')
          if (!bound) this.#store.put('host', 'runtime', { schemaVersion: 1, runtimeId: options.runtimeId })
        })
      }
      this.#engine = new TaskEngine(this.#store)
      this.#conversations = new ConversationService(this.#store, () => this.#failStorage())
      installTaskDiagnostics(this.#store)
      const judgment = new LocalJudgment(this.#store, options.judgment)
      this.#memory = new LocalMemory(this.#store)
      this.#scheduler = new LocalModelScheduler(options.execution, this.#store, judgment, options.modelLimits,
        () => this.#agentPreferences.modelSelection === 'automatic')
      this.#orchestrator = new MultiAgentOrchestrator({
        store: this.#store, tasks: this.#engine, execution: options.execution, scheduler: this.#scheduler,
        capabilities: this.#capabilities, profile: this.#profile, extensions: this.#extensions, approval: this.#approval,
        resolveWorkspace: async (workspace, taskId, id, signal) => {
          const root = await worktrees.resolve(workspace, taskId, id, signal)
          return root ? new CodingWorkspace(root) : undefined
        },
        context: new ScopedContext(this.#memory, judgment), judgment, mode: options.harnessMode,
        sessions: join(this.#directory, 'sessions'),
        onOutput: (event, delta) => this.#conversations.recordDelta(event, delta),
        onCheckpoint: (taskId) => this.#conversations.checkpointOutput(taskId),
      })
      this.#recover()
    } catch (error) {
      this.#store.close()
      throw error
    }
    queueMicrotask(() => this.#dispatch())
  }

  #recover(): void {
    this.#orchestrator.recover()
    for (const task of this.#engine.list()) {
      if (!recoverableAfterCrash.has(task.status)) continue
      const session = this.#orchestrator.session(task.id)
      const reason = session && !existsSync(session.path) ? 'checkpoint_error' : 'process_interrupted'
      this.#engine.end(task.id, reason)
    }
  }

  #workspace(cwd: string): CodingWorkspace {
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('An absolute workspace path is required')
    const workspace = new CodingWorkspace(cwd)
    if (workspace.root === parse(workspace.root).root ||
      containsPath(workspace.root, this.#directory) || containsPath(this.#directory, workspace.root)) {
      throw new Error('Workspace and private Host data directory must be separate')
    }
    return workspace
  }

  #assertOpen(): void {
    if (this.#closed || this.#closing) throw new ConversationError('HOST_UNAVAILABLE', 'Host is closing')
    if (this.#storageFailure) throw this.#storageFailure
  }

  get #defaultRoute(): ModelRoute | undefined { return this.#agentPreferences.defaultRoute ?? undefined }

  #toolEnabled(name: string): boolean {
    const search = this.#agentPreferences.searchProvider
    return !this.#agentPreferences.disabledTools.includes(name) &&
      (name !== 'web_search' || (search !== 'disabled' && (search !== 'brave' || Boolean(process.env.ZLO_AGENT_BRAVE_SEARCH_API_KEY))))
  }

  getTask(taskId: string): TaskSnapshot {
    this.#assertOpen()
    return this.#engine.get(taskId)
  }

  getHistory(taskId: string) {
    this.#assertOpen()
    return {
      task: this.#engine.get(taskId), session: this.#orchestrator.session(taskId),
      attempts: this.#engine.attempts(taskId), operations: this.#engine.operations(taskId),
    }
  }

  events(taskId: string, after = 0, limit?: number): AgentEvent[] {
    this.getTask(taskId)
    return this.#store.events(taskId, after, limit)
  }

  telemetryHeads(before: string | null, limit: number) {
    this.#assertOpen()
    return this.#engine.listPage(before, limit).map(task => ({ id: task.id, cursor: this.#store.eventCursor(task.id) }))
  }

  telemetrySnapshot(taskId: string) {
    const task = this.getTask(taskId)
    return telemetryTask(task, this.#store.eventCursor(taskId), this.#engine.attempts(taskId))
  }

  subscribe(taskId: string, after: number, sink: (event: AgentEvent) => void | Promise<void>): () => void {
    this.getTask(taskId)
    return this.#store.subscribe(taskId, after, sink)
  }

  subscribeOutput(sink: Parameters<MultiAgentOrchestrator['subscribeOutput']>[0]): () => void {
    this.#assertOpen()
    return this.#orchestrator.subscribeOutput(sink)
  }

  subscribeToolApprovals(sink: Parameters<ToolApprovalBroker['subscribe']>[0]): () => void {
    this.#assertOpen()
    return this.#approval.subscribe(sink)
  }

  createConversation(input: CreateConversationInput): ConversationSummary {
    this.#assertOpen()
    const command = parseCreateConversation(input)
    const duplicate = this.#conversations.created(command)
    if (duplicate) return duplicate
    let workspace: CodingWorkspace
    try {
      if (!command.workspace) mkdirSync(this.#defaultWorkspace, { recursive: true, mode: 0o700 })
      workspace = this.#workspace(command.workspace ?? this.#defaultWorkspace)
    } catch {
      throw new ConversationError('INVALID_INPUT', 'Select an available local workspace separate from Host data')
    }
    return this.#conversations.create(command, workspace.root, this.#defaultRoute,
      this.#agentPreferences.workspaceAccess === 'trusted' ? 'read' : this.#agentPreferences.workspaceAccess)
  }

  listConversations(): ConversationSummary[] {
    this.#assertOpen()
    return this.#conversations.list()
  }

  getConversation(id: string): ConversationSummary {
    this.#assertOpen()
    return this.#conversations.get(id)
  }

  getConversationHistory(input: HistoryInput): ConversationHistory {
    this.#assertOpen()
    return this.#conversations.history(input)
  }

  subscribeConversation(input: CursorInput, sink: (event: ConversationEvent) => void | Promise<void>): () => void {
    this.#assertOpen()
    return this.#conversations.subscribe(input.conversationId, input.after, sink)
  }

  renameConversation(input: RenameConversationInput): ConversationSummary {
    this.#assertOpen()
    return this.#conversations.rename(input)
  }

  archiveConversation(input: ArchiveConversationInput): ConversationSummary {
    this.#assertOpen()
    return this.#conversations.archive(input)
  }

  #modelChangeSource(conversation: ConversationSummary, target: ModelRoute | null): ModelRoute | undefined {
    if (conversation.archived || conversation.latestStatus === 'needs_reconciliation' ||
      (conversation.latestStatus && isStopping(conversation.latestStatus))) {
      throw new ConversationError('CONFLICT', 'The conversation is not accepting a model change')
    }
    if (this.#orchestrator.isOpeningConversation(conversation.id)) {
      throw new ConversationError('CONFLICT', 'The Pi session is opening. Wait for it to finish before changing the model.')
    }
    const current = this.#orchestrator.conversationRoute(conversation.id) ?? conversation.route
    if (current && target && !this.#scheduler.canSwitch(current, target)) {
      throw new ConversationError('CONFLICT', 'Cross-provider context transfer is disabled')
    }
    return current
  }

  async setConversationModel(input: SetConversationModelInput): Promise<ConversationSummary> {
    this.#assertOpen()
    const command = parseSetConversationModel(input)
    const previous = this.#conversations.modelRequest(command)
    if (previous) return previous
    this.#modelChangeSource(this.#conversations.get(command.conversationId), command.route)
    if (command.route) {
      try {
        await this.#scheduler.validateRoute(command.route)
      } catch {
        throw new ConversationError('MODEL_UNAVAILABLE', 'The selected model route is unavailable')
      }
    }
    this.#assertOpen()
    const duplicate = this.#conversations.modelRequest(command)
    if (duplicate) return duplicate
    const conversation = this.#conversations.get(command.conversationId)
    const current = this.#modelChangeSource(conversation, command.route)
    const status = conversation.latestStatus
    const active = status === 'ready' || status === 'running' || status === 'verifying'
    const deferred = Boolean(conversation.piSessionId) || active
    const pending = deferred && command.route && (!current || !sameRoute(current, command.route)) ? command.route : undefined
    const selected = deferred ? current : command.route ?? current
    const commit = () => this.#conversations.recordModelRequest(command, selected, pending)
    if (conversation.latestTaskId && (active || status === 'blocked' || status === 'stopped')) {
      let result: ConversationSummary | undefined
      this.#engine.switchRoute(conversation.latestTaskId, desktopRequestId(command.requestId), pending ?? selected, () => {
        result = commit()
      })
      if (!result) throw new Error('Conversation model request receipt is missing')
      return result
    }
    return this.#store.transaction(commit)
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    this.#assertOpen()
    const command = parseSendMessage(input)
    const duplicate = this.#conversations.sent(command)
    if (duplicate) return duplicate
    const conversation = this.#conversations.canSend(command.conversationId)
    try {
      const workspace = this.#workspace(conversation.workspace)
      if (relative(workspace.root, conversation.workspace) !== '') throw new Error('Workspace changed')
    } catch {
      throw new ConversationError('INVALID_INPUT', 'The conversation workspace is unavailable')
    }
    const requestedRoute = conversation.pendingRoute ?? conversation.route ?? this.#defaultRoute
    let route = requestedRoute
    if (!route && this.#providerRuntime) {
      const available = await this.#scheduler.discoverModels()
      // Keep ambient and stored API models eligible. ChatGPT account routes must be selected explicitly.
      route = available.find(model => management.providers.some(provider => provider === model.route.provider))?.route
      if (!route) throw new ConversationError('MODEL_UNAVAILABLE', 'Configure a model provider or select an authorized model')
    }
    if (route) {
      try {
        await this.#scheduler.validateRoute(route)
      } catch {
        throw new ConversationError('MODEL_UNAVAILABLE', 'The selected model route is unavailable')
      }
    }
    this.#assertOpen()
    const alreadySent = this.#conversations.sent(command)
    if (alreadySent) return alreadySent
    const current = this.#conversations.canSend(command.conversationId)
    const currentRoute = current.pendingRoute ?? current.route ?? this.#defaultRoute
    if ((requestedRoute === undefined) !== (currentRoute === undefined) ||
      (requestedRoute && currentRoute && !sameRoute(requestedRoute, currentRoute))) {
      throw new ConversationError('CONFLICT', 'The model route changed while the message was prepared; retry the request')
    }
    this.#engine.create({
      requestId: desktopRequestId(command.requestId), conversationId: current.id, goal: command.text,
      cwd: current.workspace, check: current.check, workspaceAccess: current.workspaceAccess,
      route,
    }, (task) => this.#conversations.attachTask(command, task))
    const sent = this.#conversations.sent(command)
    if (!sent) throw new Error('Conversation task receipt is missing')
    this.#dispatch()
    return sent
  }

  async steerConversation(input: SteerInput): Promise<{ accepted: true }> {
    this.#assertOpen()
    const command = parseSteer(input)
    this.#conversations.assertTaskOwner(command)
    const id = desktopRequestId(command.requestId)
    const previous = this.#engine.recorded<{ accepted: true }>(id, ['instruction', command.taskId, command.text])
    if (previous) return previous
    const conversation = this.#conversations.assertCurrentTask(command)
    if (conversation.latestStatus !== 'ready' && conversation.latestStatus !== 'running' && conversation.latestStatus !== 'verifying') {
      throw new ConversationError('CONFLICT', 'Conversation has no task accepting instructions')
    }
    const result = this.#engine.addInstruction(command.taskId, id, command.text, () => this.#conversations.attachInstruction(command))
    await this.#orchestrator.steer(command.taskId, id, command.text)
    return result
  }

  stopConversation(input: ConversationAction): ActionResult {
    this.#assertOpen()
    const command = parseConversationAction(input)
    this.#conversations.assertTaskOwner(command)
    const id = desktopRequestId(command.requestId)
    const previous = this.#engine.recorded<ActionResult>(id, ['stop', command.taskId, 'user'])
    if (previous) return previous
    this.#conversations.assertCurrentTask(command)
    return this.#stop(command.taskId, id)
  }

  resumeConversation(input: ConversationAction): ActionResult {
    this.#assertOpen()
    const command = parseConversationAction(input)
    this.#conversations.assertTaskOwner(command)
    const id = desktopRequestId(command.requestId)
    const previous = this.#engine.recorded<ActionResult>(id, ['resume', command.taskId])
    if (previous) return previous
    this.#conversations.assertCurrentTask(command)
    return this.#resume(command.taskId, id)
  }

  async createTask(input: Omit<CreateTask, 'conversationId'>): Promise<{ taskId: string }> {
    this.#assertOpen()
    const { requestId, goal, cwd, check, route, workspaceAccess } = input
    const command = { requestId, goal, cwd, check, route, workspaceAccess }
    const existing = this.#engine.recorded<{ taskId: string }>(command.requestId, ['create', command])
    if (existing) return existing
    const workspace = this.#workspace(command.cwd)
    if (command.route) await this.#scheduler.validateRoute(command.route)
    this.#assertOpen()
    // Preserve the submitted path in the idempotency signature while binding the workspace to its canonical target.
    if (relative(workspace.root, resolve(command.cwd)) !== '') throw new Error('Submit the canonical workspace path')
    const result = this.#engine.create(command)
    this.#dispatch()
    return result
  }

  stop(taskId: string, requestId: string): { accepted: boolean; status: TaskStatus } {
    this.#assertOpen()
    this.#assertStandaloneTask(taskId)
    return this.#stop(taskId, requestId)
  }

  #stop(taskId: string, requestId: string): ActionResult {
    const result = this.#engine.requestStop(taskId, requestId)
    this.#settleStop(taskId)
    return result
  }

  #settleStop(taskId: string): void {
    const task = this.#engine.get(taskId)
    if (!isStopping(task.status)) return
    this.#engine.beginStopping(taskId)
    const active = this.#active
    if (!active || active.taskId !== taskId) {
      this.#engine.end(taskId, 'user_stop')
      return
    }
    if (active.abort.signal.aborted) return
    active.abort.abort()
    active.stopTimer = setTimeout(() => {
      try {
        if (isStopping(this.#engine.get(taskId).status)) this.#engine.end(taskId, 'stop_timeout')
      } catch {
        this.#failStorage()
      }
    }, this.#stopTimeoutMs)
  }

  resume(taskId: string, requestId: string) {
    this.#assertOpen()
    this.#assertStandaloneTask(taskId)
    return this.#resume(taskId, requestId)
  }

  #resume(taskId: string, requestId: string): ActionResult {
    const session = this.#orchestrator.session(taskId)
    const result = this.#engine.resume(taskId, requestId, !session || existsSync(session.path))
    this.#dispatch()
    return result
  }

  addInstruction(taskId: string, requestId: string, text: string) {
    this.#assertOpen()
    this.#assertStandaloneTask(taskId)
    return this.#engine.addInstruction(taskId, requestId, text)
  }

  addTask(taskId: string, requestId: string, goal: string, expectedVersion: number, dependencies?: string[]) {
    this.#assertOpen()
    this.#assertStandaloneTask(taskId)
    if (!this.#profile.delegation) throw new Error('The Coding profile disables delegation')
    return this.#engine.addTask(taskId, requestId, goal, expectedVersion, dependencies)
  }

  async requestModelSwitch(taskId: string, requestId: string, route: ModelRoute) {
    this.#assertOpen()
    this.#assertStandaloneTask(taskId)
    const existing = this.#engine.recorded<{ accepted: true }>(requestId, ['switch', taskId, route])
    if (existing) return existing
    const task = this.#engine.get(taskId)
    const current = this.#orchestrator.rootRoute(taskId) ?? task.route
    if (!current && task.status === 'running') throw new Error('Initial model route is still being selected')
    if (current && !this.#scheduler.canSwitch(current, route)) throw new Error('Cross-provider context transfer is disabled')
    await this.#scheduler.validateRoute(route)
    this.#assertOpen()
    const latest = this.#orchestrator.rootRoute(taskId) ?? this.#engine.get(taskId).route
    if (latest && !this.#scheduler.canSwitch(latest, route)) throw new Error('Cross-provider context transfer is disabled')
    return this.#engine.switchRoute(taskId, requestId, route)
  }

  #assertStandaloneTask(taskId: string): void {
    if (this.#engine.get(taskId).conversationId) {
      throw new ConversationError('CONFLICT', 'Use Conversation commands for a Conversation task')
    }
  }

  async managementSnapshot(conversationId?: string): Promise<Omit<ManagementSnapshot, 'version' | 'diagnostics'>> {
    this.#assertOpen()
    const conversation = conversationId === undefined ? undefined : this.#conversations.get(management.id(conversationId))
    const rootAccess = conversation ? this.#conversationAccess(conversation) : this.#agentPreferences.workspaceAccess
    const tasks = conversation ? this.#conversations.recentTaskIds(conversation.id, 20).map(id => this.#engine.get(id)) : []
    const memory: ManagedMemory | undefined = conversation ? { entries: [], recalls: [] } : undefined
    if (conversation && memory) {
      const providers = new Set<string>([...management.providers, 'chatgpt'])
      if (conversation.route) providers.add(conversation.route.provider)
      for (const provider of providers) {
        for (const { id, kind, text, version, updatedAt } of this.#memory.list(management.conversationScope(conversation, provider))) {
          memory.entries.push({ id, kind, text, version, updatedAt })
        }
      }
      memory.entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    }
    const views = tasks.map(task => {
      const events = this.#store.eventsOfTypes(task.id, management.managementEventTypes)
      for (const event of events) {
        if (memory && event.type === 'memory.recalled' && typeof event.payload.count === 'number') {
          memory.recalls.push({ taskId: task.id, timestamp: Date.parse(event.occurredAt), count: event.payload.count })
        }
      }
      return management.taskView(task, events, this.#engine.operations(task.id),
        this.#capabilities.root(task.workspaceAccess, Boolean(task.check)).access,
        { tokenLimit: this.#scheduler.tokenLimit, ...this.#scheduler.budget(task.id) })
    })
    if (memory) memory.recalls = memory.recalls.sort((a, b) => b.timestamp - a.timestamp).slice(0, 100)
    // Catalog generation is static. Use the private workspace only as a descriptor if a project was removed.
    mkdirSync(this.#defaultWorkspace, { recursive: true, mode: 0o700 })
    let workspace: CodingWorkspace
    try { workspace = this.#workspace(conversation?.workspace ?? this.#defaultWorkspace) }
    catch { workspace = this.#workspace(this.#defaultWorkspace) }
    const tools = management.toolCatalog(this.#extensions, this.#capabilities, workspace, rootAccess, name => this.#toolEnabled(name))
    return {
      conversation, tools, tasks: views, memory, preferences: this.#agentPreferences,
      braveConfigured: Boolean(process.env.ZLO_AGENT_BRAVE_SEARCH_API_KEY),
      providers: await this.#providerRuntime?.listProviderAccounts() ?? [],
      account: { available: false, reason: '此构建未配置独立的 ChatGPT 账号授权。OpenAI API Key 使用 API 额度。' },
    }
  }

  async saveAgentPreferences(value: unknown): Promise<AgentPreferences> {
    const next = management.preferences(value)
    if (next.searchProvider === 'brave' && !process.env.ZLO_AGENT_BRAVE_SEARCH_API_KEY) {
      throw new ConversationError('INVALID_INPUT', 'Brave Search requires a local configuration key')
    }
    if (next.defaultRoute && (!this.#agentPreferences.defaultRoute || !sameRoute(next.defaultRoute, this.#agentPreferences.defaultRoute))) {
      await this.#scheduler.validateRoute(next.defaultRoute).catch(() => {
        throw new ConversationError('MODEL_UNAVAILABLE', 'The default model is unavailable')
      })
    }
    if (next.searchProvider !== this.#agentPreferences.searchProvider && this.#active) {
      throw new ConversationError('CONFLICT', 'Stop the current run before changing its search provider')
    }
    this.#assertOpen()
    const newlyDisabled = next.disabledTools.some(name => !this.#agentPreferences.disabledTools.includes(name))
    this.#store.transaction(() => this.#store.put('desktop-preferences', 'v1', next))
    this.#agentPreferences = next
    if (newlyDisabled && this.#active) this.#stop(this.#active.taskId, 'tool-policy:' + randomUUID())
    return next
  }

  #conversationAccess(conversation: ConversationSummary): WorkspaceAccess {
    return conversation.workspaceAccess ?? this.#capabilities.root(undefined, Boolean(conversation.check)).access
  }

  setConversationWorkspaceAccess(conversationId: string, requested: WorkspaceAccess, expected: WorkspaceAccess): ConversationSummary {
    const conversation = this.#conversations.get(management.id(conversationId))
    const access = management.access(requested)
    const current = this.#conversationAccess(conversation)
    if (conversation.archived || current !== management.access(expected)) throw new ConversationError('CONFLICT', 'Conversation permission changed')
    if (current === access) return conversation
    const task = conversation.latestTaskId ? this.#engine.get(conversation.latestTaskId) : undefined
    const active = Boolean(task && ['ready', 'running', 'verifying', 'stop_requested', 'stopping'].includes(task.status))
    if (accessRank[access] > accessRank[current] && active) {
      throw new ConversationError('CONFLICT', 'Stop the current run before increasing workspace access')
    }
    if (accessRank[access] > accessRank[current]) {
      try { this.#workspace(conversation.workspace) }
      catch { throw new ConversationError('INVALID_INPUT', 'The workspace is unavailable') }
    }
    const update = () => this.#conversations.setWorkspaceAccess(conversation.id, access)
    if (!task || task.status === 'succeeded' || task.status === 'failed') return this.#store.transaction(update)
    this.#engine.setWorkspaceAccess(task.id, access, active ? 'permission:' + randomUUID() : undefined, update)
    if (active) this.#settleStop(task.id)
    return this.#conversations.get(conversation.id)
  }

  #removeMemory(conversationId: string, ids: unknown): number {
    const conversation = this.#conversations.get(management.id(conversationId))
    const selected = management.memoryIds(ids)
    const providers = new Set<string>([...management.providers, 'chatgpt'])
    if (conversation.route) providers.add(conversation.route.provider)
    return [...providers].reduce((count, provider) => count +
      this.#memory.remove(management.conversationScope(conversation, provider), selected), 0)
  }

  async #reconcile(command: Extract<ManagementCommand, { type: 'reconcileOperation' }>): Promise<ManagedOperation> {
    const conversationId = management.id(command.conversationId)
    const taskId = management.id(command.taskId)
    const id = management.operationId(command.operationId)
    this.#conversations.assertTaskOwner({ conversationId, taskId, requestId: 'reconciliation' })
    const task = this.#engine.get(taskId)
    const operation = this.#engine.operations(taskId).find(item => item.id === id)
    if (!operation) throw new ConversationError('NOT_FOUND', 'Unknown operation')
    if (operation.reconciliation?.status === 'verified') return management.managedOperation(operation)
    if (this.#active || task.status !== 'needs_reconciliation' || operation.status !== 'unknown_effect') {
      throw new ConversationError('CONFLICT', 'Operation is not ready to be checked')
    }
    let workspace: CodingWorkspace
    try { workspace = this.#workspace(task.cwd) }
    catch { throw new ConversationError('INVALID_INPUT', 'The workspace is unavailable') }
    const observation = await probeOperation(workspace, operation)
    this.#assertOpen()
    if (this.#active) throw new ConversationError('CONFLICT', 'Retry after the active run has stopped')
    return management.managedOperation(this.#engine.recordReconciliation(taskId, id, observation))
  }

  #requireProviderRuntime(): ProviderRuntime {
    if (!this.#providerRuntime) throw new ConversationError('MODEL_UNAVAILABLE', 'Provider configuration requires the Pi runtime')
    return this.#providerRuntime
  }

  async applyProviderChange<T>(matches: (provider: string) => boolean, change: () => Promise<T>): Promise<T> {
    if (this.#credentialMutation) throw new ConversationError('CONFLICT', 'Another credential change is in progress')
    this.#credentialMutation = true
    try {
      const active = this.#active
      for (const task of this.#engine.list()) {
        if (task.id !== active?.taskId && task.status !== 'ready') continue
        const route = this.#orchestrator.rootRoute(task.id) ?? task.route
        if (!route || matches(route.provider) || (task.route && matches(task.route.provider))) {
          this.#stop(task.id, 'credential:' + randomUUID())
        }
      }
      if (active?.abort.signal.aborted) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([active.done, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new ConversationError('CONFLICT', 'The interrupted run is still stopping')), this.#stopTimeoutMs + 100)
          })])
        } finally { clearTimeout(timer) }
      }
      this.#assertOpen()
      return await change()
    } finally {
      this.#credentialMutation = false
      this.#dispatch()
    }
  }

  async managementCommand(command: ManagementCommand | PrivateCredentialCommand): Promise<unknown> {
    this.#assertOpen()
    switch (command.type) {
      case 'managementSnapshot': return this.managementSnapshot(command.conversationId)
      case 'conversationObservatory': {
        const { latestTaskId, ...activity } = this.#conversations.activity(management.id(command.conversationId))
        return { ...activity, latestTask: latestTaskId ? { id: latestTaskId, tokenLimit: this.#scheduler.tokenLimit,
          ...this.#scheduler.budget(latestTaskId) } : undefined }
      }
      case 'saveAgentPreferences': return this.saveAgentPreferences(command.preferences)
      case 'setWorkspaceAccess': return this.setConversationWorkspaceAccess(command.conversationId, command.access, command.expected)
      case 'deleteConversationMemory': return this.#removeMemory(command.conversationId, command.ids)
      case 'reconcileOperation': return this.#reconcile(command)
      case 'testProviderAccount': {
        const provider = management.providerId(command.provider)
        const model = command.model === undefined ? undefined : parseRoute({ provider, model: command.model }).model
        const runtime = this.#requireProviderRuntime()
        const result = await runtime.testProviderAccount(provider, model)
        if (result.connection === 'unauthorized') await this.applyProviderChange(value => value === provider, async () => {})
        return result
      }
      case 'validateProviderKey':
        return this.#requireProviderRuntime().validateProviderKey(management.providerId(command.provider), command.key)
      case 'applyProviderKey': {
        const provider = management.providerId(command.provider)
        const runtime = this.#requireProviderRuntime()
        await this.applyProviderChange(value => value === provider, () => runtime.setProviderKey(provider, command.key))
        return (await runtime.listProviderAccounts()).find(account => account.id === provider)
      }
      case 'applyChatGptSession': {
        if (typeof command.quiesce !== 'boolean') throw new ConversationError('INVALID_INPUT', 'Invalid account update')
        const change = () => this.#requireProviderRuntime().setChatGptSession(command.session)
        return command.quiesce ? this.applyProviderChange(provider => provider.startsWith('chatgpt-'), change) : change()
      }
      case 'initializeProviderKeys':
        throw new ConversationError('INVALID_INPUT', 'Credentials are initialized before the desktop Host starts')
    }
  }

  async command(command: HostCommand | DesktopCommand): Promise<unknown> {
    this.#assertOpen()
    if (command?.schemaVersion !== 1) throw new Error('Unsupported command version')
    switch (command.type) {
      case 'resolveToolApproval': return this.#approval.resolve(command.approvalId, command.decision)
      case 'createTask': {
        const { requestId, goal, cwd, check, route, workspaceAccess } = command
        return this.createTask({ requestId, goal, cwd, check, route, workspaceAccess })
      }
      case 'getTask': return this.getTask(command.taskId)
      case 'getHistory': return this.getHistory(command.taskId)
      case 'listTasks': return this.#engine.list()
      case 'getRouteStatus': return this.#scheduler.getRouteStatus()
      case 'discoverModels': return this.#scheduler.discoverModels(command.provider)
      case 'getModelBudget':
        this.getTask(command.taskId)
        return this.#scheduler.budget(command.taskId)
      case 'stop': return this.stop(command.taskId, command.requestId)
      case 'resume': return this.resume(command.taskId, command.requestId)
      case 'addInstruction': return this.addInstruction(command.taskId, command.requestId, command.text)
      case 'addTask': return this.addTask(command.taskId, command.requestId, command.goal, command.expectedVersion, command.dependencies)
      case 'proposePlan':
      case 'replanNode':
        this.#assertStandaloneTask(command.taskId)
        if (!this.#profile.delegation) throw new Error('The profile disables delegation')
        return command.type === 'proposePlan'
          ? this.#engine.proposePlan(command.taskId, command.requestId, command.expectedVersion, command.nodes)
          : this.#engine.replanNode(command.taskId, command.requestId, command.expectedVersion, command.nodeId, command.update)
      case 'requestModelSwitch': return this.requestModelSwitch(command.taskId, command.requestId, command.route)
      case 'createConversation': return this.createConversation(command)
      case 'listConversations': return this.listConversations()
      case 'getConversation': return this.getConversation(command.conversationId)
      case 'getConversationHistory': return this.getConversationHistory(command)
      case 'sendMessage': return this.sendMessage(command)
      case 'steerConversation': return this.steerConversation(command)
      case 'stopConversation': return this.stopConversation(command)
      case 'resumeConversation': return this.resumeConversation(command)
      case 'setConversationModel': return this.setConversationModel(command)
      case 'renameConversation': return this.renameConversation(command)
      case 'archiveConversation': return this.archiveConversation(command)
      default: throw new Error('Unknown command')
    }
  }

  #failStorage(): void {
    if (!this.#storageFailure) writeHostDiagnostic('host.runtime_failed', this.#active?.taskId)
    this.#storageFailure = new Error('Host persistence failed. Inspect the data directory before continuing.')
    this.#active?.abort.abort()
  }

  #dispatch(): void {
    if (this.#closing || this.#active || this.#storageFailure || this.#credentialMutation) return
    try {
      const ready = this.#engine.list().find((task) => task.status === 'ready')
      if (!ready) return
      const task = this.#engine.start(ready.id)
      const active: ActiveTask = { taskId: task.id, abort: new AbortController(), done: Promise.resolve() }
      this.#active = active
      active.done = this.#run(task, active.abort.signal).catch(() => this.#failStorage()).finally(() => {
        clearTimeout(active.stopTimer)
        this.#active = undefined
        this.#dispatch()
      })
    } catch {
      this.#failStorage()
    }
  }

  async #run(task: TaskSnapshot, signal: AbortSignal): Promise<void> {
    let workspace: CodingWorkspace
    try {
      workspace = this.#workspace(task.cwd)
      if (relative(workspace.root, resolve(task.cwd)) !== '') throw new Error('Workspace changed')
    } catch {
      this.#engine.end(task.id, 'runtime_error')
      return
    }
    for (let boundary = 0; boundary < 4; boundary++) {
      const result = await this.#orchestrator.run(this.#engine.get(task.id), workspace, signal)
      if (result.status !== 'completed') {
        this.#engine.end(task.id, executionFailure(result.status))
        return
      }
      if (signal.aborted || this.#engine.operations(task.id).some((item) => item.status === 'unknown_effect' || item.status === 'started')) {
        this.#engine.end(task.id, 'model_interrupted')
        return
      }
      this.#engine.beginVerification(task.id)
      const snapshot = this.#engine.get(task.id)
      const operations = this.#engine.operations(task.id)
      const confirmedOperation = operations.some(item => item.status === 'succeeded')
      const access = this.#capabilities.root(snapshot.workspaceAccess, Boolean(snapshot.check)).access
      const verification = snapshot.worker?.status === 'failed'
        ? { passed: false, evidence: 'worker_verification_failed' }
        : snapshot.nodes?.some(node => node.status !== 'succeeded')
          ? { passed: false, evidence: 'dag_not_converged' }
        : snapshot.check?.command && !this.#capabilities.enabled('run_project_command')
          ? { passed: false, evidence: 'project_command_disabled' }
        : snapshot.check
          ? await verifyWorkspace(this.#engine, this.#extensions.workflow, workspace, result.event, snapshot.check, signal, access, 'verification')
          : {
            passed: false, verdict: result.textProduced || confirmedOperation ? 'unverified' as const : 'failed' as const,
            evidence: operations.some(item => item.effect === 'write' && item.status === 'succeeded') ? 'confirmed_workspace_operation'
              : result.textProduced ? 'assistant_response_present' : confirmedOperation ? 'confirmed_tool_operation'
                : operations.some(item => item.status === 'failed') ? 'tool_execution_failed' : 'assistant_response_missing',
          }
      if (signal.aborted || this.#engine.operations(task.id).some(item => item.status === 'unknown_effect' || item.status === 'started')) {
        this.#engine.end(task.id, 'model_interrupted')
        return
      }
      const latest = this.#engine.get(task.id)
      if (latest.instructions.some((item) => !item.delivered) || latest.worker?.status === 'ready' ||
        latest.planVersion !== snapshot.planVersion ||
        (!latest.conversationId && latest.route && !sameRoute(latest.route, result.route))) {
        this.#engine.continueExecution(task.id)
        continue
      }
      const settled = this.#engine.verify(task.id, verification)
      if (settled.status === 'succeeded') this.#captureMemory(settled, result.route, result.event)
      return
    }
    this.#engine.end(task.id, 'budget_exhausted')
  }

  #captureMemory(task: TaskSnapshot, route: ModelRoute, event: EventDraft): void {
    const writes = this.#engine.operations(task.id).filter(item => item.effect === 'write' && item.status === 'succeeded')
    const entries = writes.filter(item => item.target).slice(-12).map(item => ({
      kind: 'fact' as const,
      text: 'Confirmed workspace operation ' + item.tool + ' on ' + item.target,
      sourceRefs: [item.id],
    }))
    const scope = memoryScope(task, route)
    this.#memory.capture(event, scope, entries)
    if (task.check && task.verification?.passed) this.#memory.capture(event, scope, [{
      kind: 'experience',
      text: task.check.command ? 'Project verification passed using ' + task.check.command.command
        : 'A workspace check passed for ' + task.check.path,
      sourceRefs: [task.id],
    }])
  }

  async idle(): Promise<void> {
    while (this.#active) await this.#active.done
    if (this.#storageFailure) throw this.#storageFailure
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closing = true
    if (this.#active) {
      const active = this.#active
      if (!this.#storageFailure) {
        this.#engine.requestStop(active.taskId, 'shutdown:' + randomUUID(), 'shutdown')
        this.#settleStop(active.taskId)
      }
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          active.done,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Run still active after shutdown deadline')), this.#stopTimeoutMs + 100)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }
    if (!this.#closed) {
      this.#store.close()
      this.#closed = true
    }
    if (this.#storageFailure) throw this.#storageFailure
  }
}
