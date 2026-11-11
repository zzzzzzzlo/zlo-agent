import { randomUUID } from 'node:crypto'
import { projectCommands } from './contracts/domain.ts'
import type { EndReason, EventDraft, ModelRoute, TaskStatus, VerificationCheck, VerificationResult, WorkspaceAccess } from './contracts/domain.ts'
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
  role?: 'team' | 'worker'
  teamKey?: string
  access?: 'read' | 'write'
  scopePath?: string
  worktreeId?: string
  check?: VerificationCheck
  route?: ModelRoute
  verification?: VerificationResult
  replans?: number
  suspendedFor?: string
}
export interface NodeProposal {
  ref: string
  goal: string
  parentNodeId?: string
  dependencies?: string[]
  role?: 'team' | 'worker'
  teamKey?: string
  access?: 'read' | 'write'
  scopePath?: string
  worktreeId?: string
  check?: VerificationCheck
  route?: ModelRoute
}
export interface NodeReplan {
  goal?: string
  dependencies?: string[]
  check?: VerificationCheck
}
export interface TaskSnapshot {
  schemaVersion: 1
  id: string
  taskRunId: string
  conversationId?: string
  rootNodeId: string
  goal: string
  cwd: string
  workspaceAccess?: WorkspaceAccess
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
  nodes?: WorkerNode[]
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
  managed?: boolean
  worktreeId?: string
  status: 'started' | 'succeeded' | 'failed' | 'interrupted' | 'unknown_effect'
}
export interface CreateTask {
  requestId: string
  goal: string
  cwd: string
  workspaceAccess?: WorkspaceAccess
  check?: VerificationCheck
  route?: ModelRoute
  conversationId?: string
}

const MAX_PLAN_NODES = 16
const MAX_NODE_RUNS = 32
const MAX_CONCURRENT_NODES = 4
const MAX_CONCURRENT_TEAMS = 2
const PLANNING_STATES: TaskStatus[] = ['ready', 'running', 'verifying', 'stopped', 'blocked']

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
function verificationCheck(check: VerificationCheck | undefined): VerificationCheck | undefined {
  if (check === undefined) return undefined
  if (!check || typeof check !== 'object') throw new Error('Invalid verification check')
  if ('command' in check && check.command !== undefined) {
    if (check.path !== undefined || check.contains !== undefined) throw new Error('Invalid command verification check')
    const { command, path, args } = check.command ?? {}
    if (!projectCommands.includes(command)) throw new Error('Unknown verification command')
    if (args !== undefined && (!Array.isArray(args) || args.length > 16 ||
      args.some((arg) => typeof arg !== 'string' || arg.length > 512 || arg.includes('\0')))) {
      throw new Error('Invalid verification arguments')
    }
    return { command: { command, path: checkText(path, 'verification command path', 512), ...(args ? { args: [...args] } : {}) } }
  }
  const path = checkText(check.path, 'verification path', 512)
  if (check.contains !== undefined) checkText(check.contains, 'verification text', 16000)
  return { path, ...(check.contains !== undefined ? { contains: check.contains } : {}) }
}
function allNodes(task: TaskSnapshot): WorkerNode[] {
  return [...(task.worker ? [task.worker] : []), ...(task.nodes ?? [])]
}
function separateWorktrees(left?: string, right?: string): boolean {
  return Boolean(left && right && left !== right)
}
function planRoute(route: ModelRoute): ModelRoute {
  if (typeof route?.provider !== 'string' || typeof route.model !== 'string' ||
    !/^[\w-]{1,80}$/.test(route.provider) || !/^[\w.:/-]{1,200}$/.test(route.model)) throw new Error('Invalid node model route')
  return { provider: route.provider, model: route.model }
}
function changeNode(task: TaskSnapshot, node: WorkerNode): TaskSnapshot {
  if (task.worker?.id === node.id) return { ...task, worker: node }
  return { ...task, nodes: task.nodes?.map((current) => current.id === node.id ? node : current) }
}
function nodeDependencies(value: string[] = [], resolve: (id: string) => string = (id) => id): string[] {
  if (!Array.isArray(value) || value.length >= MAX_PLAN_NODES ||
    value.some((id) => typeof id !== 'string' || !id.length || id.length > 80)) throw new Error('Invalid node dependencies')
  const dependencies = value.map(resolve)
  if (new Set(dependencies).size !== dependencies.length) throw new Error('Duplicate node dependency')
  return dependencies
}
function scopePath(value: string): string {
  const parts = checkText(value, 'workspace scope', 512).split(/[\\/]/u)
  if (parts.some((part) => !part || part.startsWith('.') || /[ .]$/u.test(part) || /[\u0000-\u001f\u007f<>:"|?*]/u.test(part))) {
    throw new Error('Invalid relative workspace scope')
  }
  return parts.join('/')
}
function containsScope(parent: string, child: string): boolean {
  if (process.platform === 'win32') {
    parent = parent.toLowerCase()
    child = child.toLowerCase()
  }
  return parent === child || child.startsWith(parent + '/')
}
function assertCheckInScope(check: VerificationCheck | undefined, scope: string | undefined): void {
  if (check && scope && !containsScope(scope, scopePath(check.path ?? check.command.path))) {
    throw new Error('Verification target is outside the node scope')
  }
}
function interruptedWrite(operations: Operation[]) {
  const writes = operations.filter(({ effect }) => effect === 'write')
  if (!writes.length) return undefined
  const unknown = writes.some(({ status }) => status === 'started' || status === 'unknown_effect')
  const evidence = unknown ? 'node_unknown_effect' : 'node_interrupted_after_write'
  const result: WorkerResult = {
    resultStatus: 'failed',
    summary: unknown ? 'A write needs reconciliation.' : 'A write was recorded before the node was interrupted.',
    artifactRefs: [],
    evidenceRefs: writes.filter(({ status }) => status === 'succeeded' || status === 'failed').map(({ id }) => id),
    remainingRisks: [evidence],
  }
  return { unknown, result, verification: { passed: false, evidence } }
}
function assertValidGraph(rootNodeId: string, nodes: WorkerNode[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  function visit(node: WorkerNode): void {
    if (visited.has(node.id)) return
    if (visiting.has(node.id)) throw new Error('Cyclic node dependencies')
    visiting.add(node.id)
    if (node.parentNodeId !== rootNodeId) {
      const parent = byId.get(node.parentNodeId)
      if (parent?.role !== 'team' || parent.parentNodeId !== rootNodeId || node.role === 'team' || node.access === 'write') {
        throw new Error('Invalid parent scope or depth. Team Agents may delegate read-only Workers')
      }
    }
    for (const id of node.dependencies) {
      const dependency = byId.get(id)
      if (!dependency || dependency.parentNodeId !== node.parentNodeId) {
        throw new Error('Node dependency must belong to the same task and parent scope')
      }
      visit(dependency)
    }
    visiting.delete(node.id)
    visited.add(node.id)
  }
  for (const node of nodes) visit(node)
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
      if (command.workspaceAccess !== undefined && !['read', 'write', 'trusted'].includes(command.workspaceAccess)) {
        throw new Error('Invalid workspace access')
      }
      const check = verificationCheck(command.check)
      if (check?.command && command.workspaceAccess !== 'trusted') {
        throw new Error('Command verification requires trusted workspace access')
      }
      const task: TaskSnapshot = {
        schemaVersion: 1, id: randomUUID(), taskRunId: randomUUID(), rootNodeId: randomUUID(), cwd: command.cwd,
        conversationId: command.conversationId,
        goal: checkText(command.goal, 'goal', 16000),
        check,
        ...(command.workspaceAccess !== undefined ? { workspaceAccess: command.workspaceAccess } : {}),
        route: command.route, status: 'ready', attemptCount: 0, instructions: [], planVersion: 0,
      }
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
    this.#assertPlanning(task, expectedVersion)
    if (task.worker) throw new Error('Single Worker budget exhausted')
    if (allNodes(task).length >= MAX_PLAN_NODES) throw new Error('Task node budget exhausted')
    if (!Array.isArray(dependencies) || dependencies.length) throw new Error('This sprint only supports a leaf with no execution dependencies')
    const worker: WorkerNode = {
      id: randomUUID(), parentNodeId: task.rootNodeId, dependencies: [], goal: checkText(goal, 'worker goal', 8000), status: 'ready',
    }
    this.#save({ ...task, worker, planVersion: task.planVersion + 1 })
    this.#event(task, 'task.plan_changed', { workerNodeId: worker.id, version: task.planVersion + 1 })
    return worker
  }

  #assertPlanning(task: TaskSnapshot, expectedVersion: number): void {
    if (!PLANNING_STATES.includes(task.status)) throw new Error('Task is not accepting work')
    if (task.planVersion !== expectedVersion) throw new Error('Plan version changed')
    if (this.operations(task.id).some((operation) => operation.status === 'unknown_effect')) {
      throw new Error('Unresolved tool effects prevent planning')
    }
  }

  proposePlan(taskId: string, requestId: string, expectedVersion: number, proposals: NodeProposal[]): WorkerNode[] {
    return this.#command(requestId, ['proposePlan', taskId, expectedVersion, proposals], () => {
      const task = this.get(taskId)
      this.#assertPlanning(task, expectedVersion)
      const existing = allNodes(task)
      if (!Array.isArray(proposals) || !proposals.length || proposals.length + existing.length > MAX_PLAN_NODES) {
        throw new Error('Invalid plan size or task node budget exhausted')
      }
      const ids = new Map<string, string>()
      for (const proposal of proposals) {
        if (!proposal || typeof proposal.ref !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(proposal.ref) ||
          ids.has(proposal.ref) || task.rootNodeId === proposal.ref || existing.some(({ id }) => id === proposal.ref)) {
          throw new Error('Invalid or duplicate plan reference')
        }
        ids.set(proposal.ref, randomUUID())
      }
      const resolve = (id: string) => ids.get(id) ?? id
      const candidates = proposals.map((proposal): WorkerNode => {
        const role = proposal.role ?? 'worker'
        const access = proposal.access ?? 'read'
        const parentNodeId = resolve(proposal.parentNodeId ?? task.rootNodeId)
        if (proposal.worktreeId !== undefined && (typeof proposal.worktreeId !== 'string' ||
          !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(proposal.worktreeId) ||
          parentNodeId !== task.rootNodeId || task.workspaceAccess !== 'trusted')) {
          throw new Error('Worktree isolation requires an approved root-level assignment')
        }
        if (role !== 'team' && role !== 'worker') throw new Error('Invalid Agent role')
        if (role === 'team' && (typeof proposal.teamKey !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(proposal.teamKey))) {
          throw new Error('Team node requires a stable Team key')
        }
        if (role === 'worker' && proposal.teamKey !== undefined) throw new Error('Worker cannot claim a Team key')
        if (access !== 'read' && access !== 'write') throw new Error('Invalid node access')
        if (access === 'write' && !(task.workspaceAccess === 'write' || task.workspaceAccess === 'trusted' ||
          (task.workspaceAccess === undefined && task.check?.path))) throw new Error('Node cannot expand workspace access')
        const parent = existing.find(({ id }) => id === parentNodeId)
        if (parent && parent.status !== 'ready' && parent.status !== 'running') throw new Error('Parent is not accepting work')
        const check = verificationCheck(proposal.check)
        if (check?.command && (task.workspaceAccess !== 'trusted' || access !== 'write')) {
          throw new Error('Command verification requires trusted workspace access and a write node')
        }
        return {
          id: ids.get(proposal.ref)!, parentNodeId, role, access, status: 'ready',
          goal: checkText(proposal.goal, 'worker goal', 8000),
          dependencies: nodeDependencies(proposal.dependencies, resolve),
          ...(proposal.scopePath !== undefined ? { scopePath: scopePath(proposal.scopePath) } : {}),
          ...(proposal.worktreeId ? { worktreeId: proposal.worktreeId } : {}),
          ...(proposal.teamKey !== undefined ? { teamKey: proposal.teamKey } : {}),
          ...(check ? { check } : {}),
          ...(proposal.route !== undefined ? { route: planRoute(proposal.route) } : {}),
        }
      })
      const graph = [...existing, ...candidates]
      assertValidGraph(task.rootNodeId, graph)
      const proposed = candidates.map((node) => {
        const parent = graph.find(({ id }) => id === node.parentNodeId)
        const scope = node.scopePath ?? parent?.scopePath
        if ((node.worktreeId || parent?.worktreeId) && node.check?.command) {
          throw new Error('Worktree nodes require file-based verification')
        }
        if (parent?.scopePath && scope && !containsScope(parent.scopePath, scope)) throw new Error('Node cannot expand parent scope')
        assertCheckInScope(node.check, scope)
        return { ...node, ...(scope ? { scopePath: scope } : {}),
          ...(parent?.worktreeId ? { worktreeId: parent.worktreeId } : {}) }
      })
      const version = task.planVersion + 1
      this.#save({ ...task, nodes: [...(task.nodes ?? []), ...proposed], planVersion: version })
      this.#event(task, 'task.plan_changed', {
        version,
        nodes: proposed.map(({ id, parentNodeId, dependencies, role, access }) => ({ id, parentNodeId, dependencies, role, access })),
      }, requestId)
      return proposed
    })
  }

  replanNode(taskId: string, requestId: string, expectedVersion: number, nodeId: string, update: NodeReplan): WorkerNode {
    return this.#command(requestId, ['replanNode', taskId, expectedVersion, nodeId, update], () => {
      const task = this.get(taskId)
      this.#assertPlanning(task, expectedVersion)
      const nodes = allNodes(task)
      const previous = task.nodes?.find(({ id }) => id === nodeId)
      if (!previous || (previous.status !== 'ready' && previous.status !== 'failed')) throw new Error('Node cannot be replanned')
      if (this.operations(taskId).some(({ taskNodeId, effect }) => taskNodeId === nodeId && effect === 'write')) {
        throw new Error('Node with a previous write attempt cannot be replanned')
      }
      if (previous.replans) throw new Error('Node replan budget exhausted')
      if (!update || typeof update !== 'object' || Array.isArray(update) ||
        Object.keys(update).some((key) => !['goal', 'dependencies', 'check'].includes(key))) throw new Error('Invalid node replan')
      if (nodes.some((node) => node.parentNodeId === nodeId && node.status === 'running')) throw new Error('Node has running children')
      const check = update.check !== undefined ? verificationCheck(update.check) : previous.check
      if (previous.worktreeId && check?.command) throw new Error('Worktree nodes require file-based verification')
      if (check?.command && (task.workspaceAccess !== 'trusted' || previous.access !== 'write')) {
        throw new Error('Command verification requires trusted workspace access and a write node')
      }
      assertCheckInScope(check, previous.scopePath)
      const replan: WorkerNode = {
        ...previous,
        goal: update.goal !== undefined ? checkText(update.goal, 'worker goal', 8000) : previous.goal,
        ...(check ? { check } : {}),
        dependencies: update.dependencies !== undefined ? nodeDependencies(update.dependencies) : previous.dependencies,
        status: 'ready', replans: 1,
      }
      delete replan.attemptId
      delete replan.result
      delete replan.verification
      assertValidGraph(task.rootNodeId, nodes.map((node) => node.id === nodeId ? replan : node))
      const version = task.planVersion + 1
      this.#save({ ...changeNode(task, replan), planVersion: version })
      this.#event(task, 'task.plan_changed', { version, replannedNodeId: nodeId, dependencies: replan.dependencies }, requestId)
      return replan
    })
  }

  blocksToolWork(taskId: string, managedOwner?: string, worktreeId?: string): boolean {
    return this.operations(taskId).some(({ effect, status, managed, agentRunId, worktreeId: operationWorktree }) =>
      effect === 'write' && (status === 'unknown_effect' ||
        (status === 'started' && !separateWorktrees(worktreeId, operationWorktree) &&
          !(managed && managedOwner && agentRunId === managedOwner))))
  }

  #nodeRunCapacity(task: TaskSnapshot): number {
    return MAX_NODE_RUNS - this.attempts(task.id).filter(({ nodeId }) => nodeId !== task.rootNodeId).length
  }

  #canStartNode(task: TaskSnapshot, node: WorkerNode, nodes: WorkerNode[], active: WorkerNode[], suspendParent: boolean): boolean {
    if (node.status !== 'ready' || active.length >= MAX_CONCURRENT_NODES ||
      node.dependencies.some((id) => nodes.find((other) => other.id === id)?.status !== 'succeeded')) return false
    const parent = active.find(({ id }) => id === node.parentNodeId)
    if (node.parentNodeId !== task.rootNodeId && (!parent || parent.suspendedFor)) return false
    if (node.role === 'team' && (active.filter(({ role }) => role === 'team').length >= MAX_CONCURRENT_TEAMS ||
      active.some(({ teamKey }) => teamKey === node.teamKey))) return false
    const scheduled = [...active, node]
    const teamsWithoutChildren = scheduled.filter((agent) =>
      agent.role === 'team' && !scheduled.some(({ parentNodeId }) => parentNodeId === agent.id)).length
    if (scheduled.length + teamsWithoutChildren > MAX_CONCURRENT_NODES) return false
    return active.every(other => separateWorktrees(node.worktreeId, other.worktreeId) ||
      (node.access !== 'write' && (other.access !== 'write' || (suspendParent && parent === other))))
  }

  runnableNodes(taskId: string, parentNodeId?: string): WorkerNode[] {
    const task = this.get(taskId)
    if (task.status !== 'running') return []
    const nodes = allNodes(task)
    const active = nodes.filter(({ status }) => status === 'running')
    const parentId = parentNodeId ?? task.rootNodeId
    const remaining = this.#nodeRunCapacity(task)
    const runnable: WorkerNode[] = []
    for (const node of nodes) {
      if (runnable.length >= remaining) break
      if (node.parentNodeId !== parentId ||
        this.blocksToolWork(taskId, undefined, node.worktreeId) ||
        !this.#canStartNode(task, node, nodes, active, parentNodeId !== undefined)) continue
      runnable.push(node)
      active.push(node)
      // A writing Team can yield to one child at a time.
      if (active.some((other) => other.id === parentId && other.access === 'write')) break
    }
    return runnable
  }

  startWorker(taskId: string, nodeId: string, options: { suspendParent?: boolean } = {}): string {
    return this.#db.transaction(() => {
      const task = this.get(taskId)
      const nodes = allNodes(task)
      const node = nodes.find(({ id }) => id === nodeId)
      const active = nodes.filter(({ status }) => status === 'running')
      if (task.status !== 'running' || !node || this.blocksToolWork(taskId, undefined, node.worktreeId) || this.#nodeRunCapacity(task) <= 0 ||
        !this.#canStartNode(task, node, nodes, active, options.suspendParent === true)) {
        throw new Error('Worker node is not runnable')
      }
      const id = randomUUID()
      const attempt: Attempt = {
        schemaVersion: 1, id, taskId, taskRunId: task.taskRunId, nodeId,
        startedAt: new Date().toISOString(), status: 'running',
      }
      const running: WorkerNode = { ...node, attemptId: id, status: 'running' }
      const parent = active.find((other) => other.id === node.parentNodeId && other.access === 'write')
      const next = parent ? changeNode(task, { ...parent, suspendedFor: nodeId }) : task
      this.#save(changeNode(next, running))
      this.#db.put('attempts', id, attempt)
      this.#nodeEvent(task, running, 'task.node_started', {
        parentNodeId: node.parentNodeId, role: node.role ?? 'worker', worktreeId: node.worktreeId,
      })
      return id
    })
  }

  #nodeEvent(task: TaskSnapshot, node: WorkerNode, type: string, payload: Record<string, unknown>): void {
    this.#db.append({
      taskId: task.id, taskRunId: task.taskRunId, taskNodeId: node.id, taskAttemptId: node.attemptId, type, payload,
    })
  }

  settleWorker(taskId: string, nodeId: string, result?: WorkerResult, verification?: VerificationResult,
    expectedAttemptId?: string): WorkerNode | undefined {
    return this.#db.transaction(() => {
      const task = this.get(taskId)
      const nodes = allNodes(task)
      const node = nodes.find(({ id }) => id === nodeId)
      if (!node || node.status !== 'running' || (expectedAttemptId !== undefined && node.attemptId !== expectedAttemptId)) return
      const children = nodes.filter(({ parentNodeId }) => parentNodeId === nodeId)
      if (children.some(({ status }) => status === 'running')) throw new Error('Cannot settle a node with active children')
      const legacy = task.worker?.id === nodeId
      const receipts = legacy ? [] : this.operations(taskId).filter(({ attemptId }) => attemptId === node.attemptId)
      const interruption = result === undefined ? interruptedWrite(receipts) : undefined
      let accepted = result ?? interruption?.result
      if (interruption) verification = interruption.verification
      if (!legacy && result?.resultStatus === 'succeeded') {
        const finished = receipts.every(({ status }) => status !== 'started' && status !== 'unknown_effect')
        const toolsVerified = receipts.some(({ id, status }) => status === 'succeeded' && result.evidenceRefs.includes(id))
        const childrenVerified = children.every(({ status }) => status === 'succeeded')
        const checkVerified = node.check ? verification?.passed === true : toolsVerified || (children.length > 0 && childrenVerified)
        const passed = finished && childrenVerified && checkVerified && Boolean(result.summary.trim())
        verification = {
          passed,
          evidence: !finished ? 'node_unsettled_operations' : !childrenVerified ? 'node_child_verification_failed'
            : node.check ? verification?.evidence ?? 'node_check_unavailable'
            : toolsVerified ? 'node_verified_tool_receipt' : passed ? 'node_verified_children' : 'node_missing_evidence',
        }
        if (!passed) accepted = { ...result, resultStatus: 'failed', remainingRisks: [...result.remainingRisks, verification.evidence] }
      }
      const settled: WorkerNode = { ...node, status: accepted?.resultStatus ?? 'ready', result: accepted, verification }
      const parent = nodes.find(({ suspendedFor }) => suspendedFor === nodeId)
      const next = parent ? changeNode(task, { ...parent, suspendedFor: undefined }) : task
      this.#save(changeNode(next, settled))
      const attemptStatus = interruption?.unknown ? 'unknown_effect' : result === undefined ? 'interrupted'
        : accepted?.resultStatus ?? 'interrupted'
      this.#finishAttempt(node.attemptId, attemptStatus, interruption?.unknown ? 'unknown_effect' : undefined)
      this.#nodeEvent(task, settled, legacy ? 'task.worker_settled' : 'task.node_settled', {
        status: accepted?.resultStatus ?? 'interrupted',
        ...(!legacy ? { attemptStatus } : {}),
        ...(!legacy && accepted ? { evidenceRefs: accepted.evidenceRefs, verification } : {}),
      })
      return settled
    })
  }

  beginTool(taskId: string, event: EventDraft, id: string, tool: string, effect: Operation['effect'], target?: string,
    phase?: 'verification', policy?: { deferred?: boolean; whileActive?: boolean }): void {
    this.#db.transaction(() => {
      const task = this.get(taskId)
      const expected = phase === 'verification' ? 'verifying' : 'running'
      const nodeId = event.taskNodeId ?? task.rootNodeId
      const active = allNodes(task).filter(({ status }) => status === 'running')
      const node = active.find(({ id: current }) => current === nodeId)
      if (task.status !== expected || event.taskId !== taskId || !task.attemptId ||
        this.blocksToolWork(taskId, policy?.whileActive ? event.agentRunId : undefined, node?.worktreeId)) {
        throw new Error('Task is not accepting tool work')
      }
      if (this.#db.get('operations', id)) throw new Error('Duplicate tool call')
      if (nodeId !== task.rootNodeId && (!node || phase === 'verification' || node.suspendedFor)) {
        throw new Error('Node is not accepting tool work')
      }
      const attemptId = node?.attemptId ?? task.attemptId
      if (event.taskAttemptId !== undefined && event.taskAttemptId !== attemptId) throw new Error('Tool attempt is stale')
      if (effect === 'write' && ((node && node.access !== 'write') || task.workspaceAccess === 'read')) {
        throw new Error('Task scope denies writes')
      }
      if (phase === 'verification' && effect === 'write' && task.workspaceAccess !== 'trusted') {
        throw new Error('Command verification requires trusted workspace access')
      }
      if (active.some((other) => other.id !== nodeId && !separateWorktrees(node?.worktreeId, other.worktreeId) && (effect === 'write' ||
        (other.access === 'write' && other.suspendedFor !== nodeId)))) {
        throw new Error('Concurrent workspace access conflicts with a write')
      }
      const operation: Operation = {
        schemaVersion: 1, id, taskId, taskRunId: task.taskRunId, attemptId,
        agentRunId: event.agentRunId, agentId: event.agentId, sessionId: event.sessionId,
        taskNodeId: nodeId, parentAgentRunId: event.parentAgentRunId,
        tool, effect, target, status: 'started', ...(policy?.deferred ? { managed: true } : {}),
        ...(node?.worktreeId ? { worktreeId: node.worktreeId } : {}),
      }
      this.#db.put('operations', id, operation)
      this.#db.append({ ...event, taskRunId: task.taskRunId, taskAttemptId: attemptId, taskNodeId: nodeId,
        type: 'tool.started', payload: { id, tool, effect, ...(policy?.deferred ? { managed: true } : {}) } })
    })
  }

  finishTool(event: EventDraft, id: string, status: Exclude<Operation['status'], 'started'>): void {
    this.#db.transaction(() => {
      const operation = this.#db.get<Operation>('operations', id)
      if (!operation || operation.taskId !== event.taskId || operation.status !== 'started' ||
        (event.taskAttemptId !== undefined && event.taskAttemptId !== operation.attemptId) ||
        (event.agentRunId !== undefined && event.agentRunId !== operation.agentRunId)) throw new Error('Tool receipt is not open')
      this.#db.put('operations', id, { ...operation, status })
      this.#db.append({ ...event, taskRunId: operation.taskRunId, taskAttemptId: operation.attemptId, taskNodeId: operation.taskNodeId,
        type: 'tool.finished', payload: { id, tool: operation.tool, status } })
    })
  }

  beginVerification(taskId: string): void {
    this.#db.transaction(() => { this.#transition(this.get(taskId), 'verifying') })
  }

  auditToolApproval(event: EventDraft, id: string, tool: string, approved: boolean): void {
    this.#db.transaction(() => { this.#db.append({ ...event, type: 'tool.approval_resolved', payload: { id, tool, approved } }) })
  }

  continueExecution(taskId: string): void {
    this.#db.transaction(() => { this.#transition(this.get(taskId), 'running') })
  }

  verify(taskId: string, verification: VerificationResult): TaskSnapshot {
    return this.#db.transaction(() => {
      const task = this.get(taskId)
      if (task.status !== 'verifying') throw new Error('Invalid task transition from ' + task.status + ' to verified')
      const nodes = allNodes(task)
      if (nodes.some(({ status }) => status === 'running') ||
        (verification.passed && nodes.some(({ status }) => status !== 'succeeded')) ||
        (!verification.passed && task.worker?.status === 'ready')) {
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
      const operations = this.operations(taskId)
      const unknown = operations.filter((operation) =>
        operation.effect === 'write' && (operation.status === 'started' || operation.status === 'unknown_effect'))
      for (const operation of operations) {
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
      for (const node of allNodes(task)) {
        const unresolved = unknown.some(({ attemptId }) => attemptId === node.attemptId)
        if (node.status !== 'running' && !unresolved) continue
        const legacy = task.worker?.id === node.id
        const interruption = legacy ? undefined : interruptedWrite(operations.filter(({ attemptId }) => attemptId === node.attemptId))
        const status = unresolved ? 'unknown_effect' : 'interrupted'
        this.#finishAttempt(node.attemptId, status, unresolved ? 'unknown_effect' : reason)
        if (unresolved && node.verification?.evidence === 'node_unknown_effect') continue
        task = changeNode(task, {
          ...node, status: interruption || unresolved ? 'failed' : 'ready', suspendedFor: undefined,
          ...(interruption ? { result: interruption.result, verification: interruption.verification } : {}),
        })
        this.#nodeEvent(task, node, legacy ? 'task.worker_settled' : 'task.node_settled', {
          status: interruption ? 'failed' : status,
          ...(!legacy ? { attemptStatus: status } : {}),
          ...(interruption ? { evidenceRefs: interruption.result.evidenceRefs, verification: interruption.verification } : {}),
        })
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
    if (attempt && (attempt.status === 'running' || (status === 'unknown_effect' && attempt.status !== status))) {
      this.#db.put('attempts', attempt.id, { ...attempt, status, reason, finishedAt: new Date().toISOString() })
    }
  }
}
