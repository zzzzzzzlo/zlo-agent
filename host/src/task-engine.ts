import { randomUUID } from 'node:crypto'
import type { EndReason, EventDraft, ModelRoute, TaskStatus, VerificationCheck, VerificationResult } from './contracts/domain.ts'
import type { LocalStore } from './store.ts'

export type { EndReason, TaskStatus } from './contracts/domain.ts'
export interface WorkerResult {
  resultStatus: 'succeeded' | 'failed'
  summary: string
  artifactRefs: string[]
  evidenceRefs: string[]
  remainingRisks: string[]
}
export interface WorkerNode {
  id: string
  parentNodeId: string
  dependencies: string[]
  goal: string
  status: 'ready' | 'running' | 'succeeded' | 'failed'
  attemptId?: string
  result?: WorkerResult
}
export interface TaskSnapshot {
  schemaVersion: 1
  id: string
  taskRunId: string
  conversationId?: string
  rootNodeId: string
  goal: string
  cwd: string
  check?: VerificationCheck
  status: TaskStatus
  attemptId?: string
  attemptCount: number
  reason?: EndReason
  stopIntent?: { requestId: string; source: 'user' | 'shutdown' }
  instructions: { id: string; text: string; delivered: boolean }[]
  route?: ModelRoute
  planVersion: number
  worker?: WorkerNode
  verification?: VerificationResult
}
export interface Attempt {
  schemaVersion: 1
  id: string
  taskId: string
  taskRunId: string
  nodeId: string
  startedAt: string
  finishedAt?: string
  recoveries?: number
  status: 'running' | 'succeeded' | 'failed' | 'interrupted' | 'unknown_effect'
  reason?: EndReason
}
export interface Operation {
  schemaVersion: 1
  id: string
  taskId: string
  taskRunId: string
  attemptId: string
  agentRunId?: string
  agentId?: string
  sessionId?: string
  taskNodeId?: string
  parentAgentRunId?: string
  tool: string
  effect: 'read' | 'write'
  target?: string
  status: 'started' | 'succeeded' | 'failed' | 'interrupted' | 'unknown_effect'
}
export interface CreateTask {
  requestId: string
  goal: string
  cwd: string
  check?: VerificationCheck
  route?: ModelRoute
  conversationId?: string
}

const edges: Record<TaskStatus, TaskStatus[]> = {
  ready: ['running', 'stop_requested', 'failed'],
  running: ['verifying', 'stop_requested', 'stopped', 'failed', 'blocked', 'needs_reconciliation'],
  verifying: ['running', 'succeeded', 'failed', 'stop_requested', 'stopped', 'needs_reconciliation'],
  succeeded: [],
  failed: [],
  blocked: ['ready', 'stop_requested', 'needs_reconciliation'],
  stop_requested: ['stopping', 'needs_reconciliation'],
  stopping: ['stopped', 'needs_reconciliation'],
  stopped: ['ready', 'needs_reconciliation'],
  needs_reconciliation: [],
}
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return edges[from].includes(to)
}
export function isStopping(status: TaskStatus): boolean {
  return status === 'stop_requested' || status === 'stopping'
}
function checkText(value: string, name: string, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error('Invalid ' + name)
  return value
}
export function validateRequestId(id: string): void {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(id)) throw new Error('Invalid request ID')
}
function serialize(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(serialize).join(',') + ']'
  if (value && typeof value === 'object') {
    const items = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    return '{' + items.map(([key, item]) => JSON.stringify(key) + ':' + serialize(item)).join(',') + '}'
  }
  return JSON.stringify(value)
}

export class TaskEngine {
  readonly #db: LocalStore
  constructor(db: LocalStore) {
    this.#db = db
    const legacy = this.list().filter((task) => !task.taskRunId)
    if (legacy.length) this.#db.transaction(() => {
      const runs = new Map(legacy.map((task) => [task.id, randomUUID()]))
      for (const task of legacy) this.#save({ ...task, taskRunId: runs.get(task.id)! })
      for (const attempt of this.#db.list<Attempt>('attempts')) {
        const taskRunId = runs.get(attempt.taskId)
        if (taskRunId) this.#db.put('attempts', attempt.id, { ...attempt, taskRunId })
      }
      for (const operation of this.#db.list<Operation>('operations')) {
        const taskRunId = runs.get(operation.taskId)
        if (taskRunId) this.#db.put('operations', operation.id, { ...operation, taskRunId })
      }
    })
  }

  get(taskId: string): TaskSnapshot {
    const snapshot = this.#db.get<TaskSnapshot>('tasks', taskId)
    if (!snapshot) throw new Error('Task does not exist')
    return snapshot
  }

  list(): TaskSnapshot[] { return this.#db.list<TaskSnapshot>('tasks') }

  attempts(taskId: string): Attempt[] {
    this.get(taskId)
    return this.#db.list<Attempt>('attempts').filter((attempt) => attempt.taskId === taskId)
  }

  operations(taskId: string): Operation[] {
    this.get(taskId)
    return this.#db.list<Operation>('operations').filter((operation) => operation.taskId === taskId)
  }

  recorded<T>(requestId: string, signature: unknown): T | undefined {
    validateRequestId(requestId)
    const record = this.#db.get<{ signature: string; result: T }>('commands', requestId)
    if (!record) return undefined
    if (record.signature !== serialize(signature)) throw new Error('Request ID already used for a different command')
    return record.result
  }

  #command<T>(requestId: string, signature: unknown, perform: () => T): T {
    return this.#db.transaction(() => {
      const existing = this.recorded<T>(requestId, signature)
      if (existing !== undefined) return existing
      const result = perform()
      this.#db.put('commands', requestId, { schemaVersion: 1, signature: serialize(signature), result })
      return result
    })
  }

  #save(task: TaskSnapshot): void { this.#db.put('tasks', task.id, task) }

  #event(task: TaskSnapshot, type: string, payload: Record<string, unknown>, correlationId?: string): void {
    this.#db.append({
      taskId: task.id, taskRunId: task.taskRunId, taskAttemptId: task.attemptId,
      taskNodeId: task.rootNodeId, type, payload, correlationId,
    })
  }

  #transition(task: TaskSnapshot, status: TaskStatus, type = 'task.state_changed', correlationId?: string): TaskSnapshot {
    if (!canTransition(task.status, status)) throw new Error('Invalid task transition ' + task.status + ' → ' + status)
    const next = { ...task, status }
    this.#save(next)
    this.#event(next, type, { previous: task.status, status, reason: task.reason }, correlationId)
    return next
  }

  create(command: CreateTask, onCreated?: (task: TaskSnapshot) => void): { taskId: string } {
    return this.#command(command.requestId, ['create', command], () => {
      const task: TaskSnapshot = {
        schemaVersion: 1, id: randomUUID(), taskRunId: randomUUID(), rootNodeId: randomUUID(), cwd: command.cwd,
        conversationId: command.conversationId,
        goal: checkText(command.goal, 'goal', 16000),
        check: command.check && { path: checkText(command.check.path, 'verification path', 512), contains: command.check.contains },
        route: command.route, status: 'ready', attemptCount: 0, instructions: [], planVersion: 0,
      }
      if (command.check?.contains !== undefined) checkText(command.check.contains, 'verification text', 16000)
      this.#save(task)
      onCreated?.(task)
      this.#event(task, 'task.created', { status: task.status }, command.requestId)
      return { taskId: task.id }
    })
  }

  start(taskId: string): TaskSnapshot {
    return this.#db.transaction(() => {
      const task = this.get(taskId)
      const recovered = task.attemptId ? this.#db.get<Attempt>('attempts', task.attemptId) : undefined
      const reuse = recovered?.status === 'interrupted' && recovered.reason === 'process_interrupted'
      const attempt: Attempt = reuse ? {
        ...recovered, status: 'running', reason: undefined, finishedAt: undefined, recoveries: (recovered.recoveries ?? 0) + 1,
      } : {
        schemaVersion: 1, id: randomUUID(), taskId, taskRunId: task.taskRunId, nodeId: task.rootNodeId,
        startedAt: new Date().toISOString(), status: 'running',
      }
      this.#db.put('attempts', attempt.id, attempt)
      return this.#transition({ ...task, attemptId: attempt.id, attemptCount: task.attemptCount + (reuse ? 0 : 1) }, 'running')
    })
  }

  addInstruction(taskId: string, requestId: string, text: string, onAccepted?: () => void): { accepted: true } {
    return this.#command(requestId, ['instruction', taskId, text], () => {
      const task = this.get(taskId)
      if (!['ready', 'running', 'verifying', 'stopped', 'blocked'].includes(task.status)) throw new Error('Task does not accept instructions')
      if (task.instructions.length >= 64) throw new Error('Instruction limit reached')
      task.instructions.push({ id: requestId, text: checkText(text, 'instruction', 8000), delivered: false })
      this.#save(task)
      onAccepted?.()
      this.#event(task, 'task.instruction_added', {}, requestId)
      return { accepted: true }
    })
  }

  markDelivered(taskId: string, ids: string[]): void {
    this.#db.transaction(() => {
      const task = this.get(taskId)
      if (!ids.length) return
      for (const item of task.instructions) {
        if (ids.includes(item.id)) item.delivered = true
      }
      this.#save(task)
      this.#event(task, 'task.instructions_delivered', { count: ids.length })
    })
  }

  switchRoute(taskId: string, requestId: string, route: ModelRoute | undefined, onAccepted?: () => void): { accepted: true } {
    return this.#command(requestId, ['switch', taskId, route], () => {
      const task = this.get(taskId)
      if (!['ready', 'running', 'verifying', 'stopped', 'blocked'].includes(task.status)) throw new Error('Task does not accept a model change')
      this.#save({ ...task, route })
      onAccepted?.()
      this.#event(task, 'model.switch_requested', { route }, requestId)
      return { accepted: true }
    })
  }

  requestStop(taskId: string, requestId: string, source: 'user' | 'shutdown' = 'user'): { accepted: boolean; status: TaskStatus } {
    return this.#command(requestId, ['stop', taskId, source], () => {
      const task = this.get(taskId)
      if (isStopping(task.status) || task.status === 'stopped') return { accepted: true, status: task.status }
      if (!canTransition(task.status, 'stop_requested')) return { accepted: false, status: task.status }
      const next = this.#transition({ ...task, stopIntent: { requestId, source } }, 'stop_requested', 'task.stop_requested', requestId)
      return { accepted: true, status: next.status }
    })
  }

  beginStopping(taskId: string): void {
    this.#db.transaction(() => {
      const task = this.get(taskId)
      if (task.status === 'stop_requested') this.#transition(task, 'stopping')
    })
  }

  resume(taskId: string, requestId: string, checkpointAvailable = true): { accepted: boolean; status: TaskStatus } {
    return this.#command(requestId, ['resume', taskId], () => {
      const task = this.get(taskId)
      const retainAttempt = task.reason === 'process_interrupted' && Boolean(task.attemptId)
      if (!canTransition(task.status, 'ready') || (!retainAttempt && task.attemptCount >= 8)) {
        return { accepted: false, status: task.status }
      }
      if (!checkpointAvailable) {
        this.#event(task, 'operation.reconciliation_required', { operationIds: [], reason: 'checkpoint_error' })
        const blocked = this.#finish(task, 'needs_reconciliation', 'checkpoint_error')
        return { accepted: false, status: blocked.status }
      }
      const next = this.#transition({
        ...task, stopIntent: undefined, reason: undefined,
        attemptId: retainAttempt ? task.attemptId : undefined, verification: undefined,
      }, 'ready', 'task.resumed', requestId)
      return { accepted: true, status: next.status }
    })
  }

  addTask(taskId: string, requestId: string, goal: string, expectedVersion: number, dependencies: string[] = []): WorkerNode {
    return this.#command(requestId, ['addTask', taskId, goal, expectedVersion, dependencies],
      () => this.#addWorker(this.get(taskId), goal, expectedVersion, dependencies))
  }

  delegate(taskId: string, goal: string): WorkerNode {
    return this.#db.transaction(() => {
      const task = this.get(taskId)
      if (task.status !== 'running') throw new Error('Task is not accepting delegation')
      if (task.worker?.goal === goal && task.worker.result) return task.worker
      return this.#addWorker(task, goal, task.planVersion, [])
    })
  }

  #addWorker(task: TaskSnapshot, goal: string, expectedVersion: number, dependencies: string[]): WorkerNode {
    if (!['ready', 'running', 'verifying', 'stopped', 'blocked'].includes(task.status)) throw new Error('Task is not accepting work')
    if (task.planVersion !== expectedVersion) throw new Error('Plan version changed')
    if (task.worker) throw new Error('Single Worker budget exhausted')
    if (!Array.isArray(dependencies) || dependencies.length) throw new Error('This sprint only supports a leaf with no execution dependencies')
    const worker: WorkerNode = {
      id: randomUUID(), parentNodeId: task.rootNodeId, dependencies: [], goal: checkText(goal, 'worker goal', 8000), status: 'ready',
    }
    this.#save({ ...task, worker, planVersion: task.planVersion + 1 })
    this.#event(task, 'task.plan_changed', { workerNodeId: worker.id, version: task.planVersion + 1 })
    return worker
  }

  startWorker(taskId: string, nodeId: string): string {
    return this.#db.transaction(() => {
      const task = this.get(taskId)
      if (task.status !== 'running' || task.worker?.id !== nodeId || task.worker.status !== 'ready') {
        throw new Error('Worker node is not runnable')
      }
      const id = randomUUID()
      const attempt: Attempt = {
        schemaVersion: 1, id, taskId, taskRunId: task.taskRunId, nodeId,
        startedAt: new Date().toISOString(), status: 'running',
      }
      this.#save({ ...task, worker: { ...task.worker, attemptId: id, status: 'running' } })
      this.#db.put('attempts', id, attempt)
      return id
    })
  }

  settleWorker(taskId: string, nodeId: string, result?: WorkerResult): void {
    this.#db.transaction(() => {
      const task = this.get(taskId)
      if (task.worker?.id !== nodeId || task.worker.status !== 'running') return
      this.#save({ ...task, worker: { ...task.worker, status: result?.resultStatus ?? 'ready', result } })
      this.#finishAttempt(task.worker.attemptId, result?.resultStatus ?? 'interrupted')
      this.#db.append({
        taskId, taskRunId: task.taskRunId, taskNodeId: nodeId, taskAttemptId: task.worker.attemptId,
        type: 'task.worker_settled', payload: { status: result?.resultStatus ?? 'interrupted' },
      })
    })
  }

  beginTool(taskId: string, event: EventDraft, id: string, tool: string, effect: Operation['effect'], target?: string): void {
    this.#db.transaction(() => {
      const task = this.get(taskId)
      if (task.status !== 'running' || !task.attemptId) throw new Error('Task is not accepting tool work')
      if (this.#db.get('operations', id)) throw new Error('Duplicate tool call')
      const operation: Operation = {
        schemaVersion: 1, id, taskId, taskRunId: task.taskRunId, attemptId: event.taskAttemptId ?? task.attemptId,
        agentRunId: event.agentRunId, agentId: event.agentId, sessionId: event.sessionId,
        taskNodeId: event.taskNodeId, parentAgentRunId: event.parentAgentRunId,
        tool, effect, target, status: 'started',
      }
      this.#db.put('operations', id, operation)
      this.#db.append({ ...event, type: 'tool.started', payload: { id, tool, effect } })
    })
  }

  finishTool(event: EventDraft, id: string, status: Exclude<Operation['status'], 'started'>): void {
    this.#db.transaction(() => {
      const operation = this.#db.get<Operation>('operations', id)
      if (!operation || operation.taskId !== event.taskId || operation.status !== 'started') throw new Error('Tool receipt is not open')
      this.#db.put('operations', id, { ...operation, status })
      this.#db.append({ ...event, type: 'tool.finished', payload: { id, tool: operation.tool, status } })
    })
  }

  beginVerification(taskId: string): void {
    this.#db.transaction(() => { this.#transition(this.get(taskId), 'verifying') })
  }

  continueExecution(taskId: string): void {
    this.#db.transaction(() => { this.#transition(this.get(taskId), 'running') })
  }

  verify(taskId: string, verification: VerificationResult): TaskSnapshot {
    return this.#db.transaction(() => {
      const task = this.get(taskId)
      if (task.status !== 'verifying') throw new Error('Invalid task transition from ' + task.status + ' to verified')
      if (task.worker?.status === 'ready' || task.worker?.status === 'running' ||
        (task.worker?.status === 'failed' && verification.passed)) {
        throw new Error('Worker outcome prevents task acceptance')
      }
      if (this.operations(taskId).some((operation) => operation.status === 'started' || operation.status === 'unknown_effect')) {
        throw new Error('Tool receipts prevent task acceptance')
      }
      this.#event(task, 'verification.finished', { ...verification })
      return this.#finish({ ...task, verification }, verification.passed ? 'succeeded' : 'failed',
        verification.passed ? undefined : 'verification_failed')
    })
  }

  end(taskId: string, reason: EndReason): TaskSnapshot {
    return this.#db.transaction(() => {
      let task = this.get(taskId)
      if (task.status === 'needs_reconciliation') return task
      const unknown = this.operations(taskId).filter((operation) =>
        operation.effect === 'write' && (operation.status === 'started' || operation.status === 'unknown_effect'))
      for (const operation of this.operations(taskId)) {
        if (operation.status !== 'started') continue
        const status = operation.effect === 'write' ? 'unknown_effect' : 'interrupted'
        this.#db.put('operations', operation.id, { ...operation, status })
        this.#db.append({
          taskId, taskRunId: task.taskRunId, taskAttemptId: operation.attemptId, taskNodeId: operation.taskNodeId,
          agentRunId: operation.agentRunId, agentId: operation.agentId, sessionId: operation.sessionId,
          parentAgentRunId: operation.parentAgentRunId, type: 'tool.finished',
          payload: { id: operation.id, tool: operation.tool, status },
        })
      }
      if (task.worker?.status === 'running') {
        this.#finishAttempt(task.worker.attemptId, 'interrupted', reason)
        task = { ...task, worker: { ...task.worker, status: 'ready' } }
      }
      if (unknown.length || reason === 'checkpoint_error' || reason === 'stop_timeout') {
        this.#event(task, 'operation.reconciliation_required', { operationIds: unknown.map((operation) => operation.id), reason })
        return this.#finish(task, 'needs_reconciliation', unknown.length ? 'unknown_effect' : reason)
      }
      if (task.status === 'stop_requested') task = this.#transition(task, 'stopping')
      if (task.status === 'stopping') {
        return this.#finish(task, 'stopped', task.stopIntent?.source === 'shutdown' ? 'host_shutdown' : 'user_stop', 'task.stopped')
      }
      if (reason === 'process_interrupted' || reason === 'model_interrupted') return this.#finish(task, 'stopped', reason, 'task.stopped')
      if (reason === 'model_error') return this.#finish(task, 'blocked', reason)
      return this.#finish(task, 'failed', reason)
    })
  }

  #finish(task: TaskSnapshot, status: TaskStatus, reason?: EndReason, type?: string): TaskSnapshot {
    const next = this.#transition({ ...task, reason }, status, type)
    const attemptStatus = status === 'needs_reconciliation' ? 'unknown_effect'
      : status === 'stopped' ? 'interrupted'
      : status === 'succeeded' ? 'succeeded' : 'failed'
    this.#finishAttempt(task.attemptId, attemptStatus, reason)
    return next
  }

  #finishAttempt(attemptId: string | undefined, status: Attempt['status'], reason?: EndReason): void {
    const attempt = attemptId ? this.#db.get<Attempt>('attempts', attemptId) : undefined
    if (attempt?.status === 'running') {
      this.#db.put('attempts', attempt.id, { ...attempt, status, reason, finishedAt: new Date().toISOString() })
    }
  }
}
