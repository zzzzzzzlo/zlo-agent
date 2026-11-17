import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

const fileWriteTools = new Set(['create_text_file', 'edit_text_file', 'delete_file', 'apply_patch'])

let lastTaskMs = 0
let lastTaskSeq = 0

/** Monotonic RFC 9562 UUIDv7 so task records sort in strict FIFO creation order. */
function monotonicTaskId(): string {
  const now = Date.now()
  if (now > lastTaskMs) {
    lastTaskMs = now
    lastTaskSeq = 0
  } else {
    lastTaskSeq++
    if (lastTaskSeq > 0xfff) {
      lastTaskMs++
      lastTaskSeq = 0
    }
  }
  const bytes = randomBytes(16)
  const ts = BigInt(lastTaskMs)
  bytes[0] = Number((ts >> 40n) & 0xffn)
  bytes[1] = Number((ts >> 32n) & 0xffn)
  bytes[2] = Number((ts >> 24n) & 0xffn)
  bytes[3] = Number((ts >> 16n) & 0xffn)
  bytes[4] = Number((ts >> 8n) & 0xffn)
  bytes[5] = Number(ts & 0xffn)
  bytes[6] = 0x70 | ((lastTaskSeq >> 8) & 0x0f)
  bytes[7] = lastTaskSeq & 0xff
  bytes[8] = 0x80 | (bytes[8]! & 0x3f)
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
import type { ApprovalKind } from '../../shared/contracts/tool-approval.ts'
import { normalizeVerification, projectCommands } from './contracts/domain.ts'
import type { EndReason, EventDraft, ModelRoute, TaskStatus, ToolFailureReason, VerificationCheck, VerificationResult, WorkspaceAccess } from './contracts/domain.ts'
import type { LocalStore } from './store.ts'

export type { EndReason, TaskStatus, ToolFailureReason } from './contracts/domain.ts'
export interface WorkerResult {
  resultStatus: 'succeeded' | 'failed'
  executionStatus?: 'completed' | 'failed'
  summary: string
  artifactRefs: string[]
  evidenceRefs: string[]
  remainingRisks: string[]
}
export interface NodeBudget {
  requests?: number
  timeMs?: number
}
export interface NodeFailureRecord {
  attemptId?: string
  failedAt: string
  summary: string
  remainingRisks: string[]
  verificationEvidence?: string
  resolvedByAttemptId?: string
  resolution?: string
}
export interface NodeSummaryDigest {
  schemaVersion: 1
  whatCompleted: string
  artifacts: string[]
  verified: {
    passed: boolean
    verdict?: VerificationResult['verdict']
    basis?: VerificationResult['basis']
    evidence: string
  }
  conclusion: string
  remainingRisks: string[]
  resolvedFailures?: NodeFailureRecord[]
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
  access?: WorkspaceAccess
  scopePath?: string
  tools?: string[]
  disallowedTools?: string[]
  budget?: NodeBudget
  worktreeId?: string
  check?: VerificationCheck
  route?: ModelRoute
  verification?: VerificationResult
  replans?: number
  suspendedFor?: string
  suspendedForIds?: string[]
  archivedAt?: string
  archiveRef?: string
  digest?: NodeSummaryDigest
  priorFailures?: NodeFailureRecord[]
}
export interface TeamStageSummary {
  schemaVersion: 1
  id: string
  taskId: string
  teamNodeId: string
  teamKey?: string
  goal: string
  status: 'active' | 'succeeded' | 'failed'
  updatedAt: string
  childCount: number
  succeededCount: number
  failedCount: number
  completedWork: string[]
  technicalDecisions: string[]
  interfaceContracts: string[]
  resolvedFailures: { nodeId: string; failure: string; resolution?: string }[]
  remainingRisks: string[]
  nodeRefs: string[]
  artifactRefs: string[]
  evidenceRefs: string[]
}
export interface ArchivedTaskNodeRecord {
  schemaVersion: 1
  id: string
  taskId: string
  nodeId: string
  ordinal: number
  archivedAt: string
  encoding: 'json' | 'deflate-base64'
  payload: string
  attemptIds: string[]
  operationIds: string[]
}
export interface NodeDetailView {
  node: WorkerNode
  archived: boolean
  archiveRef?: string
  archivedAt?: string
  digest?: NodeSummaryDigest
  priorFailures?: NodeFailureRecord[]
  attempts: Attempt[]
  operations: Operation[]
}
export interface EvidenceResolution {
  evidenceRef: string
  taskId: string
  nodeId?: string
  nodeGoal?: string
  nodeStatus?: WorkerNode['status']
  nodeArchived?: boolean
  attemptId?: string
  operation?: Operation
  archive?: { id: string; archivedAt: string; nodeId: string }
}
export interface TaskEngineOptions {
  maxPlanNodes?: number
  maxProposalBatch?: number
  maxDependenciesPerNode?: number
  maxNodeRuns?: number
  maxConcurrentNodes?: number
  maxConcurrentTeams?: number
  archiveThreshold?: number
  archiveBatchSize?: number
}
export interface NodeProposal {
  ref: string
  goal: string
  parentNodeId?: string
  dependencies?: string[]
  role?: 'team' | 'worker'
  teamKey?: string
  access?: WorkspaceAccess
  scopePath?: string
  tools?: string[]
  disallowedTools?: string[]
  budget?: NodeBudget
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
  reconciliationBlock?: 'checkpoint_error' | 'stop_timeout'
  stopIntent?: { requestId: string; source: 'user' | 'shutdown' }
  instructions: { id: string; text: string; delivered: boolean }[]
  route?: ModelRoute
  planVersion: number
  nodeSeq?: number
  nodeCount?: number
  replannedCount?: number
  archivedNodeCount?: number
  legacyWorkerId?: string
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
export type FilePostcondition =
  | { kind: 'created_text'; workspaceIdentity: string; digest: string }
  | { kind: 'edited_text'; workspaceIdentity: string; beforeDigest: string; afterDigest: string }
  | { kind: 'deleted_file'; workspaceIdentity: string; fileIdentity: string }
  | { kind: 'patched_files'; workspaceIdentity: string; files: { path: string; beforeDigest: string; afterDigest: string }[] }
  | { kind: 'git_branch'; workspaceIdentity: string; branch: string; expectedCommit: string }
  | { kind: 'git_commit'; workspaceIdentity: string; headBefore?: string }

interface OperationReconciliation {
  status: 'verified' | 'unresolved' | 'acknowledged'
  evidence: string
  previousEvidence?: string
  changedEntries?: number
  truncated?: boolean
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
  callFingerprint?: string
  changedPaths?: string[]
  managed?: boolean
  processId?: number
  worktreeId?: string
  filePostcondition?: FilePostcondition
  reconciliation?: OperationReconciliation
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

const DEFAULT_MAX_PLAN_NODES = 10_000
const DEFAULT_MAX_PROPOSAL_BATCH = 2_000
const DEFAULT_MAX_DEPENDENCIES = 64
const DEFAULT_MAX_NODE_RUNS = 20_000
const DEFAULT_MAX_CONCURRENT_NODES = 4
const DEFAULT_MAX_CONCURRENT_TEAMS = 2
const DEFAULT_ARCHIVE_THRESHOLD = 64
const DEFAULT_ARCHIVE_BATCH_SIZE = 256
const TASK_NODE_NAMESPACE = 'task-nodes'
const TASK_NODE_ARCHIVE_NAMESPACE = 'task-node-archives'
const TASK_TEAM_SUMMARY_NAMESPACE = 'task-team-summaries'
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
  needs_reconciliation: ['stopped', 'failed'],
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
function confirmedCheck(result?: VerificationResult): boolean {
  return result?.passed === true && (result.verdict === undefined || result.verdict === 'verified')
}
function normalizeNode(node: WorkerNode): WorkerNode {
  const verification = node.verification ?? (node.status === 'succeeded'
    ? { passed: false, verdict: 'unverified', basis: 'none', evidence: 'legacy_handoff_without_check' } as const
    : undefined)
  return verification ? { ...node, verification: normalizeVerification(verification) } : node
}
function normalizeTask(task: TaskSnapshot): TaskSnapshot {
  return {
    ...task,
    ...(task.verification ? { verification: normalizeVerification(task.verification) } : {}),
    ...(task.worker ? { worker: normalizeNode(task.worker) } : {}),
    ...(task.nodes ? { nodes: task.nodes.map(normalizeNode) } : {}),
  }
}
function separateWorktrees(left?: string, right?: string): boolean {
  return Boolean(left && right && left !== right)
}
const nodeAccessRank: Record<WorkspaceAccess, number> = { read: 0, write: 1, trusted: 2 }
const canWrite = (access?: WorkspaceAccess) => access === 'write' || access === 'trusted'
const nodeBudgetLimits = { requests: 512, timeMs: 3_600_000 } as const

function planBudget(value: NodeBudget): NodeBudget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid node budget')
  const budget: NodeBudget = {}
  for (const [key, count] of Object.entries(value)) {
    if (key === 'tokens') continue // Older callers may still send a retired limit.
    if (!Object.hasOwn(nodeBudgetLimits, key) || !Number.isSafeInteger(count) || count < 1 || count > nodeBudgetLimits[key as keyof NodeBudget]) {
      throw new Error('Invalid node budget')
    }
    budget[key as keyof NodeBudget] = count
  }
  return budget
}

function planTools(value: string[]): string[] {
  if (!Array.isArray(value) || value.length > 128 || new Set(value).size !== value.length ||
    value.some(name => typeof name !== 'string' || !/^[a-z][a-z_0-9]{0,63}$/u.test(name))) throw new Error('Invalid node tool grant')
  return [...value].sort()
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
function nodeDependencies(value: string[] = [], resolve: (id: string) => string = (id) => id, maxDeps = DEFAULT_MAX_DEPENDENCIES): string[] {
  if (!Array.isArray(value) || value.length > maxDeps ||
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
export function isUnresolvedEffect(operation: Operation): boolean {
  return operation.status === 'unknown_effect' && operation.reconciliation?.status !== 'acknowledged'
}
function interruptedWrite(operations: Operation[]) {
  const writes = operations.filter(({ effect }) => effect === 'write')
  if (!writes.length) return undefined
  const unknown = writes.some(operation => operation.status === 'started' || isUnresolvedEffect(operation))
  const evidence = unknown ? 'node_unknown_effect' : 'node_interrupted_after_write'
  const result: WorkerResult = {
    resultStatus: 'failed',
    summary: unknown ? 'A write needs reconciliation.' : 'A write was recorded before the node was interrupted.',
    artifactRefs: [],
    evidenceRefs: writes.filter(({ status }) => status === 'succeeded' || status === 'failed').map(({ id }) => id),
    remainingRisks: [evidence],
  }
  return { unknown, result, verification: { passed: false, verdict: 'failed', basis: 'handoff', evidence } as const }
}
function clipText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return normalized.slice(0, Math.max(0, maxChars - 3)) + '...'
}

function assertNodeConstraints(rootNodeId: string, node: WorkerNode, getNode: (id: string) => WorkerNode | undefined): void {
  if (node.parentNodeId !== rootNodeId) {
    const parent = getNode(node.parentNodeId)
    if (parent?.role !== 'team' || parent.parentNodeId !== rootNodeId || node.role === 'team') {
      throw new Error('Invalid parent scope or depth')
    }
    if (nodeAccessRank[node.access ?? 'read'] > nodeAccessRank[parent.access ?? 'read']) {
      throw new Error('Node cannot expand parent access')
    }
    if (node.tools?.some(name => parent.tools !== undefined && !parent.tools.includes(name))) {
      throw new Error('Node cannot expand parent tools')
    }
    for (const key of Object.keys(nodeBudgetLimits) as (keyof NodeBudget)[]) {
      if ((node.budget?.[key] ?? 0) > (parent.budget?.[key] ?? Infinity)) {
        throw new Error('Node cannot expand parent budget')
      }
    }
  }
}

function assertIncrementalProposalGraph(
  rootNodeId: string,
  existingById: ReadonlyMap<string, WorkerNode>,
  candidates: readonly WorkerNode[],
): void {
  const candidateById = new Map(candidates.map(node => [node.id, node]))
  const getNode = (id: string) => candidateById.get(id) ?? existingById.get(id)
  const visiting = new Set<string>()
  const visited = new Set<string>()
  function visit(node: WorkerNode): void {
    if (visited.has(node.id)) return
    if (visiting.has(node.id)) throw new Error('Cyclic node dependencies')
    visiting.add(node.id)
    assertNodeConstraints(rootNodeId, node, getNode)
    for (const depId of node.dependencies) {
      const dependency = getNode(depId)
      if (!dependency || dependency.parentNodeId !== node.parentNodeId) {
        throw new Error('Node dependency must belong to the same task and parent scope')
      }
      // Existing nodes in SQLite are already validated acyclic and cannot depend on brand-new candidate UUIDs.
      if (candidateById.has(depId)) visit(dependency)
    }
    visiting.delete(node.id)
    visited.add(node.id)
  }
  for (const candidate of candidates) visit(candidate)
}

function assertReplanAcyclic(
  rootNodeId: string,
  existingById: ReadonlyMap<string, WorkerNode>,
  replan: WorkerNode,
): void {
  const getNode = (id: string) => (id === replan.id ? replan : existingById.get(id))
  assertNodeConstraints(rootNodeId, replan, getNode)
  const visiting = new Set<string>([replan.id])
  const visited = new Set<string>()
  function visit(depId: string, expectedParent: string): void {
    const dep = getNode(depId)
    if (!dep || dep.parentNodeId !== expectedParent) {
      throw new Error('Node dependency must belong to the same task and parent scope')
    }
    if (visiting.has(depId)) throw new Error('Cyclic node dependencies')
    if (visited.has(depId)) return
    visiting.add(depId)
    for (const nextId of dep.dependencies) visit(nextId, dep.parentNodeId)
    visiting.delete(depId)
    visited.add(depId)
  }
  for (const depId of replan.dependencies) visit(depId, replan.parentNodeId)
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

export interface StoredTaskNode extends WorkerNode {
  taskId: string
  ordinal: number
  isLegacyWorker?: boolean
}

interface TaskGraphIndex {
  taskId: string
  nodesById: Map<string, StoredTaskNode>
  orderedIds: string[]
  readyIds: Set<string>
  activeIds: Set<string>
  unarchivedIds: Set<string>
  unarchivedSettledIds: Set<string>
  nonSucceededIds: Set<string>
  childrenByParent: Map<string, Set<string>>
  dependentsByNode: Map<string, Set<string>>
  childAttemptCount: number
  activeWriteOps: Map<string, Operation>
  unresolvedWriteOps: Map<string, Operation>
  unknownWriteOps: Map<string, Operation>
  hasReplanned: boolean
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key)
  if (!set) {
    set = new Set<string>()
    map.set(key, set)
  }
  set.add(value)
}

function encodeArchivePayload(node: WorkerNode): { encoding: 'json' | 'deflate-base64'; payload: string } {
  const json = JSON.stringify(node)
  if (json.length <= 128) return { encoding: 'json', payload: json }
  return {
    encoding: 'deflate-base64',
    payload: deflateRawSync(Buffer.from(json, 'utf8')).toString('base64'),
  }
}

function decodeArchivePayload(record: ArchivedTaskNodeRecord): WorkerNode {
  const raw = record.encoding === 'deflate-base64'
    ? inflateRawSync(Buffer.from(record.payload, 'base64')).toString('utf8')
    : record.payload
  return normalizeNode(JSON.parse(raw) as WorkerNode)
}

export class TaskEngine {
  readonly #db: LocalStore
  readonly #maxPlanNodes: number
  readonly #maxProposalBatch: number
  readonly #maxDependenciesPerNode: number
  readonly #maxNodeRuns: number
  readonly #maxConcurrentNodes: number
  readonly #maxConcurrentTeams: number
  readonly #archiveThreshold: number
  readonly #archiveBatchSize: number
  readonly #graphs = new Map<string, TaskGraphIndex>()

  constructor(db: LocalStore, options: TaskEngineOptions = {}) {
    this.#db = db
    this.#maxPlanNodes = options.maxPlanNodes && Number.isSafeInteger(options.maxPlanNodes) && options.maxPlanNodes >= 1
      ? options.maxPlanNodes : DEFAULT_MAX_PLAN_NODES
    this.#maxProposalBatch = options.maxProposalBatch && Number.isSafeInteger(options.maxProposalBatch) && options.maxProposalBatch >= 1
      ? options.maxProposalBatch : DEFAULT_MAX_PROPOSAL_BATCH
    this.#maxDependenciesPerNode = options.maxDependenciesPerNode && Number.isSafeInteger(options.maxDependenciesPerNode) && options.maxDependenciesPerNode >= 1
      ? options.maxDependenciesPerNode : Math.max(0, Math.min(this.#maxPlanNodes - 1, DEFAULT_MAX_DEPENDENCIES))
    this.#maxNodeRuns = options.maxNodeRuns && Number.isSafeInteger(options.maxNodeRuns) && options.maxNodeRuns >= 1
      ? options.maxNodeRuns : DEFAULT_MAX_NODE_RUNS
    this.#maxConcurrentNodes = options.maxConcurrentNodes && Number.isSafeInteger(options.maxConcurrentNodes) && options.maxConcurrentNodes >= 1
      ? options.maxConcurrentNodes : DEFAULT_MAX_CONCURRENT_NODES
    this.#maxConcurrentTeams = options.maxConcurrentTeams && Number.isSafeInteger(options.maxConcurrentTeams) && options.maxConcurrentTeams >= 1
      ? options.maxConcurrentTeams : DEFAULT_MAX_CONCURRENT_TEAMS
    this.#archiveThreshold = options.archiveThreshold && Number.isSafeInteger(options.archiveThreshold) && options.archiveThreshold >= 1
      ? options.archiveThreshold : DEFAULT_ARCHIVE_THRESHOLD
    this.#archiveBatchSize = options.archiveBatchSize && Number.isSafeInteger(options.archiveBatchSize) && options.archiveBatchSize >= 1
      ? options.archiveBatchSize : DEFAULT_ARCHIVE_BATCH_SIZE

    const rawTasks = this.#db.list<TaskSnapshot>('tasks')
    const legacyRunTasks = rawTasks.filter(task => !task.taskRunId)
    const legacyEmbeddedTasks = rawTasks.filter(task => task.worker !== undefined || task.nodes !== undefined)
    if (legacyRunTasks.length || legacyEmbeddedTasks.length) {
      this.#db.transaction(() => {
        const runs = new Map(legacyRunTasks.map(task => [task.id, randomUUID()]))
        if (runs.size) {
          for (const attempt of this.#db.list<Attempt>('attempts')) {
            const taskRunId = runs.get(attempt.taskId)
            if (taskRunId) this.#db.put('attempts', attempt.id, { ...attempt, taskRunId })
          }
          for (const operation of this.#db.list<Operation>('operations')) {
            const taskRunId = runs.get(operation.taskId)
            if (taskRunId) this.#db.put('operations', operation.id, { ...operation, taskRunId })
          }
        }
        const toSave = new Set<string>([...runs.keys(), ...legacyEmbeddedTasks.map(t => t.id)])
        for (const task of rawTasks) {
          if (!toSave.has(task.id)) continue
          const taskRunId = task.taskRunId ?? runs.get(task.id)!
          const embedded = allNodes(task)
          let ordinal = task.nodeSeq ?? 0
          let replannedCount = task.replannedCount ?? 0
          const existingStored = this.#db.taskNodes<StoredTaskNode>(task.id)
          const existingIds = new Set(existingStored.map(node => node.id))
          if (embedded.length) {
            for (const rawNode of embedded) {
              const node = normalizeNode(rawNode)
              if (existingIds.has(node.id)) continue
              ordinal++
              if ((node.replans ?? 0) > 0) replannedCount++
              const isLegacyWorker = task.worker?.id === node.id
              const stored: StoredTaskNode = {
                ...node,
                taskId: task.id,
                ordinal,
                ...(isLegacyWorker ? { isLegacyWorker: true } : {}),
                ...(node.suspendedFor ? { suspendedForIds: [node.suspendedFor] } : {}),
              }
              this.#db.put(TASK_NODE_NAMESPACE, this.#nodeRecordId(task.id, node.id), stored)
            }
          }
          const finalCount = existingStored.length + embedded.filter(n => !existingIds.has(n.id)).length
          const meta: TaskSnapshot = {
            ...task,
            taskRunId,
            nodeSeq: Math.max(ordinal, finalCount),
            nodeCount: Math.max(task.nodeCount ?? 0, finalCount),
            replannedCount: Math.max(replannedCount, existingStored.filter(n => (n.replans ?? 0) > 0).length),
            ...(task.worker ? { legacyWorkerId: task.worker.id } : task.legacyWorkerId ? { legacyWorkerId: task.legacyWorkerId } : {}),
          }
          delete meta.worker
          delete meta.nodes
          this.#saveMeta(meta)
        }
      })
    }
  }

  get limits() {
    return {
      maxPlanNodes: this.#maxPlanNodes,
      maxProposalBatch: this.#maxProposalBatch,
      maxDependenciesPerNode: this.#maxDependenciesPerNode,
      maxNodeRuns: this.#maxNodeRuns,
      maxConcurrentNodes: this.#maxConcurrentNodes,
      maxConcurrentTeams: this.#maxConcurrentTeams,
      archiveThreshold: this.#archiveThreshold,
      archiveBatchSize: this.#archiveBatchSize,
    }
  }

  #nodeRecordId(taskId: string, nodeId: string): string {
    return `${taskId}:${nodeId}`
  }

  #toWorkerNode(stored: StoredTaskNode): WorkerNode {
    const {
      taskId: _taskId,
      ordinal: _ordinal,
      isLegacyWorker: _isLegacy,
      suspendedForIds,
      priorFailures: _priorFailures,
      archivedAt,
      archiveRef,
      digest,
      ...rest
    } = stored
    const normalized = normalizeNode(rest)
    if (suspendedForIds?.length) {
      normalized.suspendedFor = suspendedForIds[0]
      normalized.suspendedForIds = [...suspendedForIds]
    } else if (normalized.suspendedFor) {
      normalized.suspendedForIds = [normalized.suspendedFor]
    }
    if (archivedAt) normalized.archivedAt = archivedAt
    if (archiveRef) normalized.archiveRef = archiveRef
    if (archivedAt && digest) normalized.digest = digest
    return normalized
  }

  #getRawMeta(taskId: string): TaskSnapshot {
    const snapshot = this.#db.get<TaskSnapshot>('tasks', taskId)
    if (!snapshot) throw new Error('Task does not exist')
    return snapshot
  }

  #invalidateOnRollback(taskId: string): void {
    this.#db.onTransactionSettled(committed => {
      if (!committed) this.#graphs.delete(taskId)
    })
  }

  #graph(taskId: string, meta?: TaskSnapshot): TaskGraphIndex {
    const existing = this.#graphs.get(taskId)
    if (existing) {
      this.#graphs.delete(taskId)
      this.#graphs.set(taskId, existing)
      return existing
    }
    const task = meta ?? this.#getRawMeta(taskId)
    const nodes = this.#db.taskNodes<StoredTaskNode>(taskId)
    const graph: TaskGraphIndex = {
      taskId,
      nodesById: new Map(),
      orderedIds: [],
      readyIds: new Set(),
      activeIds: new Set(),
      unarchivedIds: new Set(),
      unarchivedSettledIds: new Set(),
      nonSucceededIds: new Set(),
      childrenByParent: new Map(),
      dependentsByNode: new Map(),
      childAttemptCount: this.#db.childAttemptCount(taskId, task.rootNodeId),
      activeWriteOps: new Map(),
      unresolvedWriteOps: new Map(),
      unknownWriteOps: new Map(),
      hasReplanned: (task.replannedCount ?? 0) > 0,
    }
    for (const rawNode of nodes) {
      const node = normalizeNode(rawNode) as StoredTaskNode
      this.#insertNodeIntoIndex(graph, node)
    }
    for (const op of this.#db.openWriteOperations<Operation>(taskId)) {
      if (op.status === 'started') graph.activeWriteOps.set(op.id, op)
      if (op.status === 'unknown_effect') graph.unknownWriteOps.set(op.id, op)
      if (isUnresolvedEffect(op)) graph.unresolvedWriteOps.set(op.id, op)
    }
    this.#graphs.set(taskId, graph)
    if (this.#graphs.size > 32) {
      for (const candidateId of this.#graphs.keys()) {
        if (this.#graphs.size <= 32) break
        const candidateMeta = this.#db.get<TaskSnapshot>('tasks', candidateId)
        if (!candidateMeta || (candidateMeta.status !== 'ready' && candidateMeta.status !== 'running' && candidateMeta.status !== 'verifying')) {
          this.#graphs.delete(candidateId)
        }
      }
      if (this.#graphs.size > 48) {
        const oldest = this.#graphs.keys().next().value
        if (oldest && oldest !== taskId) this.#graphs.delete(oldest)
      }
    }
    return graph
  }

  #insertNodeIntoIndex(graph: TaskGraphIndex, node: StoredTaskNode): void {
    graph.nodesById.set(node.id, node)
    graph.orderedIds.push(node.id)
    if (node.status === 'ready') graph.readyIds.add(node.id)
    if (node.status === 'running') graph.activeIds.add(node.id)
    if (node.status !== 'succeeded') graph.nonSucceededIds.add(node.id)
    if (!node.archivedAt) {
      graph.unarchivedIds.add(node.id)
      if (node.status === 'succeeded' || node.status === 'failed') {
        graph.unarchivedSettledIds.add(node.id)
      }
    }
    if ((node.replans ?? 0) > 0) graph.hasReplanned = true
    addToSetMap(graph.childrenByParent, node.parentNodeId, node.id)
    for (const depId of node.dependencies) {
      addToSetMap(graph.dependentsByNode, depId, node.id)
    }
  }

  #updateNodeInIndex(graph: TaskGraphIndex, previous: StoredTaskNode | undefined, next: StoredTaskNode): void {
    if (!previous) {
      this.#insertNodeIntoIndex(graph, next)
      return
    }
    graph.nodesById.set(next.id, next)
    if (next.status === 'ready') graph.readyIds.add(next.id)
    else graph.readyIds.delete(next.id)
    if (next.status === 'running') graph.activeIds.add(next.id)
    else graph.activeIds.delete(next.id)
    if (next.status !== 'succeeded') graph.nonSucceededIds.add(next.id)
    else graph.nonSucceededIds.delete(next.id)
    if (!next.archivedAt) {
      graph.unarchivedIds.add(next.id)
      if (next.status === 'succeeded' || next.status === 'failed') {
        graph.unarchivedSettledIds.add(next.id)
      } else {
        graph.unarchivedSettledIds.delete(next.id)
      }
    } else {
      graph.unarchivedIds.delete(next.id)
      graph.unarchivedSettledIds.delete(next.id)
    }
    if ((next.replans ?? 0) > 0) graph.hasReplanned = true
    if (previous.dependencies !== next.dependencies) {
      for (const depId of previous.dependencies) {
        if (!next.dependencies.includes(depId)) graph.dependentsByNode.get(depId)?.delete(next.id)
      }
      for (const depId of next.dependencies) {
        addToSetMap(graph.dependentsByNode, depId, next.id)
      }
    }
  }

  #putNode(graph: TaskGraphIndex, node: StoredTaskNode): void {
    this.#invalidateOnRollback(graph.taskId)
    const previous = graph.nodesById.get(node.id)
    this.#db.put(TASK_NODE_NAMESPACE, this.#nodeRecordId(graph.taskId, node.id), node)
    this.#updateNodeInIndex(graph, previous, node)
  }

  #hydrateTask(raw: TaskSnapshot, graph?: TaskGraphIndex): TaskSnapshot {
    const resolvedGraph = graph ?? this.#graph(raw.id, raw)
    let worker: WorkerNode | undefined
    const dagNodes: WorkerNode[] = []
    for (const id of resolvedGraph.orderedIds) {
      const stored = resolvedGraph.nodesById.get(id)!
      if (stored.isLegacyWorker || raw.legacyWorkerId === stored.id) {
        worker = this.#toWorkerNode(stored)
      } else {
        dagNodes.push(this.#toWorkerNode(stored))
      }
    }
    const base: TaskSnapshot = {
      ...raw,
      ...(raw.verification ? { verification: normalizeVerification(raw.verification) } : {}),
    }
    if (worker) base.worker = worker
    if (dagNodes.length) base.nodes = dagNodes
    return base
  }

  getMeta(taskId: string): TaskSnapshot {
    const raw = this.#getRawMeta(taskId)
    return raw.verification ? { ...raw, verification: normalizeVerification(raw.verification) } : { ...raw }
  }

  get(taskId: string): TaskSnapshot {
    const raw = this.#getRawMeta(taskId)
    return this.#hydrateTask(raw)
  }

  listMeta(): TaskSnapshot[] {
    return this.#db.list<TaskSnapshot>('tasks').map(raw =>
      raw.verification ? { ...raw, verification: normalizeVerification(raw.verification) } : { ...raw })
  }

  list(): TaskSnapshot[] { return this.#db.list<TaskSnapshot>('tasks').map(raw => this.#hydrateTask(raw)) }

  nextReady(): TaskSnapshot | undefined {
    const ready = this.#db.firstReadyTask<TaskSnapshot>()
    return ready ? this.#hydrateTask(ready) : undefined
  }

  listPageMeta(before: string | null, limit: number): TaskSnapshot[] {
    return this.#db.listBefore<TaskSnapshot>('tasks', before, limit).map(raw =>
      raw.verification ? { ...raw, verification: normalizeVerification(raw.verification) } : { ...raw })
  }

  listPage(before: string | null, limit: number): TaskSnapshot[] {
    return this.#db.listBefore<TaskSnapshot>('tasks', before, limit).map(raw => this.#hydrateTask(raw))
  }

  getNode(taskId: string, nodeId: string): WorkerNode | undefined {
    const cached = this.#graphs.get(taskId)?.nodesById.get(nodeId)
    if (cached) return this.#toWorkerNode(cached)
    const stored = this.#db.get<StoredTaskNode>(TASK_NODE_NAMESPACE, this.#nodeRecordId(taskId, nodeId))
    return stored ? this.#toWorkerNode(stored) : undefined
  }

  nodesByParent(taskId: string, parentNodeId: string, options: { includeArchived?: boolean } = {}): WorkerNode[] {
    this.#getRawMeta(taskId)
    const graph = this.#graphs.get(taskId)
    if (graph) {
      const ids = graph.childrenByParent.get(parentNodeId)
      if (!ids) return []
      const list: WorkerNode[] = []
      for (const id of ids) {
        const stored = graph.nodesById.get(id)
        if (!stored) continue
        if (options.includeArchived === false && stored.archivedAt) continue
        list.push(this.#toWorkerNode(stored))
      }
      return list
    }
    return this.#db.taskNodesByParent<StoredTaskNode>(taskId, parentNodeId, options).map(item => this.#toWorkerNode(item))
  }

  activeNodes(taskId: string, parentNodeId?: string): WorkerNode[] {
    this.#getRawMeta(taskId)
    const graph = this.#graphs.get(taskId)
    if (graph) {
      const items: WorkerNode[] = []
      for (const id of graph.unarchivedIds) {
        const stored = graph.nodesById.get(id)
        if (!stored) continue
        if (parentNodeId !== undefined && stored.parentNodeId !== parentNodeId) continue
        items.push(this.#toWorkerNode(stored))
      }
      return items
    }
    const items = this.#db.taskNodes<StoredTaskNode>(taskId, { includeArchived: false })
    return (parentNodeId === undefined ? items : items.filter(item => item.parentNodeId === parentNodeId))
      .map(item => this.#toWorkerNode(item))
  }

  listNodesPage(taskId: string, options: {
    afterOrdinal?: number; offset?: number; limit?: number;
    parentNodeId?: string; status?: WorkerNode['status']; includeArchived?: boolean;
  } = {}): { items: WorkerNode[]; nextOrdinal: number | null; hasMore: boolean; totalCount: number } {
    const meta = this.#getRawMeta(taskId)
    const limit = options.limit ?? 50
    const page = this.#db.taskNodesPage<StoredTaskNode>(taskId, {
      limit,
      afterOrdinal: options.afterOrdinal,
      offset: options.offset,
      parentNodeId: options.parentNodeId,
      status: options.status,
      includeArchived: options.includeArchived,
    })
    return {
      items: page.items.map(item => this.#toWorkerNode(item)),
      nextOrdinal: page.nextOrdinal,
      hasMore: page.hasMore,
      totalCount: meta.nodeCount ?? 0,
    }
  }

  teamSummaries(taskId: string, teamNodeId?: string): TeamStageSummary[] {
    this.#getRawMeta(taskId)
    if (teamNodeId !== undefined) {
      const one = this.#db.get<TeamStageSummary>(TASK_TEAM_SUMMARY_NAMESPACE, this.#nodeRecordId(taskId, teamNodeId))
      return one ? [one] : []
    }
    return this.#db.taskRecordsByTaskId<TeamStageSummary>(TASK_TEAM_SUMMARY_NAMESPACE, taskId)
  }

  getNodeDetail(taskId: string, nodeId: string): NodeDetailView | undefined {
    this.#getRawMeta(taskId)
    const stored = this.#graphs.get(taskId)?.nodesById.get(nodeId)
      ?? this.#db.get<StoredTaskNode>(TASK_NODE_NAMESPACE, this.#nodeRecordId(taskId, nodeId))
    if (!stored) return undefined
    const archive = stored.archiveRef
      ? this.#db.get<ArchivedTaskNodeRecord>(TASK_NODE_ARCHIVE_NAMESPACE, stored.archiveRef)
      : this.#db.get<ArchivedTaskNodeRecord>(TASK_NODE_ARCHIVE_NAMESPACE, this.#nodeRecordId(taskId, nodeId))
    const node = archive ? decodeArchivePayload(archive) : this.#toWorkerNode(stored)
    const priorFailures = node.priorFailures ?? stored.priorFailures
    if (priorFailures?.length) node.priorFailures = priorFailures
    const digest = stored.digest ?? node.digest
    return {
      node,
      archived: Boolean(stored.archivedAt),
      ...(stored.archiveRef ? { archiveRef: stored.archiveRef } : {}),
      ...(stored.archivedAt ? { archivedAt: stored.archivedAt } : {}),
      ...(digest ? { digest } : {}),
      ...(priorFailures?.length ? { priorFailures } : {}),
      attempts: this.#db.attemptsForNode<Attempt>(taskId, nodeId),
      operations: this.#db.operationsForNode<Operation>(taskId, nodeId),
    }
  }

  resolveEvidence(taskId: string, evidenceRef: string): EvidenceResolution | undefined {
    this.#getRawMeta(taskId)
    const archive = this.#db.get<ArchivedTaskNodeRecord>(TASK_NODE_ARCHIVE_NAMESPACE, evidenceRef)
    if (archive && archive.taskId === taskId) {
      const node = this.getNode(taskId, archive.nodeId)
      return {
        evidenceRef,
        taskId,
        nodeId: archive.nodeId,
        nodeGoal: node?.goal,
        nodeStatus: node?.status,
        nodeArchived: Boolean(node?.archivedAt),
        archive: { id: archive.id, archivedAt: archive.archivedAt, nodeId: archive.nodeId },
      }
    }
    const operation = this.#db.get<Operation>('operations', evidenceRef)
    if (!operation || operation.taskId !== taskId) return undefined
    const node = operation.taskNodeId ? this.getNode(taskId, operation.taskNodeId) : undefined
    return {
      evidenceRef,
      taskId,
      nodeId: operation.taskNodeId,
      nodeGoal: node?.goal,
      nodeStatus: node?.status,
      nodeArchived: Boolean(node?.archivedAt),
      attemptId: operation.attemptId,
      operation,
      ...(node?.archiveRef ? { archive: { id: node.archiveRef, archivedAt: node.archivedAt!, nodeId: node.id } } : {}),
    }
  }

  failedNodeIds(taskId: string): Set<string> {
    this.#getRawMeta(taskId)
    const graph = this.#graphs.get(taskId)
    if (graph) {
      const failed = new Set<string>()
      for (const id of graph.nonSucceededIds) {
        if (graph.nodesById.get(id)?.status !== 'succeeded') failed.add(id)
      }
      return failed
    }
    return new Set(
      this.#db.taskNodes<StoredTaskNode>(taskId)
        .filter(node => node.status !== 'succeeded')
        .map(node => node.id),
    )
  }

  hasIncompleteNodes(taskId: string): boolean {
    const graph = this.#graph(taskId)
    return graph.nonSucceededIds.size > 0
  }

  hasRunningNodes(taskId: string): boolean {
    const graph = this.#graph(taskId)
    return graph.activeIds.size > 0
  }

  completedChildCount(taskId: string, parentNodeId: string): number {
    const graph = this.#graph(taskId)
    const children = graph.childrenByParent.get(parentNodeId)
    if (!children) return 0
    let count = 0
    for (const id of children) {
      if (graph.nodesById.get(id)?.status === 'succeeded') count++
    }
    return count
  }

  needsArchive(taskId: string): boolean {
    const graph = this.#graph(taskId)
    return graph.unarchivedSettledIds.size >= this.#archiveThreshold
  }

  rebuildIndex(taskId: string): void {
    this.#graphs.delete(taskId)
    this.#graph(taskId)
  }

  attempts(taskId: string): Attempt[] {
    this.#getRawMeta(taskId)
    return this.#db.recordsByTaskId<Attempt>('attempts', taskId)
  }

  operations(taskId: string): Operation[] {
    this.#getRawMeta(taskId)
    return this.#db.recordsByTaskId<Operation>('operations', taskId)
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

  #saveMeta(task: TaskSnapshot): void {
    const slim: TaskSnapshot = { ...task }
    delete slim.worker
    delete slim.nodes
    this.#db.put('tasks', slim.id, slim)
  }

  #event(task: TaskSnapshot, type: string, payload: Record<string, unknown>, correlationId?: string): void {
    this.#db.append({
      taskId: task.id, taskRunId: task.taskRunId, taskAttemptId: task.attemptId,
      taskNodeId: task.rootNodeId, type, payload, correlationId,
    })
  }

  #transition(task: TaskSnapshot, status: TaskStatus, type = 'task.state_changed', correlationId?: string): TaskSnapshot {
    if (!canTransition(task.status, status)) throw new Error('Invalid task transition ' + task.status + ' → ' + status)
    const next = { ...task, status }
    this.#saveMeta(next)
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
        schemaVersion: 1, id: monotonicTaskId(), taskRunId: randomUUID(), rootNodeId: randomUUID(), cwd: command.cwd,
        conversationId: command.conversationId,
        goal: checkText(command.goal, 'goal', 16000),
        check,
        ...(command.workspaceAccess !== undefined ? { workspaceAccess: command.workspaceAccess } : {}),
        route: command.route, status: 'ready', attemptCount: 0, instructions: [], planVersion: 0,
        nodeSeq: 0, nodeCount: 0, replannedCount: 0, archivedNodeCount: 0,
      }
      this.#saveMeta(task)
      onCreated?.(task)
      this.#event(task, 'task.created', { status: task.status }, command.requestId)
      return { taskId: task.id }
    })
  }

  start(taskId: string): TaskSnapshot {
    return this.#db.transaction(() => {
      const task = this.getMeta(taskId)
      const recovered = task.attemptId ? this.#db.get<Attempt>('attempts', task.attemptId) : undefined
      const reuse = recovered?.status === 'interrupted' && recovered.reason === 'process_interrupted'
      const attempt: Attempt = reuse ? {
        ...recovered, status: 'running', reason: undefined, finishedAt: undefined, recoveries: (recovered.recoveries ?? 0) + 1,
      } : {
        schemaVersion: 1, id: randomUUID(), taskId, taskRunId: task.taskRunId, nodeId: task.rootNodeId,
        startedAt: new Date().toISOString(), status: 'running',
      }
      this.#db.put('attempts', attempt.id, attempt)
      return this.#hydrateTask(
        this.#transition({ ...task, attemptId: attempt.id, attemptCount: task.attemptCount + (reuse ? 0 : 1) }, 'running'),
      )
    })
  }

  addInstruction(taskId: string, requestId: string, text: string, onAccepted?: () => void): { accepted: true } {
    return this.#command(requestId, ['instruction', taskId, text], () => {
      const task = this.getMeta(taskId)
      if (!['ready', 'running', 'verifying', 'stopped', 'blocked'].includes(task.status)) throw new Error('Task does not accept instructions')
      if (task.instructions.length >= 64) throw new Error('Instruction limit reached')
      task.instructions.push({ id: requestId, text: checkText(text, 'instruction', 8000), delivered: false })
      this.#saveMeta(task)
      onAccepted?.()
      this.#event(task, 'task.instruction_added', {}, requestId)
      return { accepted: true }
    })
  }

  markDelivered(taskId: string, ids: string[]): void {
    this.#db.transaction(() => {
      const task = this.getMeta(taskId)
      if (!ids.length || task.status === 'succeeded' || task.status === 'failed' || task.status === 'blocked' ||
        task.status === 'stopped' || task.status === 'needs_reconciliation') return
      let changed = 0
      for (const item of task.instructions) {
        if (!item.delivered && ids.includes(item.id)) {
          item.delivered = true
          changed++
        }
      }
      if (!changed) return
      this.#saveMeta(task)
      this.#event(task, 'task.instructions_delivered', { count: changed })
    })
  }

  switchRoute(taskId: string, requestId: string, route: ModelRoute | undefined, onAccepted?: () => void): { accepted: true } {
    return this.#command(requestId, ['switch', taskId, route], () => {
      const task = this.getMeta(taskId)
      if (!['ready', 'running', 'verifying', 'stopped', 'blocked'].includes(task.status)) throw new Error('Task does not accept a model change')
      this.#saveMeta({ ...task, route })
      onAccepted?.()
      this.#event(task, 'model.switch_requested', { route }, requestId)
      return { accepted: true }
    })
  }

  requestStop(taskId: string, requestId: string, source: 'user' | 'shutdown' = 'user'): { accepted: boolean; status: TaskStatus } {
    return this.#command(requestId, ['stop', taskId, source], () => {
      const task = this.getMeta(taskId)
      if (isStopping(task.status) || task.status === 'stopped') return { accepted: true, status: task.status }
      if (!canTransition(task.status, 'stop_requested')) return { accepted: false, status: task.status }
      const next = this.#transition({ ...task, stopIntent: { requestId, source } }, 'stop_requested', 'task.stop_requested', requestId)
      return { accepted: true, status: next.status }
    })
  }

  beginStopping(taskId: string): void {
    this.#db.transaction(() => {
      const task = this.getMeta(taskId)
      if (task.status === 'stop_requested') this.#transition(task, 'stopping')
    })
  }

  resume(taskId: string, requestId: string, checkpointAvailable = true): { accepted: boolean; status: TaskStatus } {
    return this.#command(requestId, ['resume', taskId], () => {
      const task = this.getMeta(taskId)
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
      () => this.#addWorker(this.getMeta(taskId), goal, expectedVersion, dependencies))
  }

  delegate(taskId: string, goal: string): WorkerNode {
    return this.#db.transaction(() => {
      const task = this.getMeta(taskId)
      if (task.status !== 'running') throw new Error('Task is not accepting delegation')
      if (task.legacyWorkerId) {
        const legacy = this.#graph(taskId, task).nodesById.get(task.legacyWorkerId)
        if (legacy && legacy.goal === goal && legacy.result) return this.#toWorkerNode(legacy)
      }
      return this.#addWorker(task, goal, task.planVersion, [])
    })
  }

  #addWorker(task: TaskSnapshot, goal: string, expectedVersion: number, dependencies: string[]): WorkerNode {
    const graph = this.#graph(task.id, task)
    this.#assertPlanning(task, expectedVersion, graph)
    if (task.legacyWorkerId) throw new Error('Single Worker budget exhausted')
    if (graph.nodesById.size >= this.#maxPlanNodes) throw new Error('Task node budget exhausted')
    if (!Array.isArray(dependencies) || dependencies.length) throw new Error('This sprint only supports a leaf with no execution dependencies')
    const ordinal = (task.nodeSeq ?? graph.nodesById.size) + 1
    const stored: StoredTaskNode = {
      id: randomUUID(), parentNodeId: task.rootNodeId, dependencies: [], goal: checkText(goal, 'worker goal', 8000), status: 'ready',
      taskId: task.id, ordinal, isLegacyWorker: true,
    }
    this.#putNode(graph, stored)
    this.#saveMeta({
      ...task,
      legacyWorkerId: stored.id,
      planVersion: task.planVersion + 1,
      nodeSeq: ordinal,
      nodeCount: graph.nodesById.size,
    })
    this.#event(task, 'task.plan_changed', { workerNodeId: stored.id, version: task.planVersion + 1 })
    return this.#toWorkerNode(stored)
  }

  #assertPlanning(task: TaskSnapshot, expectedVersion: number, graph?: TaskGraphIndex): void {
    if (!PLANNING_STATES.includes(task.status)) throw new Error('Task is not accepting work')
    if (task.planVersion !== expectedVersion) throw new Error('Plan version changed')
    const unresolved = graph ? graph.unresolvedWriteOps.size > 0 : this.operations(task.id).some(isUnresolvedEffect)
    if (unresolved) {
      throw new Error('Unresolved tool effects prevent planning')
    }
  }

  delegateScoped(taskId: string, requestId: string, parentNodeId: string, input: Pick<NodeProposal,
    'goal' | 'access' | 'scopePath' | 'tools' | 'disallowedTools' | 'budget' | 'check'>): WorkerNode {
    const task = this.getMeta(taskId)
    const graph = this.#graph(taskId, task)
    this.#assertPlanning(task, task.planVersion, graph)
    const parent = parentNodeId === task.rootNodeId ? undefined : graph.nodesById.get(parentNodeId)
    if (parentNodeId !== task.rootNodeId && parent?.status !== 'running') throw new Error('Parent is not accepting delegation')
    const goal = checkText(input.goal, 'worker goal', 8000)
    const access = input.access ?? 'read'
    const path = input.scopePath === undefined ? parent?.scopePath : scopePath(input.scopePath)
    const tools = input.tools === undefined ? undefined : planTools(input.tools)
    const disallowedTools = input.disallowedTools === undefined ? undefined : planTools(input.disallowedTools)
    const budget = input.budget === undefined ? undefined : planBudget(input.budget)
    const check = verificationCheck(input.check)
    const siblings = graph.childrenByParent.get(parentNodeId)
    if (siblings) {
      for (const childId of siblings) {
        const node = graph.nodesById.get(childId)
        if (!node || node.isLegacyWorker) continue
        if (node.role === 'worker' &&
          node.goal === goal && !node.dependencies.length && !node.route && node.worktreeId === parent?.worktreeId &&
          node.access === access && node.scopePath === path &&
          JSON.stringify(node.tools) === JSON.stringify(tools) &&
          JSON.stringify(node.disallowedTools) === JSON.stringify(disallowedTools) &&
          (node.budget === undefined) === (budget === undefined) &&
          node.budget?.requests === budget?.requests && node.budget?.timeMs === budget?.timeMs &&
          JSON.stringify(node.check) === JSON.stringify(check)) {
          return this.#toWorkerNode(node)
        }
      }
    }
    return this.proposePlan(taskId, requestId, task.planVersion,
      [{ ref: 'child', role: 'worker', parentNodeId, goal, access, scopePath: path, tools, disallowedTools, budget, check }])[0]!
  }

  proposePlan(taskId: string, requestId: string, expectedVersion: number, proposals: NodeProposal[]): WorkerNode[] {
    return this.#command(requestId, ['proposePlan', taskId, expectedVersion, proposals], () => {
      const task = this.getMeta(taskId)
      const graph = this.#graph(taskId, task)
      this.#assertPlanning(task, expectedVersion, graph)
      if (!Array.isArray(proposals) || !proposals.length || proposals.length > this.#maxProposalBatch ||
        proposals.length + graph.nodesById.size > this.#maxPlanNodes) {
        throw new Error('Invalid plan size or task node budget exhausted')
      }
      const ids = new Map<string, string>()
      for (const proposal of proposals) {
        if (!proposal || typeof proposal.ref !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(proposal.ref) ||
          ids.has(proposal.ref) || task.rootNodeId === proposal.ref || graph.nodesById.has(proposal.ref)) {
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
        if (access !== 'read' && access !== 'write' && access !== 'trusted') throw new Error('Invalid node access')
        const taskAccess = task.workspaceAccess ?? (task.check?.path ? 'write' : 'read')
        if (nodeAccessRank[access] > nodeAccessRank[taskAccess]) throw new Error('Node cannot expand workspace access')
        const parent = graph.nodesById.get(parentNodeId)
        if (parent && parent.status !== 'ready' && parent.status !== 'running') throw new Error('Parent is not accepting work')
        const check = verificationCheck(proposal.check)
        if (check?.command && access !== 'trusted') {
          throw new Error('Command verification requires trusted node workspace access')
        }
        return {
          id: ids.get(proposal.ref)!, parentNodeId, role, access, status: 'ready',
          goal: checkText(proposal.goal, 'worker goal', 8000),
          dependencies: nodeDependencies(proposal.dependencies, resolve, this.#maxDependenciesPerNode),
          ...(proposal.scopePath !== undefined ? { scopePath: scopePath(proposal.scopePath) } : {}),
          ...(proposal.tools !== undefined ? { tools: planTools(proposal.tools) } : {}),
          ...(proposal.disallowedTools !== undefined ? { disallowedTools: planTools(proposal.disallowedTools) } : {}),
          ...(proposal.budget !== undefined ? { budget: planBudget(proposal.budget) } : {}),
          ...(proposal.worktreeId ? { worktreeId: proposal.worktreeId } : {}),
          ...(proposal.teamKey !== undefined ? { teamKey: proposal.teamKey } : {}),
          ...(check ? { check } : {}),
          ...(proposal.route !== undefined ? { route: planRoute(proposal.route) } : {}),
        }
      })
      assertIncrementalProposalGraph(task.rootNodeId, graph.nodesById, candidates)
      const candidateById = new Map(candidates.map(node => [node.id, node]))
      let ordinal = task.nodeSeq ?? graph.nodesById.size
      const proposed: WorkerNode[] = []
      for (const candidate of candidates) {
        const parent = candidateById.get(candidate.parentNodeId) ?? graph.nodesById.get(candidate.parentNodeId)
        const scope = candidate.scopePath ?? parent?.scopePath
        if (parent?.scopePath && scope && !containsScope(parent.scopePath, scope)) throw new Error('Node cannot expand parent scope')
        assertCheckInScope(candidate.check, scope)
        ordinal++
        const node: WorkerNode = {
          ...candidate,
          ...(scope ? { scopePath: scope } : {}),
          ...(parent?.worktreeId ? { worktreeId: parent.worktreeId } : {}),
        }
        const stored: StoredTaskNode = { ...node, taskId: task.id, ordinal }
        this.#putNode(graph, stored)
        proposed.push(node)
      }
      const version = task.planVersion + 1
      this.#saveMeta({ ...task, planVersion: version, nodeSeq: ordinal, nodeCount: graph.nodesById.size })
      this.#event(task, 'task.plan_changed', {
        version,
        nodes: proposed.slice(0, 64).map(({ id, parentNodeId, dependencies, role, access }) => ({ id, parentNodeId, dependencies, role, access })),
        ...(proposed.length > 64 ? { totalProposed: proposed.length } : {}),
      }, requestId)
      return proposed
    })
  }

  replanNode(taskId: string, requestId: string, expectedVersion: number, nodeId: string, update: NodeReplan): WorkerNode {
    return this.#command(requestId, ['replanNode', taskId, expectedVersion, nodeId, update], () => {
      const task = this.getMeta(taskId)
      const graph = this.#graph(taskId, task)
      this.#assertPlanning(task, expectedVersion, graph)
      const previous = graph.nodesById.get(nodeId)
      if (!previous || previous.isLegacyWorker || previous.archivedAt || (previous.status !== 'ready' && previous.status !== 'failed')) {
        throw new Error('Node cannot be replanned')
      }
      if (this.#db.operationsForNode<Operation>(taskId, nodeId).some(({ effect }) => effect === 'write')) {
        throw new Error('Node with a previous write attempt cannot be replanned')
      }
      if (previous.replans) throw new Error('Node replan budget exhausted')
      if (!update || typeof update !== 'object' || Array.isArray(update) ||
        Object.keys(update).some((key) => !['goal', 'dependencies', 'check'].includes(key))) throw new Error('Invalid node replan')
      const children = graph.childrenByParent.get(nodeId)
      if (children) {
        for (const childId of children) {
          if (graph.nodesById.get(childId)?.status === 'running') throw new Error('Node has running children')
        }
      }
      const check = update.check !== undefined ? verificationCheck(update.check) : previous.check
      if (update.check && check?.command && previous.access !== 'trusted') {
        throw new Error('Command verification requires trusted node workspace access')
      }
      assertCheckInScope(check, previous.scopePath)
      const priorFailures: NodeFailureRecord[] = [...(previous.priorFailures ?? [])]
      if (previous.status === 'failed') {
        priorFailures.push({
          ...(previous.attemptId ? { attemptId: previous.attemptId } : {}),
          failedAt: new Date().toISOString(),
          summary: clipText(previous.result?.summary ?? 'Previous attempt failed.', 240),
          remainingRisks: [...(previous.result?.remainingRisks ?? [])],
          ...(previous.verification?.evidence ? { verificationEvidence: previous.verification.evidence } : {}),
        })
      }
      const nextBase: StoredTaskNode = {
        ...previous,
        goal: update.goal !== undefined ? checkText(update.goal, 'worker goal', 8000) : previous.goal,
        ...(check ? { check } : {}),
        dependencies: update.dependencies !== undefined
          ? nodeDependencies(update.dependencies, id => id, this.#maxDependenciesPerNode)
          : previous.dependencies,
        status: 'ready',
        replans: 1,
        ...(priorFailures.length ? { priorFailures } : {}),
      }
      delete nextBase.attemptId
      delete nextBase.result
      delete nextBase.verification
      delete nextBase.digest
      assertReplanAcyclic(task.rootNodeId, graph.nodesById, nextBase)
      this.#putNode(graph, nextBase)
      const version = task.planVersion + 1
      this.#saveMeta({
        ...task,
        planVersion: version,
        replannedCount: (task.replannedCount ?? 0) + 1,
      })
      const replan = this.#toWorkerNode(nextBase)
      this.#event(task, 'task.plan_changed', { version, replannedNodeId: nodeId, dependencies: replan.dependencies }, requestId)
      return replan
    })
  }

  blocksToolWork(taskId: string, managedOwner?: string, worktreeId?: string): boolean {
    return Boolean(this.#toolWorkBlock(taskId, managedOwner, worktreeId))
  }

  hasOpenOperation(operationId: string): boolean {
    return this.#db.get<Operation>('operations', operationId)?.status === 'started'
  }

  toolWorkBlock(event: EventDraft, tool: string, effect: Operation['effect'], policy?: { whileActive?: boolean }) {
    const task = this.getMeta(event.taskId)
    const node = event.taskNodeId ? this.getNode(task.id, event.taskNodeId) : undefined
    return this.#toolWorkBlock(task.id, policy?.whileActive ? event.agentRunId : undefined, node?.worktreeId, tool, effect)
  }

  hasUnconfirmedReplay(taskId: string, tool: string, target: string | undefined, callFingerprint: string | undefined): boolean {
    const graph = this.#graph(taskId)
    for (const operation of graph.unknownWriteOps.values()) {
      if (operation.effect !== 'write' || operation.status !== 'unknown_effect') continue
      if (callFingerprint !== undefined && operation.callFingerprint !== undefined
        ? operation.callFingerprint === callFingerprint
        : operation.tool === tool && operation.target === target) {
        return true
      }
    }
    return false
  }

  #toolWorkBlock(taskId: string, managedOwner?: string, worktreeId?: string, tool?: string, effect?: Operation['effect'], graph?: TaskGraphIndex) {
    const resolved = graph ?? this.#graph(taskId)
    const inspection = effect === 'read' && (tool === 'list_directory' || tool === 'read_text_file' ||
      tool === 'search_files' || tool === 'search_content' || tool === 'process_status' || tool === 'process_output' ||
      tool === 'git_status' || tool === 'git_diff' || tool === 'git_log')
    if (!inspection && resolved.unresolvedWriteOps.size > 0) return 'unconfirmed_write' as const
    for (const op of resolved.activeWriteOps.values()) {
      if (op.status === 'started' && !separateWorktrees(worktreeId, op.worktreeId) &&
        !(op.managed && managedOwner && op.agentRunId === managedOwner)) {
        return 'active_write' as const
      }
    }
    return undefined
  }

  #nodeRunCapacity(graph: TaskGraphIndex): number {
    return this.#maxNodeRuns - graph.childAttemptCount
  }

  #activeNodes(graph: TaskGraphIndex): StoredTaskNode[] {
    const active: StoredTaskNode[] = []
    for (const id of graph.activeIds) {
      const node = graph.nodesById.get(id)
      if (node) active.push(node)
    }
    return active
  }

  #suspendedChildrenIncludeWrite(graph: TaskGraphIndex, parent: StoredTaskNode): boolean {
    const ids = parent.suspendedForIds ?? (parent.suspendedFor ? [parent.suspendedFor] : [])
    return ids.some(id => canWrite(graph.nodesById.get(id)?.access))
  }

  #canStartNode(
    task: TaskSnapshot,
    graph: TaskGraphIndex,
    node: StoredTaskNode,
    active: readonly StoredTaskNode[],
    suspendParent: boolean,
  ): boolean {
    if (node.status !== 'ready' || active.length >= this.#maxConcurrentNodes) return false
    for (const depId of node.dependencies) {
      if (graph.nodesById.get(depId)?.status !== 'succeeded') return false
    }
    const parent = node.parentNodeId === task.rootNodeId ? undefined : active.find(({ id }) => id === node.parentNodeId)
    if (node.parentNodeId !== task.rootNodeId) {
      if (!parent) return false
      const existingSuspended = parent.suspendedForIds ?? (parent.suspendedFor ? [parent.suspendedFor] : [])
      if (!suspendParent) {
        if (existingSuspended.length > 0) return false
      } else if (existingSuspended.length > 0) {
        if (canWrite(node.access) || this.#suspendedChildrenIncludeWrite(graph, parent)) return false
      }
    }
    if (node.role === 'team' && (active.filter(({ role }) => role === 'team').length >= this.#maxConcurrentTeams ||
      active.some(({ teamKey }) => teamKey === node.teamKey))) return false
    const scheduled = [...active, node]
    const teamsWithoutChildren = scheduled.filter((agent) =>
      agent.role === 'team' && !scheduled.some(({ parentNodeId }) => parentNodeId === agent.id)).length
    if (scheduled.length + teamsWithoutChildren > this.#maxConcurrentNodes) return false
    return active.every(other =>
      (suspendParent && parent === other && !canWrite(node.access) && !this.#suspendedChildrenIncludeWrite(graph, other)) ||
      (suspendParent && parent === other && !(other.suspendedForIds?.length ?? (other.suspendedFor ? 1 : 0))) ||
      separateWorktrees(node.worktreeId, other.worktreeId) ||
      (!canWrite(node.access) && !canWrite(other.access)),
    )
  }

  runnableNodes(taskId: string, parentNodeId?: string): WorkerNode[] {
    const task = this.getMeta(taskId)
    if (task.status !== 'running') return []
    const graph = this.#graph(taskId, task)
    if (!graph.readyIds.size) return []
    const active = this.#activeNodes(graph)
    if (active.length >= this.#maxConcurrentNodes) return []
    const parentId = parentNodeId ?? task.rootNodeId
    const suspendParent = parentNodeId !== undefined
    const remaining = this.#nodeRunCapacity(graph)
    if (remaining <= 0) return []
    const runnable: WorkerNode[] = []
    const blockedWriterWorkspaces = new Set<string>()
    const readyCandidateIds = graph.hasReplanned
      ? [...graph.readyIds].sort((a, b) => (graph.nodesById.get(a)!.ordinal - graph.nodesById.get(b)!.ordinal))
      : graph.readyIds
    for (const nodeId of readyCandidateIds) {
      if (active.length >= this.#maxConcurrentNodes) break
      if (runnable.length >= remaining) break
      const node = graph.nodesById.get(nodeId)
      if (!node || node.parentNodeId !== parentId) continue
      const wsKey = node.worktreeId ?? '__primary__'
      if (blockedWriterWorkspaces.has(wsKey)) continue
      if (this.#toolWorkBlock(taskId, undefined, node.worktreeId, undefined, undefined, graph)) continue
      if (!this.#canStartNode(task, graph, node, active, suspendParent)) {
        // Record waiting ready writer on this workspace so later read workers cannot starve it.
        const depsReady = node.dependencies.every(depId => graph.nodesById.get(depId)?.status === 'succeeded')
        if (depsReady && canWrite(node.access) && active.length < this.#maxConcurrentNodes) {
          blockedWriterWorkspaces.add(wsKey)
        }
        continue
      }
      runnable.push(this.#toWorkerNode(node))
      active.push(node)
      if (canWrite(node.access)) blockedWriterWorkspaces.add(wsKey)
    }
    return runnable
  }

  startWorker(taskId: string, nodeId: string, options: { suspendParent?: boolean } = {}): string {
    return this.#db.transaction(() => {
      const task = this.getMeta(taskId)
      const graph = this.#graph(taskId, task)
      const node = graph.nodesById.get(nodeId)
      const active = this.#activeNodes(graph)
      if (task.status !== 'running' || !node ||
        this.#toolWorkBlock(taskId, undefined, node.worktreeId, undefined, undefined, graph) ||
        this.#nodeRunCapacity(graph) <= 0 ||
        !this.#canStartNode(task, graph, node, active, options.suspendParent === true)) {
        throw new Error('Worker node is not runnable')
      }
      const id = randomUUID()
      const attempt: Attempt = {
        schemaVersion: 1, id, taskId, taskRunId: task.taskRunId, nodeId,
        startedAt: new Date().toISOString(), status: 'running',
      }
      const running: StoredTaskNode = { ...node, attemptId: id, status: 'running' }
      if (options.suspendParent) {
        const parent = active.find(other => other.id === node.parentNodeId)
        if (parent) {
          const prevIds = parent.suspendedForIds ?? (parent.suspendedFor ? [parent.suspendedFor] : [])
          const nextIds = [...prevIds, nodeId]
          this.#putNode(graph, { ...parent, suspendedFor: nextIds[0], suspendedForIds: nextIds })
        }
      }
      this.#putNode(graph, running)
      this.#invalidateOnRollback(taskId)
      graph.childAttemptCount++
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

  #buildNodeDigest(stored: StoredTaskNode, resolvedFailures?: NodeFailureRecord[]): NodeSummaryDigest {
    const verification = stored.verification ?? { passed: false, verdict: 'failed' as const, basis: 'handoff' as const, evidence: 'unverified' }
    return {
      schemaVersion: 1,
      whatCompleted: clipText(stored.goal, 140),
      artifacts: [...(stored.result?.artifactRefs ?? [])].slice(0, 16),
      verified: {
        passed: verification.passed,
        ...(verification.verdict ? { verdict: verification.verdict } : {}),
        ...(verification.basis ? { basis: verification.basis } : {}),
        evidence: verification.evidence,
      },
      conclusion: clipText(stored.result?.summary ?? `Settled with status ${stored.status}`, 200),
      remainingRisks: [...(stored.result?.remainingRisks ?? [])].slice(0, 12),
      ...(resolvedFailures?.length ? { resolvedFailures } : {}),
    }
  }

  #upsertTeamSummary(task: TaskSnapshot, graph: TaskGraphIndex, teamNode: StoredTaskNode): TeamStageSummary {
    const childIds = graph.childrenByParent.get(teamNode.id)
    const completedWork: string[] = []
    const technicalDecisions: string[] = []
    const interfaceContracts: string[] = []
    const resolvedFailures: { nodeId: string; failure: string; resolution?: string }[] = []
    const remainingRisks = new Set<string>(teamNode.result?.remainingRisks ?? [])
    const nodeRefs: string[] = []
    const artifactSet = new Set<string>(teamNode.result?.artifactRefs ?? [])
    const evidenceSet = new Set<string>(teamNode.result?.evidenceRefs ?? [])
    let succeededCount = 0
    let failedCount = 0

    if (childIds) {
      for (const childId of childIds) {
        const child = graph.nodesById.get(childId)
        if (!child) continue
        if (child.status === 'succeeded') succeededCount++
        else if (child.status === 'failed') failedCount++
        if (nodeRefs.length < 64) nodeRefs.push(child.id)
        if (child.status === 'succeeded' && completedWork.length < 16) {
          const piece = clipText(child.result?.summary ?? child.goal, 180)
          if (piece && !completedWork.includes(piece)) completedWork.push(piece)
        }
        if (child.scopePath && interfaceContracts.length < 16) {
          const contract = `scope:${child.scopePath}`
          if (!interfaceContracts.includes(contract)) interfaceContracts.push(contract)
        }
        if (child.check && interfaceContracts.length < 16) {
          const target = child.check.path ?? (child.check.command ? `${child.check.command.command}@${child.check.command.path}` : undefined)
          if (target && !interfaceContracts.includes(target)) interfaceContracts.push(target)
        }
        for (const art of child.result?.artifactRefs ?? []) {
          if (artifactSet.size < 64) artifactSet.add(art)
          if (interfaceContracts.length < 16 && !interfaceContracts.includes(art)) interfaceContracts.push(art)
        }
        for (const ev of child.result?.evidenceRefs ?? []) {
          if (evidenceSet.size < 64) evidenceSet.add(ev)
        }
        for (const risk of child.result?.remainingRisks ?? []) remainingRisks.add(risk)
        for (const prior of child.priorFailures ?? []) {
          resolvedFailures.push({
            nodeId: child.id,
            failure: prior.summary,
            resolution: child.status === 'succeeded' ? clipText(child.result?.summary ?? 'Resolved on replan', 160) : prior.resolution,
          })
        }
        if (child.status === 'failed' && teamNode.status === 'succeeded') {
          resolvedFailures.push({
            nodeId: child.id,
            failure: clipText(child.result?.summary ?? 'Worker failed within team scope', 160),
            resolution: clipText(teamNode.result?.summary ?? 'Resolved by parent team', 160),
          })
        }
      }
    }
    if (teamNode.result?.summary) {
      technicalDecisions.push(clipText(teamNode.result.summary, 240))
    }
    const summary: TeamStageSummary = {
      schemaVersion: 1,
      id: this.#nodeRecordId(task.id, teamNode.id),
      taskId: task.id,
      teamNodeId: teamNode.id,
      ...(teamNode.teamKey ? { teamKey: teamNode.teamKey } : {}),
      goal: clipText(teamNode.goal, 200),
      status: teamNode.status === 'succeeded' ? 'succeeded' : teamNode.status === 'failed' ? 'failed' : 'active',
      updatedAt: new Date().toISOString(),
      childCount: childIds?.size ?? 0,
      succeededCount,
      failedCount,
      completedWork,
      technicalDecisions,
      interfaceContracts,
      resolvedFailures: resolvedFailures.slice(0, 24),
      remainingRisks: [...remainingRisks].slice(0, 24),
      nodeRefs,
      artifactRefs: [...artifactSet],
      evidenceRefs: [...evidenceSet],
    }
    this.#db.put(TASK_TEAM_SUMMARY_NAMESPACE, summary.id, summary)
    return summary
  }

  generateTeamSummary(taskId: string, teamNodeId: string): TeamStageSummary {
    return this.#db.transaction(() => {
      const task = this.getMeta(taskId)
      const graph = this.#graph(taskId, task)
      const team = graph.nodesById.get(teamNodeId)
      if (!team || team.role !== 'team') throw new Error('Team node not found')
      return this.#upsertTeamSummary(task, graph, team)
    })
  }

  settleWorker(taskId: string, nodeId: string, result?: WorkerResult, verification?: VerificationResult,
    expectedAttemptId?: string): WorkerNode | undefined {
    return this.#db.transaction(() => {
      const task = this.getMeta(taskId)
      const graph = this.#graph(taskId, task)
      const node = graph.nodesById.get(nodeId)
      if (!node || node.status !== 'running' || (expectedAttemptId !== undefined && node.attemptId !== expectedAttemptId)) return
      const childIds = graph.childrenByParent.get(nodeId)
      const children: StoredTaskNode[] = []
      if (childIds) {
        for (const childId of childIds) {
          const child = graph.nodesById.get(childId)
          if (child) children.push(child)
        }
      }
      if (children.some(({ status }) => status === 'running')) throw new Error('Cannot settle a node with active children')
      const legacy = Boolean(node.isLegacyWorker || task.legacyWorkerId === nodeId)
      const receipts = node.attemptId ? this.#db.operationsForAttempt<Operation>(taskId, node.attemptId) : []
      const interruption = !legacy && result === undefined ? interruptedWrite(receipts) : undefined
      let accepted = result ?? interruption?.result
      if (interruption) verification = interruption.verification
      if (result?.resultStatus === 'succeeded') {
        const finished = receipts.every(operation => operation.status !== 'started' && !isUnresolvedEffect(operation))
        const hasReceipt = receipts.some(({ id, status }) => status === 'succeeded' && result.evidenceRefs.includes(id))
        const childrenCompleted = children.every(({ status }) => status === 'succeeded')
        const hasHandoff = node.check ? confirmedCheck(verification) : hasReceipt || (children.length > 0 && childrenCompleted)
        const completed = finished && childrenCompleted && hasHandoff && Boolean(result.summary.trim())
        const verified = completed && Boolean(node.check)
        verification = {
          passed: verified,
          verdict: verified ? 'verified' : completed ? 'unverified' : 'failed',
          basis: node.check ? node.check.command ? 'project_command' : 'workspace_path' : 'handoff',
          evidence: !finished ? 'node_unsettled_operations' : !childrenCompleted ? 'node_child_verification_failed'
            : node.check ? verification?.evidence ?? 'node_check_unavailable'
            : hasReceipt && completed ? 'node_confirmed_tool_receipt' : completed ? 'node_completed_children' : 'node_missing_evidence',
        }
        if (!completed) accepted = { ...result, resultStatus: 'failed', remainingRisks: [...result.remainingRisks, verification.evidence] }
      } else if (result?.resultStatus === 'failed') {
        verification = verification && confirmedCheck(verification)
          ? normalizeVerification(verification)
          : {
            passed: false, verdict: 'failed',
            basis: verification && !verification.passed ? (verification.basis ?? 'handoff') : 'handoff',
            evidence: verification && !verification.passed ? verification.evidence : 'node_handoff_rejected',
          }
      }
      const nextPriorFailures = node.priorFailures?.map((item, idx, arr) =>
        idx === arr.length - 1 && accepted?.resultStatus === 'succeeded'
          ? { ...item, resolvedByAttemptId: node.attemptId, resolution: clipText(accepted.summary, 200) }
          : item)
      const settled: StoredTaskNode = {
        ...node,
        status: accepted?.resultStatus ?? 'ready',
        result: accepted,
        verification,
        ...(nextPriorFailures?.length ? { priorFailures: nextPriorFailures } : {}),
      }
      const parent = graph.nodesById.get(node.parentNodeId)
      const parentSuspended = parent?.suspendedForIds ?? (parent?.suspendedFor ? [parent.suspendedFor] : [])
      if (parent && parentSuspended.includes(nodeId)) {
        const nextIds = parentSuspended.filter(id => id !== nodeId)
        const updatedParent: StoredTaskNode = {
          ...parent,
          suspendedFor: nextIds[0],
          ...(nextIds.length ? { suspendedForIds: nextIds } : {}),
        }
        if (!nextIds.length) {
          delete updatedParent.suspendedFor
          delete updatedParent.suspendedForIds
        }
        this.#putNode(graph, updatedParent)
      }
      this.#putNode(graph, settled)
      const attemptStatus = interruption?.unknown ? 'unknown_effect' : result === undefined ? 'interrupted'
        : accepted?.resultStatus ?? 'interrupted'
      this.#finishAttempt(node.attemptId, attemptStatus, interruption?.unknown ? 'unknown_effect' : undefined)
      if (settled.role === 'team' && (settled.status === 'succeeded' || settled.status === 'failed')) {
        this.#upsertTeamSummary(task, graph, settled)
      }
      this.#nodeEvent(task, settled, legacy ? 'task.worker_settled' : 'task.node_settled', {
        status: accepted?.resultStatus ?? 'interrupted',
        attemptStatus,
        ...(accepted ? { executionStatus: accepted.executionStatus, evidenceRefs: accepted.evidenceRefs, verification } : {}),
      })
      return this.#toWorkerNode(settled)
    })
  }

  #canArchiveNode(
    task: TaskSnapshot,
    graph: TaskGraphIndex,
    node: StoredTaskNode,
    preloadedOps?: readonly Operation[],
    skipDbCheck = false,
  ): boolean {
    if (node.archivedAt || node.isLegacyWorker) return false
    if (node.status !== 'succeeded' && node.status !== 'failed') return false
    const taskTerminal = task.status === 'succeeded' || task.status === 'failed' || task.status === 'blocked' || task.status === 'stopped'
    if (node.parentNodeId !== task.rootNodeId) {
      const parent = graph.nodesById.get(node.parentNodeId)
      if (parent && (parent.status === 'ready' || parent.status === 'running')) return false
    }
    if (node.status === 'failed') {
      if (!taskTerminal) {
        const parent = node.parentNodeId !== task.rootNodeId ? graph.nodesById.get(node.parentNodeId) : undefined
        // Preserve active failed nodes unless settled under a succeeded parent Team.
        if (parent?.status !== 'succeeded') return false
      }
    }
    const children = graph.childrenByParent.get(node.id)
    if (children) {
      for (const childId of children) {
        const child = graph.nodesById.get(childId)
        if (!child) continue
        if (child.status === 'ready' || child.status === 'running') return false
      }
    }
    const dependents = graph.dependentsByNode.get(node.id)
    if (dependents) {
      for (const depId of dependents) {
        const dep = graph.nodesById.get(depId)
        if (!dep) continue
        if (dep.status === 'ready' || dep.status === 'running') return false
        if (!taskTerminal && dep.status === 'failed' && !dep.replans) return false
      }
    }
    for (const op of graph.activeWriteOps.values()) {
      if (op.taskNodeId === node.id) return false
    }
    for (const op of graph.unresolvedWriteOps.values()) {
      if (op.taskNodeId === node.id) return false
    }
    if (!skipDbCheck) {
      const nodeOps = preloadedOps ?? this.#db.operationsForNode<Operation>(task.id, node.id)
      if (nodeOps.some(op => op.status === 'started' || isUnresolvedEffect(op))) return false
      if (node.attemptId) {
        const attempt = this.#db.get<Attempt>('attempts', node.attemptId)
        if (attempt?.status === 'running') return false
      }
    }
    return true
  }

  archiveCompletedNodes(
    taskId: string,
    options: { batchSize?: number; maxBatches?: number; onBatchCommitted?: (batchIndex: number, archivedIds: string[]) => void } = {},
  ): { archivedCount: number; archivedIds: string[]; remainingSettled: number } {
    const task = this.getMeta(taskId)
    const graph = this.#graph(taskId, task)
    if (!graph.unarchivedSettledIds.size) {
      return { archivedCount: 0, archivedIds: [], remainingSettled: 0 }
    }
    const batchSize = options.batchSize && Number.isSafeInteger(options.batchSize) && options.batchSize > 0
      ? options.batchSize : this.#archiveBatchSize
    const maxBatches = options.maxBatches && Number.isSafeInteger(options.maxBatches) && options.maxBatches > 0
      ? options.maxBatches : Infinity
    const allArchived: string[] = []
    let batchIndex = 0

    while (batchIndex < maxBatches) {
      const candidates: StoredTaskNode[] = []
      for (const nodeId of graph.unarchivedSettledIds) {
        if (candidates.length >= batchSize) break
        const node = graph.nodesById.get(nodeId)
        if (node && this.#canArchiveNode(task, graph, node, undefined, true)) {
          candidates.push(node)
        }
      }
      if (!candidates.length) break
      const batchIds: string[] = []
      this.#db.transaction(() => {
        const latestMeta = this.getMeta(taskId)
        let archivedDelta = 0
        for (const node of candidates) {
          const current = graph.nodesById.get(node.id)
          if (!current || current.archivedAt) continue
          const operations = this.#db.operationsForNode<Operation>(taskId, current.id)
          if (!this.#canArchiveNode(latestMeta, graph, current, operations)) continue
          const archiveId = this.#nodeRecordId(taskId, current.id)
          const archivedAt = new Date().toISOString()
          const fullPayload = this.#toWorkerNode(current)
          if (current.priorFailures?.length) fullPayload.priorFailures = current.priorFailures
          const resolvedFailures = current.status === 'succeeded' && current.priorFailures?.length
            ? current.priorFailures : current.priorFailures
          const digest = this.#buildNodeDigest(current, resolvedFailures)
          const attempts = this.#db.attemptsForNode<Attempt>(taskId, current.id)
          const encoded = encodeArchivePayload(fullPayload)
          const archiveRecord: ArchivedTaskNodeRecord = {
            schemaVersion: 1,
            id: archiveId,
            taskId,
            nodeId: current.id,
            ordinal: current.ordinal,
            archivedAt,
            encoding: encoded.encoding,
            payload: encoded.payload,
            attemptIds: attempts.map(a => a.id),
            operationIds: operations.map(o => o.id),
          }
          this.#db.put(TASK_NODE_ARCHIVE_NAMESPACE, archiveId, archiveRecord)
          if (current.role === 'team') {
            this.#upsertTeamSummary(latestMeta, graph, current)
          }
          const slim: StoredTaskNode = {
            id: current.id,
            taskId: current.taskId,
            ordinal: current.ordinal,
            parentNodeId: current.parentNodeId,
            dependencies: current.dependencies,
            goal: clipText(current.goal, 160),
            status: current.status,
            ...(current.attemptId ? { attemptId: current.attemptId } : {}),
            ...(current.role ? { role: current.role } : {}),
            ...(current.teamKey ? { teamKey: current.teamKey } : {}),
            ...(current.access ? { access: current.access } : {}),
            ...(current.scopePath ? { scopePath: current.scopePath } : {}),
            ...(current.worktreeId ? { worktreeId: current.worktreeId } : {}),
            ...(current.replans !== undefined ? { replans: current.replans } : {}),
            ...(current.result ? {
              result: {
                resultStatus: current.result.resultStatus,
                ...(current.result.executionStatus ? { executionStatus: current.result.executionStatus } : {}),
                summary: clipText(current.result.summary, 200),
                artifactRefs: current.result.artifactRefs.slice(0, 16),
                evidenceRefs: current.result.evidenceRefs.slice(0, 16),
                remainingRisks: current.result.remainingRisks.slice(0, 12),
              },
            } : {}),
            ...(current.verification ? { verification: current.verification } : {}),
            digest,
            archivedAt,
            archiveRef: archiveId,
          }
          this.#putNode(graph, slim)
          batchIds.push(current.id)
          archivedDelta++
        }
        if (archivedDelta > 0) {
          const updatedMeta: TaskSnapshot = {
            ...latestMeta,
            archivedNodeCount: (latestMeta.archivedNodeCount ?? 0) + archivedDelta,
          }
          this.#saveMeta(updatedMeta)
          this.#event(updatedMeta, 'task.nodes_archived', {
            count: archivedDelta,
            nodeIds: batchIds.slice(0, 32),
          })
        }
      })
      if (!batchIds.length) break
      allArchived.push(...batchIds)
      batchIndex++
      options.onBatchCommitted?.(batchIndex, batchIds)
    }
    return {
      archivedCount: allArchived.length,
      archivedIds: allArchived,
      remainingSettled: graph.unarchivedSettledIds.size,
    }
  }

  setWorkspaceAccess(taskId: string, access: WorkspaceAccess, requestStop: string | undefined, onChanged: () => void): void {
    this.#db.transaction(() => {
      const task = this.getMeta(taskId)
      if (task.workspaceAccess === access) { onChanged(); return }
      const graph = this.#graph(taskId, task)
      const next: TaskSnapshot = { ...task, workspaceAccess: access }
      for (const id of [...graph.readyIds, ...graph.activeIds]) {
        const node = graph.nodesById.get(id)
        if (node && nodeAccessRank[node.access ?? 'read'] > nodeAccessRank[access]) {
          this.#putNode(graph, { ...node, access })
        }
      }
      this.#saveMeta(next)
      onChanged()
      this.#event(next, 'task.permissions_changed', { access, previousAccess: task.workspaceAccess })
      if (requestStop && canTransition(next.status, 'stop_requested')) {
        this.#transition({ ...next, stopIntent: { requestId: requestStop, source: 'user' } },
          'stop_requested', 'task.stop_requested', requestStop)
      }
    })
  }

  #settleReconciledTask(task: TaskSnapshot, checkpointReady: boolean): void {
    const graph = this.#graph(task.id, task)
    if (graph.activeWriteOps.size > 0 || graph.unresolvedWriteOps.size > 0) return
    if (this.operations(task.id).some(item => isUnresolvedEffect(item) || item.status === 'started')) return
    if (!checkpointReady) {
      if (task.reconciliationBlock !== 'checkpoint_error' || task.reason !== 'checkpoint_error') {
        const updated: TaskSnapshot = { ...task, reconciliationBlock: 'checkpoint_error', reason: 'checkpoint_error' }
        this.#saveMeta(updated)
        this.#event(updated, 'operation.reconciliation_required', { operationIds: [], reason: 'checkpoint_error' })
      }
      return
    }
    if (!task.reconciliationBlock) {
      this.#transition({ ...task, reason: undefined }, 'stopped', 'task.stopped')
    }
  }

  recordReconciliation(taskId: string, id: string, observation: NonNullable<Operation['reconciliation']>, checkpointReady = true): Operation {
    return this.#db.transaction(() => {
      const task = this.getMeta(taskId)
      const operation = this.#db.get<Operation>('operations', id)
      if (!operation || operation.taskId !== taskId) throw new Error('Operation does not belong to this task')
      if (operation.reconciliation?.status === 'verified') return operation
      if (task.status !== 'needs_reconciliation' || !isUnresolvedEffect(operation)) throw new Error('Operation is not awaiting reconciliation')
      const next: Operation = { ...operation, reconciliation: observation,
        status: observation.status === 'verified' ? 'interrupted' : 'unknown_effect' }
      const graph = this.#graphs.get(taskId)
      if (graph) {
        this.#invalidateOnRollback(taskId)
        graph.activeWriteOps.delete(id)
        if (next.status === 'unknown_effect') graph.unknownWriteOps.set(id, next)
        else graph.unknownWriteOps.delete(id)
        if (isUnresolvedEffect(next)) graph.unresolvedWriteOps.set(id, next)
        else graph.unresolvedWriteOps.delete(id)
      }
      this.#db.put('operations', id, next)
      this.#event(task, 'operation.reconciliation_checked', { operationId: id, ...observation })
      if (observation.status === 'verified') this.#settleReconciledTask(task, checkpointReady)
      return next
    })
  }

  acknowledgeReconciliation(taskId: string, id: string, checkpointReady = true): Operation {
    return this.#db.transaction(() => {
      const task = this.getMeta(taskId)
      const operation = this.#db.get<Operation>('operations', id)
      if (!operation || operation.taskId !== taskId) throw new Error('Operation does not belong to this task')
      if (operation.reconciliation?.status === 'verified' || operation.reconciliation?.status === 'acknowledged') return operation
      if (task.status !== 'needs_reconciliation' || operation.status !== 'unknown_effect') {
        throw new Error('Operation is not awaiting reconciliation')
      }
      const reconciliation: NonNullable<Operation['reconciliation']> = {
        status: 'acknowledged',
        evidence: 'user_acknowledged_after_inspection',
        ...(operation.reconciliation?.evidence ? { previousEvidence: operation.reconciliation.evidence } : {}),
      }
      const next: Operation = { ...operation, status: 'unknown_effect', reconciliation }
      const graph = this.#graphs.get(taskId)
      if (graph) {
        this.#invalidateOnRollback(taskId)
        graph.unresolvedWriteOps.delete(id)
        graph.unknownWriteOps.set(id, next)
      }
      this.#db.put('operations', id, next)
      this.#event(task, 'operation.reconciliation_acknowledged', { operationId: id, ...reconciliation })
      this.#settleReconciledTask(task, checkpointReady)
      return next
    })
  }

  resolveTaskReconciliation(taskId: string, checkpointReady: boolean): TaskSnapshot {
    return this.#db.transaction(() => {
      const task = this.getMeta(taskId)
      if (task.status !== 'needs_reconciliation') throw new Error('Task is not awaiting reconciliation')
      if (this.operations(taskId).some(item => isUnresolvedEffect(item) || item.status === 'started')) {
        throw new Error('Pending operations require reconciliation before resolving the task')
      }
      this.#event(task, 'task.reconciliation_resolved', {
        reason: task.reconciliationBlock ?? task.reason,
        checkpointReady,
      })
      if (checkpointReady) {
        return this.#hydrateTask(this.#transition({ ...task, reason: undefined, reconciliationBlock: undefined }, 'stopped', 'task.stopped'))
      }
      return this.#hydrateTask(this.#finish({ ...task, reconciliationBlock: undefined }, 'failed', 'checkpoint_error'))
    })
  }

  beginTool(taskId: string, event: EventDraft, id: string, tool: string, effect: Operation['effect'], target?: string,
    phase?: 'verification', policy?: { deferred?: boolean; whileActive?: boolean }, filePostcondition?: FilePostcondition,
    callFingerprint?: string): void {
    this.#db.transaction(() => {
      const task = this.getMeta(taskId)
      const graph = this.#graph(taskId, task)
      const expected = phase === 'verification' ? 'verifying' : 'running'
      const nodeId = event.taskNodeId ?? task.rootNodeId
      const active = this.#activeNodes(graph)
      const node = active.find(({ id: current }) => current === nodeId)
      if (task.status !== expected || event.taskId !== taskId || !task.attemptId ||
        this.#toolWorkBlock(taskId, policy?.whileActive ? event.agentRunId : undefined, node?.worktreeId, tool, effect, graph)) {
        throw new Error('Task is not accepting tool work')
      }
      if (this.#db.get('operations', id)) throw new Error('Duplicate tool call')
      const suspendedCount = node ? (node.suspendedForIds?.length ?? (node.suspendedFor ? 1 : 0)) : 0
      if (nodeId !== task.rootNodeId && (!node || phase === 'verification' || suspendedCount > 0)) {
        throw new Error('Node is not accepting tool work')
      }
      const attemptId = node?.attemptId ?? task.attemptId
      if (event.taskAttemptId !== undefined && event.taskAttemptId !== attemptId) throw new Error('Tool attempt is stale')
      if (effect === 'write' && ((node && !canWrite(node.access)) || task.workspaceAccess === 'read')) {
        throw new Error('Task scope denies writes')
      }
      if (phase === 'verification' && effect === 'write' && task.workspaceAccess !== 'trusted') {
        throw new Error('Command verification requires trusted workspace access')
      }
      if (active.some(other => {
        const suspendedIds = other.suspendedForIds ?? (other.suspendedFor ? [other.suspendedFor] : [])
        return other.id !== nodeId && !suspendedIds.includes(nodeId) &&
          !separateWorktrees(node?.worktreeId, other.worktreeId) && (effect === 'write' || canWrite(other.access))
      })) {
        throw new Error('Concurrent workspace access conflicts with a write')
      }
      const operation: Operation = {
        schemaVersion: 1, id, taskId, taskRunId: task.taskRunId, attemptId,
        agentRunId: event.agentRunId, agentId: event.agentId, sessionId: event.sessionId,
        taskNodeId: nodeId, parentAgentRunId: event.parentAgentRunId,
        tool, effect, target, status: 'started', ...(policy?.deferred ? { managed: true } : {}),
        ...(callFingerprint ? { callFingerprint } : {}),
        ...(filePostcondition ? { filePostcondition } : {}),
        ...(node?.worktreeId ? { worktreeId: node.worktreeId } : {}),
      }
      if (effect === 'write') {
        this.#invalidateOnRollback(taskId)
        graph.activeWriteOps.set(id, operation)
      }
      this.#db.put('operations', id, operation)
      this.#db.append({ ...event, taskRunId: task.taskRunId, taskAttemptId: attemptId, taskNodeId: nodeId,
        type: 'tool.started', payload: { id, tool, effect, ...(policy?.deferred ? { managed: true } : {}) } })
    })
  }

  finishTool(event: EventDraft, id: string, status: Exclude<Operation['status'], 'started'>, reason?: ToolFailureReason,
    changedPaths?: readonly string[]): void {
    this.#db.transaction(() => {
      const operation = this.#db.get<Operation>('operations', id)
      if (!operation || operation.taskId !== event.taskId || operation.status !== 'started' ||
        (event.taskAttemptId !== undefined && event.taskAttemptId !== operation.attemptId) ||
        (event.agentRunId !== undefined && event.agentRunId !== operation.agentRunId)) throw new Error('Tool receipt is not open')
      const paths = status === 'succeeded' && operation.effect === 'write'
        ? changedPaths?.slice(0, 12).filter(path => typeof path === 'string' && path.length <= 256) : undefined
      const rawTargets = status === 'succeeded' && operation.effect === 'write' && fileWriteTools.has(operation.tool)
        ? (paths?.length ? paths : operation.target ? [operation.target] : []) : []
      let targetDigests: string[] | undefined
      if (rawTargets.length) {
        const task = this.getMeta(event.taskId)
        let key = this.#db.get<string>('task-private', 'file-target-digest-key')
        if (!key) {
          key = randomBytes(32).toString('hex')
          this.#db.put('task-private', 'file-target-digest-key', key)
        }
        targetDigests = [...new Set(rawTargets.map(path => {
          const scope = JSON.stringify([task.cwd, operation.worktreeId ?? null, path])
          return 'sha256:' + createHmac('sha256', key).update(scope).digest('hex')
        }))]
      }
      const nextOp: Operation = { ...operation, status, ...(paths?.length ? { changedPaths: paths } : {}) }
      const graph = this.#graphs.get(event.taskId)
      if (graph) {
        this.#invalidateOnRollback(event.taskId)
        graph.activeWriteOps.delete(id)
        if (nextOp.effect === 'write' && nextOp.status === 'unknown_effect') {
          graph.unknownWriteOps.set(id, nextOp)
        }
        if (nextOp.effect === 'write' && isUnresolvedEffect(nextOp)) {
          graph.unresolvedWriteOps.set(id, nextOp)
        }
      }
      this.#db.put('operations', id, nextOp)
      this.#db.append({ ...event, taskRunId: operation.taskRunId, taskAttemptId: operation.attemptId, taskNodeId: operation.taskNodeId,
        type: 'tool.finished', payload: { id, tool: operation.tool, status, reason, ...(targetDigests ? { targetDigests } : {}) } })
    })
  }

  attachProcess(taskId: string, id: string, pid: number): void {
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fff_ffff) throw new Error('Invalid managed process identity')
    this.#db.transaction(() => {
      const operation = this.#db.get<Operation>('operations', id)
      if (!operation || operation.taskId !== taskId || operation.tool !== 'shell_exec' ||
        operation.status !== 'started' || !operation.managed || operation.processId !== undefined) {
        throw new Error('Managed shell receipt is not open')
      }
      const nextOp = { ...operation, processId: pid }
      const graph = this.#graphs.get(taskId)
      if (graph?.activeWriteOps.has(id)) {
        this.#invalidateOnRollback(taskId)
        graph.activeWriteOps.set(id, nextOp)
      }
      this.#db.put('operations', id, nextOp)
    })
  }

  beginVerification(taskId: string): void {
    this.#db.transaction(() => { this.#transition(this.getMeta(taskId), 'verifying') })
  }

  auditToolApproval(event: EventDraft, id: string, tool: string, approved: boolean, approvalKind?: ApprovalKind, automatic?: boolean): void {
    this.#db.transaction(() => { this.#db.append({ ...event, type: 'tool.approval_resolved', payload: { id, tool, approved, approvalKind, automatic } }) })
  }

  auditToolDenial(event: EventDraft, tool: string, effect: 'read' | 'write',
    reason: 'policy' | 'approval_safety' | 'repeated_failure' | 'approval_unattended'): void {
    this.#db.transaction(() => { this.#db.append({ ...event, type: 'tool.denied', payload: { tool, effect, reason } }) })
  }

  continueExecution(taskId: string): void {
    this.#db.transaction(() => { this.#transition(this.getMeta(taskId), 'running') })
  }

  verify(taskId: string, verification: VerificationResult): TaskSnapshot {
    return this.#db.transaction(() => {
      const task = this.getMeta(taskId)
      const graph = this.#graph(taskId, task)
      if (task.status !== 'verifying') throw new Error('Invalid task transition from ' + task.status + ' to verified')
      const verified = confirmedCheck(verification)
      const result: VerificationResult = task.check
        ? {
          ...verification,
          passed: verified, verdict: verified ? 'verified' : 'failed',
          basis: task.check.command ? 'project_command' : 'workspace_path',
        }
        : {
          passed: false, verdict: verified || verification.verdict === 'unverified' ? 'unverified' : 'failed',
          evidence: verification.passed ? 'no_declared_check' : verification.evidence, basis: 'none',
        }
      const completed = result.verdict === 'verified' || result.verdict === 'unverified'
      const legacyWorker = task.legacyWorkerId ? graph.nodesById.get(task.legacyWorkerId) : undefined
      if (graph.activeIds.size > 0 ||
        (completed && graph.nonSucceededIds.size > 0) ||
        (!completed && legacyWorker?.status === 'ready')) {
        throw new Error('Worker outcome prevents task acceptance')
      }
      if (graph.activeWriteOps.size > 0 || graph.unresolvedWriteOps.size > 0 ||
        this.operations(taskId).some(operation => operation.status === 'started' || isUnresolvedEffect(operation))) {
        throw new Error('Tool receipts prevent task acceptance')
      }
      this.#event(task, 'verification.finished', { ...result, executionStatus: 'completed' })
      const finished = this.#finish({ ...task, verification: result }, completed ? 'succeeded' : 'failed',
        completed ? undefined : 'verification_failed')
      return this.#hydrateTask(finished, graph)
    })
  }

  end(taskId: string, reason: EndReason): TaskSnapshot {
    return this.#db.transaction(() => {
      let task = this.getMeta(taskId)
      const graph = this.#graph(taskId, task)
      if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'blocked' ||
        task.status === 'stopped' || task.status === 'needs_reconciliation') {
        return this.#hydrateTask(task, graph)
      }
      const operations = this.operations(taskId)
      const unknown = operations.filter(operation =>
        operation.effect === 'write' && (operation.status === 'started' || isUnresolvedEffect(operation)))
      for (const operation of operations) {
        if (operation.status !== 'started') continue
        const status = operation.effect === 'write' ? 'unknown_effect' : 'interrupted'
        const updatedOp = { ...operation, status } as Operation
        this.#invalidateOnRollback(taskId)
        graph.activeWriteOps.delete(operation.id)
        if (updatedOp.effect === 'write' && updatedOp.status === 'unknown_effect') {
          graph.unknownWriteOps.set(operation.id, updatedOp)
        }
        if (isUnresolvedEffect(updatedOp)) graph.unresolvedWriteOps.set(operation.id, updatedOp)
        this.#db.put('operations', operation.id, updatedOp)
        this.#db.append({
          taskId, taskRunId: task.taskRunId, taskAttemptId: operation.attemptId, taskNodeId: operation.taskNodeId,
          agentRunId: operation.agentRunId, agentId: operation.agentId, sessionId: operation.sessionId,
          parentAgentRunId: operation.parentAgentRunId, type: 'tool.finished',
          payload: { id: operation.id, tool: operation.tool, status },
        })
      }
      const affectedIds = new Set<string>(graph.activeIds)
      for (const op of unknown) {
        if (op.taskNodeId) affectedIds.add(op.taskNodeId)
      }
      for (const nodeId of affectedIds) {
        const node = graph.nodesById.get(nodeId)
        if (!node) continue
        const unresolved = unknown.some(({ attemptId }) => attemptId === node.attemptId)
        if (node.status !== 'running' && !unresolved) continue
        const legacy = Boolean(node.isLegacyWorker || task.legacyWorkerId === node.id)
        const interruption = legacy ? undefined : interruptedWrite(operations.filter(({ attemptId }) => attemptId === node.attemptId))
        const status = unresolved ? 'unknown_effect' : 'interrupted'
        this.#finishAttempt(node.attemptId, status, unresolved ? 'unknown_effect' : reason)
        if (unresolved && node.verification?.evidence === 'node_unknown_effect') continue
        const nextNode: StoredTaskNode = {
          ...node,
          status: interruption || unresolved ? 'failed' : 'ready',
          ...(interruption ? { result: interruption.result, verification: interruption.verification } : {}),
        }
        delete nextNode.suspendedFor
        delete nextNode.suspendedForIds
        this.#putNode(graph, nextNode)
        this.#nodeEvent(task, node, legacy ? 'task.worker_settled' : 'task.node_settled', {
          status: interruption ? 'failed' : status,
          ...(!legacy ? { attemptStatus: status } : {}),
          ...(interruption ? { evidenceRefs: interruption.result.evidenceRefs, verification: interruption.verification } : {}),
        })
      }
      if (unknown.length || reason === 'checkpoint_error' || reason === 'stop_timeout') {
        this.#event(task, 'operation.reconciliation_required', { operationIds: unknown.map((operation) => operation.id), reason })
        const reconciliationBlock = reason === 'checkpoint_error' || reason === 'stop_timeout' ? reason : undefined
        return this.#hydrateTask(
          this.#finish({ ...task, reconciliationBlock }, 'needs_reconciliation', unknown.length ? 'unknown_effect' : reason),
          graph,
        )
      }
      if (task.status === 'stop_requested') task = this.#transition(task, 'stopping')
      if (task.status === 'stopping') {
        return this.#hydrateTask(
          this.#finish(task, 'stopped', task.stopIntent?.source === 'shutdown' ? 'host_shutdown' : 'user_stop', 'task.stopped'),
          graph,
        )
      }
      if (reason === 'process_interrupted' || reason === 'model_interrupted') {
        return this.#hydrateTask(this.#finish(task, 'stopped', reason, 'task.stopped'), graph)
      }
      if (reason === 'model_error' || reason === 'model_output_limit' || reason === 'tool_retry_loop') {
        return this.#hydrateTask(this.#finish(task, 'blocked', reason), graph)
      }
      return this.#hydrateTask(this.#finish(task, 'failed', reason), graph)
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
