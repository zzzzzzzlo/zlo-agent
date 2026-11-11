import { createHash, randomUUID } from 'node:crypto'
import { writeHostDiagnostic } from '../../shared/diagnostics.ts'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import type { AgentExecution } from './execution.ts'
import { createArtifactTools } from './artifact-tools.ts'
import { createBrowserTools } from './browser-tools.ts'
import { createFileTools } from './file-tools.ts'
import { createGitTools, ManagedGitWorktrees } from './git-tools.ts'
import { createProcessTools } from './process-tools.ts'
import { createWebTools } from './web-tools.ts'
import type { ToolApprovalCommand } from '../../shared/contracts/tool-approval.ts'
import type { AgentEvent, EventDraft, ModelRoute, TaskStatus, VerificationCheck, WorkspaceAccess } from './contracts/domain.ts'
import type {
  ActionResult, ArchiveConversationInput, ConversationAction, ConversationEvent, ConversationHistory,
  ConversationSummary, CreateConversationInput, CursorInput, DesktopCommand, HistoryInput,
  RenameConversationInput, SendMessageInput, SendMessageResult, SetConversationModelInput, SteerInput,
} from '../../shared/contracts/desktop.ts'
import {
  ConversationError, ConversationService, parseConversationAction, parseCreateConversation, parseSendMessage, parseSetConversationModel, parseSteer,
} from './conversation.ts'
import { installTaskDiagnostics } from './diagnostics.ts'
import { LocalJudgment } from './judgment.ts'
import type { JudgmentOptions } from './judgment.ts'
import { LocalMemory, ScopedContext } from './memory.ts'
import { LocalModelScheduler } from './model-scheduler.ts'
import type { ModelLimits } from './model-scheduler.ts'
import { MultiAgentOrchestrator, executionFailure, memoryScope, sameRoute } from './orchestrator.ts'
import { CodingCapabilities, ExtensionRegistry } from './policies.ts'
import type { CodingProfile } from './policies.ts'
import { LocalStore } from './store.ts'
import { isStopping, TaskEngine } from './task-engine.ts'
import type { CreateTask, NodeProposal, NodeReplan, TaskSnapshot } from './task-engine.ts'
import { ToolApprovalBroker } from './tool-approval.ts'
import type { ToolApprover } from './tool-approval.ts'
import { verifyWorkspace } from './verification.ts'
import { CodingWorkspace } from './workspace.ts'

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
  judgment?: JudgmentOptions
  defaultWorkspace?: string
  defaultRoute?: ModelRoute
  approveTool?: ToolApprover
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
  readonly #defaultRoute?: ModelRoute
  readonly #approval: ToolApprovalBroker
  #active?: ActiveTask
  #closing = false
  #closed = false
  #storageFailure?: Error

  constructor(options: HostOptions) {
    mkdirSync(options.directory, { recursive: true, mode: 0o700 })
    this.#directory = realpathSync(options.directory)
    this.#stopTimeoutMs = options.stopTimeoutMs ?? defaultStopTimeoutMs
    const worktrees = new ManagedGitWorktrees(join(this.#directory, 'worktrees'))
    this.#extensions = (options.extensions ?? new ExtensionRegistry([
      { id: 'artifact', tools: workspace => createArtifactTools(workspace, this.#directory) },
      { id: 'files', tools: createFileTools },
      { id: 'git', tools: workspace => createGitTools(workspace, worktrees) },
      { id: 'shell', tools: createProcessTools },
      { id: 'web', tools: workspace => createWebTools(workspace) },
      { id: 'browser', tools: workspace => createBrowserTools(workspace) },
    ])).resolve(options.profileId ?? 'coding')
    this.#profile = { ...(options.profile ?? this.#extensions.profile) }
    this.#capabilities = new CodingCapabilities(this.#profile)
    this.#defaultWorkspace = options.defaultWorkspace ?? this.#directory + '-workspace'
    this.#defaultRoute = options.defaultRoute
    this.#approval = new ToolApprovalBroker(options.approveTool)
    this.#store = new LocalStore(join(this.#directory, 'tasks.sqlite'))
    try {
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
      this.#scheduler = new LocalModelScheduler(options.execution, this.#store, judgment, options.modelLimits)
      this.#orchestrator = new MultiAgentOrchestrator({
        store: this.#store, tasks: this.#engine, execution: options.execution, scheduler: this.#scheduler,
        capabilities: this.#capabilities, profile: this.#profile, extensions: this.#extensions, approval: this.#approval,
        resolveWorkspace: async (workspace, taskId, id, signal) => {
          const root = await worktrees.resolve(workspace, taskId, id, signal)
          return root ? new CodingWorkspace(root) : undefined
        },
        context: new ScopedContext(this.#memory, judgment), judgment,
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

  events(taskId: string, after = 0): AgentEvent[] {
    this.getTask(taskId)
    return this.#store.events(taskId, after)
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
    return this.#conversations.create(command, workspace.root, this.#defaultRoute)
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
    const route = conversation.pendingRoute ?? conversation.route ?? this.#defaultRoute
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
    this.#engine.create({
      requestId: desktopRequestId(command.requestId), conversationId: current.id, goal: command.text,
      cwd: current.workspace, check: current.check, workspaceAccess: current.workspaceAccess,
      route: current.pendingRoute ?? current.route ?? this.#defaultRoute,
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
    if (this.#closing || this.#active || this.#storageFailure) return
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
      const confirmedWrite = operations.some(item => item.effect === 'write' && item.status === 'succeeded')
      const access = this.#capabilities.root(snapshot.workspaceAccess, Boolean(snapshot.check)).access
      const verification = snapshot.worker?.status === 'failed'
        ? { passed: false, evidence: 'worker_verification_failed' }
        : snapshot.nodes?.some(node => node.status !== 'succeeded')
          ? { passed: false, evidence: 'dag_not_converged' }
        : task.check
          ? await verifyWorkspace(this.#engine, this.#extensions.workflow, workspace, result.event, task.check, signal, access, 'verification')
          : { passed: result.textProduced || confirmedWrite, evidence: confirmedWrite
            ? 'confirmed_workspace_operation' : result.textProduced ? 'assistant_response_present' : 'assistant_response_missing' }
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
