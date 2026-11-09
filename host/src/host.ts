import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AgentExecution, ModelRoute } from './execution.ts'
import { MultiAgentOrchestrator, executionFailure } from './orchestrator.ts'
import { BaselineJudgment, CodingCapabilities, defaultCodingProfile, LocalContextBuilder, LocalModelScheduler } from './policies.ts'
import type { CodingProfile } from './policies.ts'
import { LocalStore } from './store.ts'
import type { AgentEvent } from './store.ts'
import { isStopping, TaskEngine } from './task-engine.ts'
import type { CreateTask, TaskSnapshot, TaskStatus } from './task-engine.ts'
import { CodingWorkspace } from './workspace.ts'

export type HostCommand =
  | { schemaVersion: 1; type: 'createTask'; requestId: string; goal: string; cwd: string; check: CreateTask['check']; route?: ModelRoute }
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

const recoverableAfterCrash = new Set<TaskStatus>(['running', 'verifying', 'stop_requested', 'stopping'])
const defaultStopTimeoutMs = 10000

function containsPath(parent: string, child: string): boolean {
  const diff = relative(parent, child)
  return diff === '' || (diff !== '..' && !diff.startsWith('..' + sep) && !isAbsolute(diff))
}

export class LocalAgentHost {
  readonly #directory: string
  readonly #store: LocalStore
  readonly #engine: TaskEngine
  readonly #orchestrator: MultiAgentOrchestrator
  readonly #scheduler: LocalModelScheduler
  readonly #stopTimeoutMs: number
  readonly #profile: Readonly<CodingProfile>
  #active?: ActiveTask
  #closing = false
  #closed = false
  #storageFailure?: Error

  constructor(options: { directory: string; execution: AgentExecution; stopTimeoutMs?: number; runtimeId?: string; profile?: CodingProfile }) {
    mkdirSync(options.directory, { recursive: true, mode: 0o700 })
    this.#directory = realpathSync(options.directory)
    this.#stopTimeoutMs = options.stopTimeoutMs ?? defaultStopTimeoutMs
    this.#profile = { ...(options.profile ?? defaultCodingProfile) }
    this.#store = new LocalStore(join(this.#directory, 'tasks.sqlite'))
    this.#engine = new TaskEngine(this.#store)
    this.#scheduler = new LocalModelScheduler(options.execution)
    this.#orchestrator = new MultiAgentOrchestrator({
      store: this.#store, tasks: this.#engine, execution: options.execution, scheduler: this.#scheduler,
      capabilities: new CodingCapabilities(this.#profile), profile: this.#profile,
      context: new LocalContextBuilder(), judgment: new BaselineJudgment(),
      sessions: join(this.#directory, 'sessions'),
    })
    try {
      if (options.runtimeId) {
        this.#store.transaction(() => {
          const bound = this.#store.get<{ runtimeId: string }>('host', 'runtime')
          if (bound && bound.runtimeId !== options.runtimeId) throw new Error('Host data directory belongs to a different runtime')
          if (!bound) this.#store.put('host', 'runtime', { schemaVersion: 1, runtimeId: options.runtimeId })
        })
      }
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
    if (this.#closed || this.#closing) throw new Error('Host is closing')
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

  async createTask(command: CreateTask): Promise<{ taskId: string }> {
    this.#assertOpen()
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
    const session = this.#orchestrator.session(taskId)
    const result = this.#engine.resume(taskId, requestId, !session || existsSync(session.path))
    this.#dispatch()
    return result
  }

  addInstruction(taskId: string, requestId: string, text: string) {
    this.#assertOpen()
    return this.#engine.addInstruction(taskId, requestId, text)
  }

  addTask(taskId: string, requestId: string, goal: string, expectedVersion: number, dependencies?: string[]) {
    this.#assertOpen()
    if (!this.#profile.delegation) throw new Error('The Coding profile disables delegation')
    return this.#engine.addTask(taskId, requestId, goal, expectedVersion, dependencies)
  }

  async requestModelSwitch(taskId: string, requestId: string, route: ModelRoute) {
    this.#assertOpen()
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

  async command(command: HostCommand): Promise<unknown> {
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
        : await workspace.verify(task.check, signal).catch(() => ({ passed: false, evidence: 'verification_error' }))
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
