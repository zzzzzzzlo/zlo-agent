import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AgentExecution } from './execution.ts'
import type { AgentEvent, ModelRoute, TaskStatus, VerificationCheck } from './contracts/domain.ts'
import type {
  ActionResult, ArchiveConversationInput, ConversationAction, ConversationEvent, ConversationHistory,
  ConversationSummary, CreateConversationInput, CursorInput, DesktopCommand, HistoryInput,
  RenameConversationInput, SendMessageInput, SendMessageResult, SteerInput,
} from './contracts/desktop.ts'
import {
  ConversationError, ConversationService, parseConversationAction, parseCreateConversation, parseSendMessage, parseSteer,
} from './conversation.ts'
import { MultiAgentOrchestrator, executionFailure } from './orchestrator.ts'
import { BaselineJudgment, CodingCapabilities, defaultCodingProfile, LocalContextBuilder, LocalModelScheduler } from './policies.ts'
import type { CodingProfile } from './policies.ts'
import { LocalStore } from './store.ts'
import { isStopping, TaskEngine } from './task-engine.ts'
import type { CreateTask, TaskSnapshot } from './task-engine.ts'
import { CodingWorkspace } from './workspace.ts'

export type HostCommand =
  | { schemaVersion: 1; type: 'createTask'; requestId: string; goal: string; cwd: string; check: VerificationCheck; route?: ModelRoute }
  | { schemaVersion: 1; type: 'getTask' | 'getHistory'; taskId: string }
  | { schemaVersion: 1; type: 'listTasks' | 'getRouteStatus' }
  | { schemaVersion: 1; type: 'stop' | 'resume'; taskId: string; requestId: string }
  | { schemaVersion: 1; type: 'addInstruction'; taskId: string; requestId: string; text: string }
  | { schemaVersion: 1; type: 'addTask'; taskId: string; requestId: string; goal: string; expectedVersion: number; dependencies?: string[] }
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
  defaultWorkspace?: string
  defaultRoute?: ModelRoute
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
  readonly #defaultWorkspace: string
  readonly #defaultRoute?: ModelRoute
  #active?: ActiveTask
  #closing = false
  #closed = false
  #storageFailure?: Error

  constructor(options: HostOptions) {
    mkdirSync(options.directory, { recursive: true, mode: 0o700 })
    this.#directory = realpathSync(options.directory)
    this.#stopTimeoutMs = options.stopTimeoutMs ?? defaultStopTimeoutMs
    this.#profile = { ...(options.profile ?? defaultCodingProfile) }
    this.#defaultWorkspace = options.defaultWorkspace ?? this.#directory + '-workspace'
    this.#defaultRoute = options.defaultRoute
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
      this.#scheduler = new LocalModelScheduler(options.execution)
      this.#orchestrator = new MultiAgentOrchestrator({
        store: this.#store, tasks: this.#engine, execution: options.execution, scheduler: this.#scheduler,
        capabilities: new CodingCapabilities(this.#profile), profile: this.#profile,
        context: new LocalContextBuilder(), judgment: new BaselineJudgment(),
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
    if (containsPath(workspace.root, this.#directory) || containsPath(this.#directory, workspace.root)) {
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
    const route = conversation.route ?? this.#defaultRoute
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
      cwd: current.workspace, check: current.check, route: current.route ?? this.#defaultRoute,
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
    const { requestId, goal, cwd, check, route } = input
    const command = { requestId, goal, cwd, check, route }
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
      case 'createTask': {
        const { requestId, goal, cwd, check, route } = command
        return this.createTask({ requestId, goal, cwd, check, route })
      }
      case 'getTask': return this.getTask(command.taskId)
      case 'getHistory': return this.getHistory(command.taskId)
      case 'listTasks': return this.#engine.list()
      case 'getRouteStatus': return this.#scheduler.getRouteStatus()
      case 'stop': return this.stop(command.taskId, command.requestId)
      case 'resume': return this.resume(command.taskId, command.requestId)
      case 'addInstruction': return this.addInstruction(command.taskId, command.requestId, command.text)
      case 'addTask': return this.addTask(command.taskId, command.requestId, command.goal, command.expectedVersion, command.dependencies)
      case 'requestModelSwitch': return this.requestModelSwitch(command.taskId, command.requestId, command.route)
      case 'createConversation': return this.createConversation(command)
      case 'listConversations': return this.listConversations()
      case 'getConversation': return this.getConversation(command.conversationId)
      case 'getConversationHistory': return this.getConversationHistory(command)
      case 'sendMessage': return this.sendMessage(command)
      case 'steerConversation': return this.steerConversation(command)
      case 'stopConversation': return this.stopConversation(command)
      case 'resumeConversation': return this.resumeConversation(command)
      case 'renameConversation': return this.renameConversation(command)
      case 'archiveConversation': return this.archiveConversation(command)
      default: throw new Error('Unknown command')
    }
  }

  #failStorage(): void {
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
      const verification = snapshot.worker?.status === 'failed'
        ? { passed: false, evidence: 'worker_verification_failed' }
        : task.check
          ? await workspace.verify(task.check, signal).catch(() => ({ passed: false, evidence: 'verification_error' }))
          : { passed: result.textProduced, evidence: result.textProduced ? 'assistant_response_present' : 'assistant_response_missing' }
      if (signal.aborted) {
        this.#engine.end(task.id, 'model_interrupted')
        return
      }
      const latest = this.#engine.get(task.id)
      if (latest.instructions.some((item) => !item.delivered) || latest.worker?.status === 'ready' ||
        (latest.route && (latest.route.model !== result.route.model || latest.route.provider !== result.route.provider))) {
        this.#engine.continueExecution(task.id)
        continue
      }
      this.#engine.verify(task.id, verification)
      return
    }
    this.#engine.end(task.id, 'budget_exhausted')
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
