import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { AgentMailbox, formatMailboxPrompt, nodeEventKey, nodeFailureReason, notificationFromNode } from './agent-mailbox.ts'
import type { NodeCompletionNotification } from './agent-mailbox.ts'
import { delegationTool, handoffs, inspectNodesTool, planTool, replanTool, waitNodesTool } from './agent-plan.ts'
import { ModelUnavailableError } from './execution.ts'
import type { AgentExecution, ExecutionConfig, ExecutionSession, ExecutionTool, RuntimeEvent } from './execution.ts'
import type { EndReason, EventDraft, ModelRoute, SessionRef, WorkspaceAccess } from './contracts/domain.ts'
import type { LocalJudgment } from './judgment.ts'
import { frameInstruction, preflight, skillDisclosure } from './input-judgment.ts'
import type { ScopedContext } from './memory.ts'
import { inferTaskRole, ModelBudgetError } from './model-scheduler.ts'
import type { LocalModelScheduler } from './model-scheduler.ts'
import type { AgentRole, CapabilityGrant, CodingCapabilities, CodingProfile, ExtensionRegistry } from './policies.ts'
import type { LocalStore } from './store.ts'
import { isUnresolvedEffect } from './task-engine.ts'
import type { NodeProposal, TaskEngine, TaskSnapshot, WorkerNode, WorkerResult } from './task-engine.ts'
import type { ToolApprovalBroker } from './tool-approval.ts'
import type { ToolApprovalMode } from '../../shared/contracts/tool-approval.ts'
import { ToolRun } from './tool-run.ts'
import { ToolEvidenceArchive } from './tool-judgment.ts'
import { followUpAllows, reviewCompletion } from './turn-judgment.ts'
import type { TurnFollowUp } from './turn-judgment.ts'
import { verifyWorkspace } from './verification.ts'
import { VisualTelemetry } from './visual-workflow.ts'
import { workspaceTarget } from './workspace.ts'
import type { CodingWorkspace } from './workspace.ts'
import { redactProcessOutput } from './workspace-process.ts'

interface AgentRecord {
  schemaVersion: 1
  id: string
  taskId: string
  role: AgentRole
  parentAgentId?: string
  session: SessionRef
  route: ModelRoute
}

interface TeamIdentityRecord {
  schemaVersion: 1
  id: string
  teamKey: string
  taskId: string
  conversationId?: string
  createdAt: string
}

interface TeamSessionRecord {
  schemaVersion: 1
  identityKey: string
  agentId: string
  session: SessionRef
  route: ModelRoute
  cwd: string
  updatedAt: string
}

interface AgentRun {
  schemaVersion: 1
  event: EventDraft
  status: 'active' | 'completed' | 'interrupted' | 'failed'
  role?: AgentRole
}

export interface OutputEvent {
  taskId: string
  agentRunId: string
  role: AgentRole
  delta: string
}

type Outcome =
  | { status: 'completed'; route: ModelRoute; textProduced: boolean; event: EventDraft }
  | { status: 'interrupted' | 'model_error' | 'model_output_limit' | 'runtime_error' | 'checkpoint_error' | 'budget_exhausted' | 'tool_retry_loop' }

export type HarnessMode = 'fast' | 'quality'
const deadlines: Record<HarnessMode, { root: number; child: number }> = {
  fast: { root: 600_000, child: 120_000 }, quality: { root: 900_000, child: 300_000 },
}
type ProfileRuntime = ReturnType<ExtensionRegistry['resolve']>
type WorkerHandoff = WorkerResult & { verification?: WorkerNode['verification']; failureReason?: string }

interface ActiveScope {
  event: EventDraft
  route: ModelRoute
  workspace: CodingWorkspace
}

interface TaskCoordinator {
  mailbox: AgentMailbox
  activeNodes: Map<string, Promise<WorkerHandoff | undefined>>
  activeScopes: Map<string, ActiveScope>
  scheduleAll(): void
  launchNode(
    node: WorkerNode,
    parent: EventDraft,
    workspace: CodingWorkspace,
    parentRoute: ModelRoute,
    parentScope: CapabilityGrant,
    signal: AbortSignal,
    suspendParent: boolean,
  ): Promise<WorkerHandoff | undefined>
  hasPendingWork(ownerNodeId: string): boolean
  hasWorkspaceConflict(ownerNodeId: string, worktreeId?: string): boolean
}

/** Provider-independent primary project/conversation memory scope so cross-provider Workers share knowledge. */
export function memoryScope(task: TaskSnapshot, _route?: ModelRoute): string {
  return JSON.stringify([task.conversationId ?? task.cwd])
}

export function legacyProviderMemoryScope(task: TaskSnapshot, provider: string): string {
  return JSON.stringify([task.conversationId ?? task.cwd, provider])
}

export function teamMemoryScope(task: TaskSnapshot, teamKey: string): string {
  return JSON.stringify([task.conversationId ?? task.cwd, 'team', teamKey])
}

/** Stable logical Team identifier decoupled from access, scopePath, tools, worktreeId, and Provider. */
export function stableTeamIdentityKey(task: Pick<TaskSnapshot, 'id' | 'conversationId'>, teamKey: string): string {
  return 'team-' + createHash('sha256').update(JSON.stringify([task.conversationId ?? task.id, teamKey])).digest('hex')
}

function teamSessionStorageKey(identityKey: string, provider: string, cwd: string): string {
  return 'session-' + createHash('sha256').update(JSON.stringify([identityKey, provider, cwd])).digest('hex')
}

function receiptId(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 32)
}

function deferredResultPrompt(receipts: readonly string[]): string {
  return 'A shell command was still running when you responded. Its recorded result is now: ' + receipts.join(', ') +
    '. Check the process status and output before finalizing. If the result is uncertain, inspect using scoped read-only tools and explain what needs verification. Do not rerun a command with unknown effects.'
}

function descendantsOf(nodes: readonly WorkerNode[], parentId: string): WorkerNode[] {
  const result: WorkerNode[] = []
  const queue = [parentId]
  const seen = new Set<string>()
  while (queue.length) {
    const current = queue.shift()!
    for (const node of nodes) {
      if (node.parentNodeId !== current || seen.has(node.id)) continue
      seen.add(node.id)
      result.push(node)
      queue.push(node.id)
    }
  }
  return result
}

function safeErrorReason(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.message) return undefined
  const clean = redactProcessOutput(error.message).replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim().slice(0, 180)
  return clean || undefined
}

const accessRank: Record<WorkspaceAccess, number> = { read: 0, write: 1, trusted: 2 }

export class MultiAgentOrchestrator {
  readonly #db: LocalStore
  readonly #tasks: TaskEngine
  readonly #execution: AgentExecution
  readonly #scheduler: LocalModelScheduler
  readonly #capabilities: CodingCapabilities
  readonly #profile: Readonly<CodingProfile>
  readonly #context: ScopedContext
  readonly #judgment: LocalJudgment
  readonly #extensions: ProfileRuntime
  readonly #approval: ToolApprovalBroker
  readonly #approvalMode: (task: TaskSnapshot) => ToolApprovalMode
  readonly #approvalContext?: (taskId: string) => { conversationId?: string; conversationTitle?: string } | undefined
  readonly #toolEvidence: ToolEvidenceArchive
  readonly #resolveWorkspace?: (workspace: CodingWorkspace, taskId: string, id: string, signal: AbortSignal) => Promise<CodingWorkspace | undefined>
  readonly #sessions: string
  readonly #mode: HarnessMode
  readonly #onOutput?: (event: EventDraft, delta: string) => void
  readonly #onCheckpoint?: (taskId: string) => void
  readonly #outputSinks = new Set<(event: OutputEvent) => void | Promise<void>>()
  readonly #steering = new Map<string, (id: string, text: string) => Promise<boolean>>()
  readonly #openingConversations = new Set<string>()
  readonly #activeTeams = new Set<string>()

  constructor(ports: {
    store: LocalStore; tasks: TaskEngine; execution: AgentExecution; scheduler: LocalModelScheduler;
    capabilities: CodingCapabilities; profile: Readonly<CodingProfile>; context: ScopedContext; judgment: LocalJudgment; sessions: string;
    extensions: ProfileRuntime
    approval: ToolApprovalBroker
    approvalMode?: (task: TaskSnapshot) => ToolApprovalMode
    approvalContext?: (taskId: string) => { conversationId?: string; conversationTitle?: string } | undefined
    mode?: HarnessMode
    resolveWorkspace?: (workspace: CodingWorkspace, taskId: string, id: string, signal: AbortSignal) => Promise<CodingWorkspace | undefined>
    onOutput?: (event: EventDraft, delta: string) => void
    onCheckpoint?: (taskId: string) => void
  }) {
    this.#db = ports.store
    this.#tasks = ports.tasks
    this.#execution = ports.execution
    this.#scheduler = ports.scheduler
    this.#capabilities = ports.capabilities
    this.#profile = ports.profile
    this.#context = ports.context
    this.#judgment = ports.judgment
    this.#extensions = ports.extensions
    this.#approval = ports.approval
    this.#approvalMode = ports.approvalMode ?? (() => 'ask')
    this.#approvalContext = ports.approvalContext
    this.#toolEvidence = new ToolEvidenceArchive(this.#db)
    this.#resolveWorkspace = ports.resolveWorkspace
    this.#sessions = ports.sessions
    this.#mode = ports.mode ?? 'quality'
    this.#onOutput = ports.onOutput
    this.#onCheckpoint = ports.onCheckpoint
  }

  #runtimePolicy(workspace: CodingWorkspace, scope: CapabilityGrant) {
    return {
      instructionScopes: { user: join(dirname(this.#sessions), 'instructions'),
        ...(scope.access === 'trusted' && !scope.path ? { project: workspace.root } : {}) },
      skillReadsAllowed: () => this.#capabilities.enabled('read_skill') &&
        (scope.tools === undefined || scope.tools.includes('read_skill')),
      reasoningEffort: this.#mode === 'fast' ? 'low' as const : undefined,
    }
  }

  #resolveRootGrant(taskId: string): CapabilityGrant {
    const current = this.#tasks.get(taskId)
    return this.#capabilities.root(current.workspaceAccess, Boolean(current.check))
  }

  #resolveNodeGrant(taskId: string, nodeId: string): CapabilityGrant | undefined {
    const current = this.#tasks.get(taskId)
    const rootGrant = this.#capabilities.root(current.workspaceAccess, Boolean(current.check))
    if (nodeId === current.rootNodeId) return rootGrant
    const node = current.worker?.id === nodeId ? current.worker : current.nodes?.find(item => item.id === nodeId)
    if (!node) return undefined
    let parentGrant = rootGrant
    if (node.parentNodeId !== current.rootNodeId) {
      const parentNode = current.nodes?.find(item => item.id === node.parentNodeId)
      if (!parentNode) return undefined
      parentGrant = this.#capabilities.clamp(rootGrant, parentNode.access, parentNode.scopePath, 'team', parentNode.tools, parentNode.disallowedTools)
    }
    return this.#capabilities.clamp(parentGrant, node.access, node.scopePath, node.role ?? 'worker', node.tools, node.disallowedTools)
  }

  #childScope(workspace: CodingWorkspace, parent: CapabilityGrant, proposal: Partial<NodeProposal>, role: 'team' | 'worker'): CapabilityGrant {
    const scope = this.#capabilities.child(parent, proposal.access, proposal.scopePath, role, proposal.tools, proposal.disallowedTools)
    const checkedTools = new Set([...(proposal.tools ?? []), ...(proposal.disallowedTools ?? [])])
    if (checkedTools.size) {
      const allowed = new Set(this.#extensions.tools(workspace, role, scope.access)
        .filter(tool => this.#capabilities.describe({ ...scope, disallowedTools: undefined }, tool)).map(tool => tool.name))
      if (this.#runtimePolicy(workspace, scope).skillReadsAllowed()) allowed.add('read_skill')
      if (proposal.tools?.some(name => !allowed.has(name))) throw new Error('Requested tool is outside the effective capability scope')
    }
    return scope
  }

  async validatePlan(taskId: string, workspace: CodingWorkspace, proposals: NodeProposal[]): Promise<void> {
    if (!Array.isArray(proposals) || !proposals.length) throw new Error('Invalid plan size')
    const task = this.#tasks.get(taskId)
    const rootScope = this.#capabilities.root(task.workspaceAccess, Boolean(task.check))
    const teamScopes = new Map<string, CapabilityGrant>()
    for (const existing of task.nodes ?? []) {
      if (existing.role === 'team' && existing.parentNodeId === task.rootNodeId) {
        teamScopes.set(existing.id, this.#childScope(workspace, rootScope, existing, 'team'))
      }
    }
    for (const proposal of proposals) {
      if (!proposal || typeof proposal !== 'object') throw new Error('Invalid node proposal')
      const role = proposal.role ?? (proposal.teamKey ? 'team' : 'worker')
      if (role !== 'team' && role !== 'worker') throw new Error('Invalid Agent role')
      if (!proposal.parentNodeId || proposal.parentNodeId === task.rootNodeId) {
        const scope = this.#childScope(workspace, rootScope, proposal, role)
        if (role === 'team' && typeof proposal.ref === 'string') teamScopes.set(proposal.ref, scope)
      } else {
        const parentScope = teamScopes.get(proposal.parentNodeId)
        if (!parentScope || role !== 'worker') throw new Error('Invalid nested node scope')
        this.#childScope(workspace, parentScope, proposal, 'worker')
      }
      // Fresh planned nodes can select any authorized model route, including cross-provider routes.
      if (proposal.route) await this.#scheduler.validateRoute(proposal.route)
    }
  }

  subscribeOutput(sink: (event: OutputEvent) => void | Promise<void>): () => void {
    this.#outputSinks.add(sink)
    return () => { this.#outputSinks.delete(sink) }
  }

  rootRoute(taskId: string): ModelRoute | undefined {
    const task = this.#tasks.get(taskId)
    return task.conversationId ? this.conversationRoute(task.conversationId) : this.#db.get<AgentRecord>('agents', taskId)?.route
  }

  conversationRoute(conversationId: string): ModelRoute | undefined {
    return this.#db.get<AgentRecord>('agents', conversationId)?.route
  }

  isOpeningConversation(conversationId: string): boolean {
    return this.#openingConversations.has(conversationId)
  }

  steer(taskId: string, instructionId: string, text: string): Promise<boolean> {
    return this.#steering.get(taskId)?.(instructionId, text) ?? Promise.resolve(false)
  }

  session(taskId: string): SessionRef | undefined {
    const task = this.#tasks.get(taskId)
    return this.#db.get<SessionRef>('task-sessions', taskId)
      ?? this.#db.get<AgentRecord>('agents', task.conversationId ?? taskId)?.session
  }

  clearBrokenSession(taskId: string): void {
    this.#db.transaction(() => {
      const task = this.#tasks.get(taskId)
      const agentKey = task.conversationId ?? taskId
      this.#db.delete('task-sessions', taskId)
      this.#db.delete('agents', agentKey)
    })
  }

  recover(): void {
    this.#db.transaction(() => {
      for (const run of this.#db.list<AgentRun>('agent-runs')) {
        if (run.status !== 'active' || !run.event.agentRunId) continue
        this.#db.put('agent-runs', run.event.agentRunId, { ...run, status: 'interrupted' })
        const taskRunId = this.#tasks.get(run.event.taskId).taskRunId
        this.#db.append({ ...run.event, taskRunId, type: 'agent.finished', payload: {
          role: run.role, status: 'interrupted', reason: 'process_interrupted',
          lifecycle: run.role === 'team' ? 'idle' : 'released',
        } })
      }
    })
  }

  #emit(event: EventDraft, runtime: RuntimeEvent, role: AgentRecord['role']): void {
    if (runtime.type === 'model.route_changed' || runtime.type === 'instruction.applied' || runtime.type === 'prompt.accepted') return
    if (runtime.type === 'message.delta') {
      if (role === 'root' && runtime.delta) this.#onOutput?.(event, runtime.delta)
      const output = { taskId: event.taskId, agentRunId: event.agentRunId!, role, delta: runtime.delta }
      for (const sink of this.#outputSinks) {
        queueMicrotask(() => {
          if (!this.#outputSinks.has(sink)) return
          void Promise.resolve().then(() => sink(output)).catch(() => {})
        })
      }
      return
    }
    const { type, ...payload } = runtime
    if (this.#db.isClosed) return
    this.#db.transaction(() => { this.#db.append({ ...event, type, payload }) })
  }

  #register(task: TaskSnapshot, session: ExecutionSession, event: EventDraft, agentKey: string, role: AgentRole,
    maxDurationMs: number, parentAgentId?: string, teamBinding?: { key: string; teamKey: string; cwd: string }): EventDraft {
    const recorded = { ...event, sessionId: session.ref.id }
    this.#db.transaction(() => {
      const agent: AgentRecord = { schemaVersion: 1, id: event.agentId!, taskId: task.id, role, session: session.ref, route: session.route, parentAgentId }
      const run: AgentRun = { schemaVersion: 1, event: recorded, role, status: 'active' }
      this.#db.put('agents', agentKey, agent)
      if (teamBinding) {
        const existingIdentity = this.#db.get<TeamIdentityRecord>('team-identities', teamBinding.key)
        if (!existingIdentity) {
          this.#db.put('team-identities', teamBinding.key, {
            schemaVersion: 1,
            id: event.agentId!,
            teamKey: teamBinding.teamKey,
            taskId: task.id,
            conversationId: task.conversationId,
            createdAt: new Date().toISOString(),
          } satisfies TeamIdentityRecord)
        }
        const sessionKey = teamSessionStorageKey(teamBinding.key, session.route.provider, teamBinding.cwd)
        this.#db.put('team-sessions', sessionKey, {
          schemaVersion: 1,
          identityKey: teamBinding.key,
          agentId: event.agentId!,
          session: session.ref,
          route: session.route,
          cwd: teamBinding.cwd,
          updatedAt: new Date().toISOString(),
        } satisfies TeamSessionRecord)
      }
      if (role === 'root') this.#db.put('task-sessions', task.id, session.ref)
      this.#db.put('agent-runs', event.agentRunId!, run)
      this.#db.append({ ...recorded, type: 'agent.started', payload: { role, route: session.route, parentAgentId,
        lifecycle: 'active', harnessMode: this.#mode, maxDurationMs,
        reasoningPolicy: this.#mode === 'fast' ? 'low' : 'provider_default' } })
    })
    return recorded
  }

  #finish(event: EventDraft, status: AgentRun['status'], result?: WorkerResult, role: AgentRole = 'root'): void {
    if (this.#db.isClosed) return
    this.#db.transaction(() => {
      const run: AgentRun = { schemaVersion: 1, event, status, role }
      this.#db.put('agent-runs', event.agentRunId!, run)
      const taskStatus = this.#tasks.get(event.taskId).status
      if (taskStatus === 'succeeded' || taskStatus === 'failed' || taskStatus === 'blocked' ||
        taskStatus === 'stopped' || taskStatus === 'needs_reconciliation') {
        return
      }
      this.#db.append({
        ...event, type: 'agent.finished',
        payload: { role, status, lifecycle: role === 'team' ? 'idle' : 'released',
          ...(result ? { evidenceCount: result.evidenceRefs.length } : {}) },
      })
    })
  }

  #watchStop(session: ExecutionSession, signal: AbortSignal): () => Promise<void> {
    let stopping: Promise<void> | undefined
    const abort = () => {
      try {
        stopping ??= session.requestStop()
      } catch (error) {
        stopping = Promise.reject(error)
      }
      void stopping.catch(() => {})
    }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    return async () => {
      signal.removeEventListener('abort', abort)
      await stopping
    }
  }

  #isCompatibleTeamSession(record: { session: SessionRef; route: ModelRoute; cwd?: string } | undefined,
    expectedRoute: ModelRoute | undefined, cwd: string): SessionRef | undefined {
    if (!record) return undefined
    if (record.cwd && record.cwd !== cwd) return undefined
    if (expectedRoute && !this.#scheduler.canResumeSession(record.route, expectedRoute)) return undefined
    if (this.#execution.verifySession && !this.#execution.verifySession(record.session, cwd)) return undefined
    return record.session
  }

  async #worker(task: TaskSnapshot, node: WorkerNode, parent: EventDraft, workspace: CodingWorkspace,
    parentRoute: ModelRoute, parentScope: CapabilityGrant, rootSignal: AbortSignal,
    suspendParent = false, coordinator?: TaskCoordinator): Promise<WorkerHandoff | undefined> {
    const role = node.role ?? 'worker'
    const deadline = new AbortController()
    const stalled = new AbortController()
    const timeMs = Math.min(node.budget?.timeMs ?? Infinity, deadlines[this.#mode].child)
    const timer = setTimeout(() => deadline.abort(), timeMs)
    timer.unref()
    const signal = AbortSignal.any([rootSignal, deadline.signal, stalled.signal])
    let event: EventDraft = {
      taskId: task.id, taskRunId: task.taskRunId, taskNodeId: node.id,
      agentId: randomUUID(), agentRunId: randomUUID(), parentAgentRunId: parent.agentRunId, type: '', payload: {},
    }
    const evidence = new Set<string>()
    const artifacts = new Set<string>()
    const toolRun = new ToolRun(this.#tasks, this.#approval, this.#judgment, this.#toolEvidence, () => stalled.abort(),
      () => this.#approvalMode(task), this.#approvalContext)
    let followUp: TurnFollowUp | undefined
    let session: ExecutionSession | undefined
    let unwatch: (() => Promise<void>) | undefined
    let lease: ReturnType<LocalModelScheduler['reserve']> | undefined
    let result: WorkerHandoff | undefined
    let executionCompleted = false
    let verification: Awaited<ReturnType<typeof verifyWorkspace>> | undefined
    let started = false
    let registered = false
    let teamLease: string | undefined
    let scopeRegistered = false
    let workspaceActive = false
    let exhausted = false
    let modelFailed = false
    let caughtReason: string | undefined
    let lastOutcomeStatus: string | undefined
    const blockingWrite = (managedOwner?: string) => this.#tasks.blocksToolWork(task.id, managedOwner, node.worktreeId)

    try {
      if (rootSignal.aborted || blockingWrite()) return undefined
      const attemptId = this.#tasks.startWorker(task.id, node.id, { suspendParent })
      event = { ...event, taskAttemptId: attemptId }
      started = true

      if (node.worktreeId && parent.taskNodeId === task.rootNodeId) {
        const isolated = await this.#resolveWorkspace?.(workspace, task.id, node.worktreeId, signal)
        if (!isolated) throw new Error('Worktree ownership or registration could not be verified')
        workspace = isolated
      }

      const parentNode = this.#tasks.get(task.id).nodes?.find(item => item.id === node.parentNodeId)
      const scopes = [node, ...(parentNode ? [parentNode] : [])].flatMap(({ id, budget }) =>
        budget?.requests === undefined ? [] : [{ nodeId: id, requests: budget.requests }])
      if (!this.#scheduler.hasBudget(task.id, scopes)) {
        exhausted = true
        throw new ModelBudgetError('Delegated model budget exhausted')
      }
      lease = this.#scheduler.reserve(() => event, role, scopes)

      // Freshly resolve the runtime CapabilityGrant from current Task + Parent permissions (decoupled from Identity/Session).
      const liveGrant = this.#resolveNodeGrant(task.id, node.id) ?? this.#childScope(workspace, parentScope, node, role)
      const currentGrant = () => this.#resolveNodeGrant(task.id, node.id) ?? liveGrant

      // Decoupled stable logical Team identity (independent of access, path, tools, worktreeId, Provider).
      const teamIdentityKey = role === 'team' && node.teamKey
        ? stableTeamIdentityKey(task, node.teamKey)
        : undefined
      const existingIdentity = teamIdentityKey ? this.#db.get<TeamIdentityRecord>('team-identities', teamIdentityKey) : undefined
      const legacyAgent = teamIdentityKey ? this.#db.get<AgentRecord>('agents', teamIdentityKey) : undefined
      if (teamIdentityKey) {
        if (this.#activeTeams.has(teamIdentityKey)) throw new Error('Team Session is active')
        this.#activeTeams.add(teamIdentityKey)
        teamLease = teamIdentityKey
        const stableId = existingIdentity?.id ?? legacyAgent?.id
        if (stableId) event = { ...event, agentId: stableId }
      }

      // Resolve compatible saved Pi Session (strictly same Provider + same canonical cwd) vs fresh Session (allows cross-provider).
      let resumeCandidate: { session: SessionRef; route: ModelRoute; cwd?: string } | undefined
      if (teamIdentityKey) {
        const requestedProvider = node.route?.provider
        const exactKey = requestedProvider ? teamSessionStorageKey(teamIdentityKey, requestedProvider, workspace.root) : undefined
        const providerSession = exactKey ? this.#db.get<TeamSessionRecord>('team-sessions', exactKey) : undefined
        if (providerSession && this.#isCompatibleTeamSession(providerSession, node.route ?? providerSession.route, workspace.root)) {
          resumeCandidate = providerSession
        } else if (!node.route && legacyAgent && this.#isCompatibleTeamSession({
          session: legacyAgent.session, route: legacyAgent.route, cwd: task.cwd,
        }, legacyAgent.route, workspace.root)) {
          resumeCandidate = { session: legacyAgent.session, route: legacyAgent.route, cwd: task.cwd }
        }
      }

      const canResume = Boolean(resumeCandidate)
      const route = await this.#scheduler.allocate(
        event,
        parentRoute,
        node.route ?? resumeCandidate?.route,
        Boolean(node.role),
        node.goal,
        signal,
        {
          sessionMode: canResume ? 'resume' : 'fresh',
          ...(resumeCandidate ? { sessionRoute: resumeCandidate.route } : {}),
          taskRole: inferTaskRole(node.goal, Boolean(node.role)),
          remainingRequests: node.budget?.requests,
          allowFallback: !node.route && !canResume,
        },
      )
      const sessionToResume = this.#isCompatibleTeamSession(resumeCandidate, route, workspace.root)

      const availableTools = this.#extensions.tools(workspace, role, liveGrant.access)
        .filter(tool => this.#capabilities.describe(liveGrant, tool))
      const hasActiveChildren = () => Boolean(coordinator?.hasPendingWork(node.id)) ||
        (this.#tasks.get(task.id).nodes ?? []).some(child => child.parentNodeId === node.id && child.status === 'running')

      const tools: ExecutionTool[] = availableTools
        .map(tool => {
          const wrapped = toolRun.wrap(tool, workspace, () => event, signal, input => {
            const fresh = currentGrant()
            if (followUp && !followUpAllows(followUp, tool.name)) return false
            if (hasActiveChildren() && (!fresh || accessRank[fresh.access] > 0)) {
              // While yielded or coordinating running children, avoid conflicting writes in the same worktree.
              const effect = tool.policy?.effectFor?.(input) ?? tool.effect
              if (effect === 'write' && coordinator?.hasWorkspaceConflict(node.id, node.worktreeId)) return false
            }
            return this.#capabilities.authorize(fresh, tool, input)
          }, evidence, artifacts, node.goal, liveGrant.path)
          return {
            ...wrapped,
            execute: async (id: string, input: unknown, toolSignal?: AbortSignal) => {
              if (workspaceActive) return { ok: false, error: 'Another workspace tool is active' }
              workspaceActive = true
              try { return await wrapped.execute(id, input, toolSignal) } finally { workspaceActive = false }
            },
          } as ExecutionTool
        })

      const replay = !liveGrant.disallowedTools?.includes('read_tool_evidence') &&
        (!liveGrant.tools || liveGrant.tools.includes('read_tool_evidence')) &&
        this.#canArchiveToolEvidence(task.id) &&
        toolRun.replayTool(() => event, signal, name => availableTools.some(tool => tool.name === name &&
          this.#capabilities.describe(currentGrant(), tool) && followUpAllows(followUp, tool.name)))
      if (replay) tools.push(replay)

      const teamScopeNodes = () => (this.#tasks.get(task.id).nodes ?? []).filter(item => item.parentNodeId === node.id)

      if (role === 'team' && this.#profile.delegation) {
        if (this.#capabilities.enabled('delegate_worker')) tools.push(delegationTool('delegate_worker',
          async (id, input, toolSignal) => {
            const freshGrant = currentGrant()
            if (!this.#capabilities.enabled('delegate_worker') ||
              followUp || signal.aborted || toolSignal?.aborted || workspaceActive || blockingWrite()) {
              return { ok: false, error: 'Delegation unavailable' }
            }
            const goal = input.goal
            const nonEmptyGoal = goal.trim().length > 0
            const requestId = 'team:' + event.agentRunId + ':' + receiptId(id)
            if (!await this.#judgment.decide(event, 'delegation.worth', {
              role, goalLength: goal.length, nonEmptyGoal, goal, parentGoal: node.goal,
            }, nonEmptyGoal,
              nonEmptyGoal ? [true, false] : [false], [node.id], { planRequestId: requestId, signal }) ||
              !this.#capabilities.enabled('delegate_worker') ||
              signal.aborted || toolSignal?.aborted || workspaceActive || blockingWrite()) {
              return { ok: false, error: 'Delegation declined' }
            }
            try {
              this.#childScope(workspace, freshGrant, input, 'worker')
              if (input.route) await this.#scheduler.validateRoute(input.route)
              const child = this.#tasks.delegateScoped(task.id, requestId, node.id, input)
              if (child.result) {
                return {
                  ok: child.result.resultStatus === 'succeeded',
                  nodeId: child.id,
                  ...child.result,
                  verification: child.verification,
                  ...(nodeFailureReason(child) ? { failureReason: nodeFailureReason(child) } : {}),
                }
              }
              const wait = input.wait !== false
              const launchPromise = coordinator
                ? (coordinator.activeNodes.get(child.id) ?? coordinator.launchNode(
                    child, event, workspace, session!.route, freshGrant, signal, freshGrant.access !== 'read'))
                : this.#worker(task, child, event, workspace, session!.route, freshGrant, signal, freshGrant.access !== 'read', coordinator)
              if (!wait) {
                return { ok: true, scheduled: true, nodeId: child.id, status: 'running' }
              }
              const childResult = await launchPromise
              const settledChild = teamScopeNodes().find(item => item.id === child.id)
              if (settledChild && coordinator) {
                coordinator.mailbox.acknowledge(node.id, [nodeEventKey(settledChild)])
              }
              if (!childResult) return { ok: false, nodeId: child.id, error: 'Worker interrupted' }
              return {
                ok: childResult.resultStatus === 'succeeded',
                nodeId: child.id,
                ...childResult,
              }
            } catch {
              return { ok: false, error: 'Delegation rejected by task scope or budget' }
            }
          }))

        if (this.#capabilities.enabled('wait_task_nodes')) tools.push(waitNodesTool(async (_id, input, toolSignal) => {
          if (!coordinator) return { ok: true, timedOut: false, completedNodes: [], nodes: handoffs(teamScopeNodes()) }
          coordinator.scheduleAll()
          const scopedIds = input.nodeIds?.length
            ? input.nodeIds.filter(id => teamScopeNodes().some(child => child.id === id))
            : teamScopeNodes().map(child => child.id)
          const waitSignal = toolSignal ? AbortSignal.any([signal, toolSignal]) : signal
          const { timedOut, matched } = await coordinator.mailbox.waitForNodes(
            node.id, scopedIds, input.mode,
            () => ({
              nodes: teamScopeNodes(),
              activeIds: new Set(coordinator.activeNodes.keys()),
              runnableIds: new Set(this.#tasks.runnableNodes(task.id, node.id).map(item => item.id)),
            }),
            waitSignal, input.timeoutMs,
          )
          return {
            ok: !timedOut,
            timedOut,
            completedNodes: matched,
            nodes: handoffs(teamScopeNodes().filter(item => !scopedIds.length || scopedIds.includes(item.id))),
          }
        }))

        if (this.#capabilities.enabled('get_task_nodes')) tools.push(inspectNodesTool(async (_id, input) => {
          const allChildren = teamScopeNodes()
          const filtered = input.nodeIds?.length ? allChildren.filter(item => input.nodeIds!.includes(item.id)) : allChildren
          return { ok: true, nodes: handoffs(filtered) }
        }))
      }

      signal.throwIfAborted()
      const advice = await preflight(this.#judgment, event, node.goal, signal)
      signal.throwIfAborted()
      session = await this.#execution.open({
        cwd: workspace.root, role, correlationId: event.agentRunId,
        sessionDirectory: join(this.#sessions, teamIdentityKey ?? task.id),
        session: sessionToResume,
        route,
        tools: tools.map(tool => toolRun.guard(tool, () => event, signal, availableTools.find(item => item.name === tool.name))),
        systemPrompt: this.#extensions.workflow.systemPrompt(role, liveGrant.access, node.check),
        selectSkills: skillDisclosure(this.#judgment, event, node.goal, signal),
        ...(this.#mode === 'quality' && advice.reasoningEffort ? { reasoningEffort: advice.reasoningEffort } : {}),
        ...this.#runtimePolicy(workspace, liveGrant),
        reserveRequest: (request) => {
          signal.throwIfAborted()
          try { return lease!.request(request) } catch (error) {
            if (error instanceof ModelBudgetError) exhausted = true
            throw error
          }
        },
        onEvent: (runtime) => {
          const reservationId = runtime.type === 'model.usage' ? lease!.usage(runtime)
            : runtime.type === 'model.request_unaccounted' ? lease!.unknown() : undefined
          this.#emit(reservationId ? { ...event, correlationId: reservationId } : event, runtime, role)
        },
      })
      if (!sameRoute(session.route, route) ||
        (sessionToResume && (session.ref.id !== sessionToResume.id || session.ref.path !== sessionToResume.path))) {
        throw new Error('Child Session identity or route changed')
      }
      event = this.#register(task, session, event, teamIdentityKey ?? event.agentId!, role, timeMs, parent.agentId,
        teamIdentityKey && node.teamKey ? { key: teamIdentityKey, teamKey: node.teamKey, cwd: workspace.root } : undefined)
      registered = true
      unwatch = this.#watchStop(session, signal)

      if (role === 'team' && coordinator) {
        coordinator.activeScopes.set(node.id, { event, route: session.route, workspace })
        scopeRegistered = true
      }

      // If Team starts with pre-planned child nodes in the DAG, run them concurrently via the event-driven scheduler.
      if (role === 'team' && !signal.aborted) {
        if (coordinator) {
          coordinator.scheduleAll()
          const waitForInitialChildren = () => {
            const children = teamScopeNodes()
            return children.some(c => c.status === 'running') ||
              this.#tasks.runnableNodes(task.id, node.id).length > 0 ||
              children.some(c => coordinator.activeNodes.has(c.id))
          }
          await coordinator.mailbox.waitForActivity(node.id, waitForInitialChildren, signal)
          // Drain initial pre-turn child events since Turn 1 prompt directly includes all Child handoffs below.
          coordinator.mailbox.drainUnread(node.id)
        } else {
          // Fallback if Team started without coordinator
          while (!signal.aborted) {
            const runnable = this.#tasks.runnableNodes(task.id, node.id)
            if (!runnable.length) break
            const outcomes = await Promise.allSettled(runnable.map(child =>
              this.#worker(task, child, event, workspace, session!.route, currentGrant(), signal, true)))
            if (outcomes.every(item => item.status === 'fulfilled' && !item.value)) break
          }
        }
      }

      if (!signal.aborted) {
        const nodes = this.#tasks.get(task.id).nodes ?? []
        const childNodes = nodes.filter(child => child.parentNodeId === node.id)
        const dependencies = nodes.filter(item => node.dependencies.includes(item.id))
        const constraints = [
          liveGrant.access === 'read' ? 'Read-only workspace access.' : 'Workspace changes must remain inside the assigned scope.',
          liveGrant.path ? 'Use workspace-relative paths under ' + liveGrant.path + '.' : 'Use workspace-relative paths.',
          'Return a short summary of observed evidence and any remaining risks.',
          ...(childNodes.length ? ['Child handoffs: ' + JSON.stringify(handoffs(childNodes)).slice(0, 8000)] : []),
          ...(dependencies.length ? ['Completed prerequisites: ' + JSON.stringify(dependencies.map(item => ({
            id: item.id, status: item.status, evidenceRefs: item.result?.evidenceRefs, verification: item.verification,
          }))).slice(0, 4000)] : []),
        ]
        const target = workspaceTarget(node.check ?? (liveGrant.path ? undefined : task.check))
        const scopedFilter = liveGrant.path ? (entry: { kind: string; text: string }) => {
          const match = /^Confirmed workspace operation \S+ on (.+)$/u.exec(entry.text)
          if (match) {
            const filePath = match[1]!
            return filePath === liveGrant.path || filePath.startsWith(liveGrant.path + '/')
          }
          return node.teamKey !== undefined
        } : undefined
        const extraScopes = [
          legacyProviderMemoryScope(task, session.route.provider),
          ...(node.teamKey ? [teamMemoryScope(task, node.teamKey)] : []),
        ]
        const initialPrompt = await this.#context.build(event, {
          scope: memoryScope(task),
          extraScopes,
          filter: scopedFilter,
          goal: node.goal, constraints,
          artifactRefs: target ? [target] : [], availableTools: tools.map(tool => tool.name), signal,
        })
        signal.throwIfAborted()

        let currentPrompt = advice.hint ? initialPrompt + '\n\n' + advice.hint : initialPrompt
        let outcome = { status: 'runtime_error' } as Awaited<ReturnType<ExecutionSession['run']>>
        let reviewRounds = 0
        let completionAccepted = true
        let settledEvidence = false
        let hardEvidence = false

        const drainDeferred = async () => {
          for (let round = 0; round < 3 && outcome.status === 'completed' && !signal.aborted; round++) {
            const receipts = await toolRun.waitForDeferred(signal)
            if (!receipts.length || signal.aborted) break
            await session!.checkpoint()
            outcome = await session!.run(deferredResultPrompt(receipts))
          }
        }

        while (!signal.aborted) {
          if (coordinator && role === 'team') coordinator.scheduleAll()
          outcome = await session.run(currentPrompt)
          lastOutcomeStatus = outcome.status
          await drainDeferred()
          if (outcome.status === 'model_error') {
            modelFailed = true
            this.#scheduler.markRouteFailed(session.route)
          } else if (outcome.status === 'completed') {
            this.#scheduler.markRouteSucceeded(session.route)
          }

          if (signal.aborted || outcome.status !== 'completed') break

          if (role === 'team' && coordinator) {
            coordinator.scheduleAll()
            const waitChildrenActive = () => teamScopeNodes().some(c => c.status === 'running' || coordinator.activeNodes.has(c.id)) ||
              this.#tasks.runnableNodes(task.id, node.id).length > 0
            if (coordinator.mailbox.hasUnread(node.id) || waitChildrenActive()) {
              if (!coordinator.mailbox.hasUnread(node.id)) {
                await coordinator.mailbox.waitForActivity(node.id, waitChildrenActive, signal)
              }
              const unread = coordinator.mailbox.drainUnread(node.id)
              if (signal.aborted) break
              if (unread.length) {
                currentPrompt = formatMailboxPrompt(unread, teamScopeNodes())
                await session.checkpoint()
                continue
              }
            }
          }

          if (!outcome.text.trim() || blockingWrite()) break

          const scopeNow = currentGrant()
          if (node.check?.command && (!this.#capabilities.enabled('run_project_command') ||
            (scopeNow.tools && !scopeNow.tools.includes('run_project_command')) ||
            scopeNow.disallowedTools?.includes('run_project_command'))) {
            verification = { passed: false, evidence: 'project_command_disabled' }
          } else if (node.check) {
            verification = await verifyWorkspace(this.#tasks, this.#extensions.workflow,
              workspace, event, node.check, signal, scopeNow.access)
          }
          const completedChildren = this.#tasks.get(task.id).nodes?.filter(child =>
            child.parentNodeId === node.id && child.status === 'succeeded').length ?? 0
          const failedChildren = this.#tasks.get(task.id).nodes?.filter(child =>
            child.parentNodeId === node.id && child.status === 'failed').length ?? 0
          hardEvidence = node.check ? verification?.passed === true : evidence.size > 0 || completedChildren > 0
          const successfulTools = [...new Set(this.#tasks.operations(task.id)
            .filter(operation => evidence.has(operation.id)).map(operation => operation.tool))].slice(0, 24)
          settledEvidence = true
          const judgment = await reviewCompletion(this.#judgment, event, {
            goal: node.goal, parentGoal: task.goal, summary: outcome.text, role, access: scopeNow.access,
            checkConfigured: Boolean(node.check), checked: Boolean(node.check), checkPassed: verification?.passed === true,
            evidenceCount: evidence.size, artifactCount: artifacts.size, completedChildren, successfulTools,
            operations: this.#tasks.operations(task.id), completedReceipts: this.#completedReceipts(event),
            allowed: hardEvidence || reviewRounds === 0 ? [false, true] : [false],
            attemptCount: reviewRounds, maxFollowUps: 1, signal, evidenceRefs: [...evidence],
          })
          completionAccepted = !judgment.insufficient
          if (!judgment.followUp || signal.aborted) {
            if (failedChildren > 0 && !hardEvidence) completionAccepted = false
            break
          }
          reviewRounds++
          followUp = judgment.followUp
          settledEvidence = false
          await session.checkpoint()
          currentPrompt = followUp.nudge
        }
        followUp = undefined
        executionCompleted = outcome.status === 'completed'
        if (!signal.aborted && outcome.status === 'completed' && outcome.text.trim() && settledEvidence) {
          const review = await this.#reviewWorkerPatch(task, node, event, currentGrant(), signal)
          const remainingRisks = [
            ...(!hardEvidence ? ['verification_failed'] : !completionAccepted ? ['handoff_insufficient'] : []),
            ...(review ? ['patch_scope_review'] : []),
          ]
          result = {
            resultStatus: hardEvidence && completionAccepted ? 'succeeded' : 'failed',
            executionStatus: 'completed',
            summary: outcome.text.slice(0, 1600), artifactRefs: [...artifacts], evidenceRefs: [...evidence],
            remainingRisks,
          }
        }
      }
    } catch (error) {
      caughtReason = safeErrorReason(error)
      if (error instanceof ModelUnavailableError) modelFailed = true
    } finally {
      if (scopeRegistered && coordinator) coordinator.activeScopes.delete(node.id)
      try {
        if (session) {
          try {
            await unwatch?.()
            await session.checkpoint()
          } finally {
            await session.dispose()
          }
        }
      } catch (closeErr) {
        caughtReason ??= safeErrorReason(closeErr)
        result = undefined
      } finally {
        try { await toolRun.close() } catch { result = undefined }
        clearTimeout(timer)
        if (teamLease) this.#activeTeams.delete(teamLease)
        lease?.release()
      }
      if (!rootSignal.aborted && !result) {
        const risk = stalled.signal.aborted ? 'tool_retry_loop'
          : deadline.signal.aborted ? 'worker_deadline'
          : exhausted ? 'budget_exhausted'
          : modelFailed || lastOutcomeStatus === 'model_error' ? 'model_error'
          : lastOutcomeStatus === 'model_output_limit' ? 'model_output_limit'
          : 'worker_failed'
        result = {
          resultStatus: 'failed',
          summary: caughtReason
            ? `Child Agent failed (${risk}): ${caughtReason}`
            : `Child Agent did not produce verified evidence (${risk}).`,
          executionStatus: executionCompleted ? 'completed' : 'failed',
          artifactRefs: [...artifacts], evidenceRefs: [...evidence],
          remainingRisks: [risk],
        }
      }
      if (rootSignal.aborted) result = undefined
      if (started && !this.#db.isClosed) {
        const settled = this.#tasks.settleWorker(task.id, node.id, result, verification, event.taskAttemptId)
        if (settled?.result) {
          const failureReason = nodeFailureReason(settled)
          result = { ...settled.result, verification: settled.verification, ...(failureReason ? { failureReason } : {}) }
        } else {
          result = undefined
        }
      }
      if (registered) this.#finish(event, rootSignal.aborted ? 'interrupted'
        : result?.resultStatus === 'succeeded' ? 'completed' : result ? 'failed' : 'interrupted', result, role)
    }
    return result
  }

  async #reviewWorkerPatch(task: TaskSnapshot, node: WorkerNode, event: EventDraft, scope: CapabilityGrant, signal: AbortSignal) {
    if (this.#judgment.mode('swarm.patch', task.id) === 'off' || signal.aborted) return false
    const writes = this.#tasks.operations(task.id).filter(operation => operation.taskNodeId === node.id &&
      operation.attemptId === event.taskAttemptId && operation.effect === 'write' && operation.status === 'succeeded')
    if (!writes.length) return false
    const summary = writes.slice(0, 12).map(({ tool, target, changedPaths }) =>
      tool + ': ' + (changedPaths?.join(', ') || target || '(no individual path)')).join('\n')
    return this.#judgment.decide(event, 'swarm.patch', {
      goal: node.goal, parentGoal: task.goal, proposedGoal: scope.path, summary, writeCount: writes.length,
    }, false, [false, true], writes.map(operation => operation.id), { signal })
  }

  #completedReceipts(event: EventDraft): string[] {
    return this.#db.eventsOfTypes(event.taskId, ['tool.finished'])
      .filter(item => item.taskAttemptId === event.taskAttemptId && item.taskNodeId === event.taskNodeId && typeof item.payload.id === 'string')
      .map(item => item.payload.id as string)
  }

  #canArchiveToolEvidence(taskId: string): boolean {
    return this.#judgment.mode('tool.admission', taskId) === 'active' || this.#judgment.mode('tool.injection', taskId) === 'active'
  }

  async run(task: TaskSnapshot, workspace: CodingWorkspace, stopSignal: AbortSignal): Promise<Outcome> {
    const stalled = new AbortController()
    const toolRun = new ToolRun(this.#tasks, this.#approval, this.#judgment, this.#toolEvidence, () => stalled.abort(),
      () => this.#approvalMode(task), this.#approvalContext)
    const budget = new AbortController()
    const signal = AbortSignal.any([stopSignal, budget.signal, stalled.signal])
    const agentKey = task.conversationId ?? task.id
    const saved = this.#db.get<AgentRecord>('agents', agentKey)
    let event: EventDraft = {
      taskId: task.id, taskRunId: task.taskRunId, taskAttemptId: task.attemptId, taskNodeId: task.rootNodeId,
      agentId: saved?.id ?? randomUUID(), agentRunId: randomUUID(), type: '', payload: {},
    }
    let lease: ReturnType<LocalModelScheduler['reserve']> | undefined
    let deadline: NodeJS.Timeout | undefined
    let session: ExecutionSession | undefined
    let unwatch: (() => Promise<void>) | undefined
    let registered = false
    let syncWorkerActive = false
    let workspaceActive = false
    let checkpointFailed = false
    let outputFailed = false
    let textProduced = false
    let streamed = false
    let deferredResultRounds = 0
    let followUp: TurnFollowUp | undefined
    let advice: Awaited<ReturnType<typeof preflight>> = {}
    let completionAttempts = 0
    if (this.#judgment.mode('turn.completion', task.id) !== 'off') {
      for (const decision of this.#db.eventsOfTypes(task.id, ['judgment.evaluated'])) {
        const { id } = decision.payload
        if (decision.taskAttemptId === task.attemptId && (id === 'turn.completion' || id === 'turn.continue')) completionAttempts++
      }
    }
    const seenSteers = new Set<string>()
    const queuedSteers = new Set<string>()
    let prompted = new Set<string>()
    let promptAccepted = false
    let outcome: Outcome = { status: 'runtime_error' }
    const visual = new VisualTelemetry(this.#mode,
      this.#db.eventsOfTypes(task.id, ['visual.preview_started', 'visual.draft_ready']).filter(item => item.taskNodeId === task.rootNodeId),
      (type, payload) => this.#db.transaction(() => { this.#db.append({ ...event, type, payload }) }))
    const hasUnknownWrite = () => this.#tasks.blocksToolWork(task.id)

    const mailbox = new AgentMailbox()
    const activeNodes = new Map<string, Promise<WorkerHandoff | undefined>>()
    const activeScopes = new Map<string, ActiveScope>()

    let scheduling = false
    let reschedule = false

    const launchNode = (
      node: WorkerNode,
      parentEvent: EventDraft,
      nodeWorkspace: CodingWorkspace,
      parentRoute: ModelRoute,
      parentScope: CapabilityGrant,
      runSignal: AbortSignal,
      suspendParent = false,
    ): Promise<WorkerHandoff | undefined> => {
      const existing = activeNodes.get(node.id)
      if (existing) return existing
      const promise = (async (): Promise<WorkerHandoff | undefined> => {
        await Promise.resolve()
        try {
          return await this.#worker(task, node, parentEvent, nodeWorkspace, parentRoute, parentScope, runSignal, suspendParent, coordinator)
        } finally {
          activeNodes.delete(node.id)
          if (!this.#db.isClosed) {
            // Schedule unblocked successors BEFORE waking parents so waiters observe active successors cleanly.
            if (!runSignal.aborted) scheduleAll()
            try {
              const latest = this.#tasks.get(task.id)
              const latestNode = latest.worker?.id === node.id ? latest.worker
                : latest.nodes?.find(item => item.id === node.id)
              if (latestNode && (latestNode.status === 'succeeded' || latestNode.status === 'failed')) {
                mailbox.enqueue(node.parentNodeId, notificationFromNode(latestNode))
              } else {
                mailbox.wake(node.parentNodeId)
              }
            } catch {
              mailbox.wake(node.parentNodeId)
            }
          }
          mailbox.wake(task.rootNodeId)
        }
      })()
      void promise.catch(() => {})
      activeNodes.set(node.id, promise)
      return promise
    }

    const scheduleAll = () => {
      if (scheduling) {
        reschedule = true
        return
      }
      if (signal.aborted || hasUnknownWrite() || this.#db.isClosed) return
      scheduling = true
      try {
        do {
          reschedule = false
          const parentIds = [...activeScopes.keys()].sort((a, b) =>
            (a === task.rootNodeId ? 1 : 0) - (b === task.rootNodeId ? 1 : 0))
          for (const parentId of parentIds) {
            if (signal.aborted || hasUnknownWrite()) break
            const ctx = activeScopes.get(parentId)
            if (!ctx) continue
            const runnable = this.#tasks.runnableNodes(task.id, parentId === task.rootNodeId ? undefined : parentId)
            const parentGrant = parentId === task.rootNodeId
              ? this.#resolveRootGrant(task.id)
              : this.#resolveNodeGrant(task.id, parentId)
            if (!parentGrant) continue
            for (const node of runnable) {
              if (activeNodes.has(node.id) || signal.aborted) continue
              launchNode(node, ctx.event, ctx.workspace, ctx.route, parentGrant, signal, parentId !== task.rootNodeId)
            }
          }
        } while (reschedule && !signal.aborted && !hasUnknownWrite())
      } finally {
        scheduling = false
      }
    }

    const coordinator: TaskCoordinator = {
      mailbox,
      activeNodes,
      activeScopes,
      scheduleAll,
      launchNode,
      hasPendingWork: (ownerNodeId: string) => {
        if (this.#db.isClosed || signal.aborted) return false
        const snapshot = this.#tasks.get(task.id)
        const nodes = [...(snapshot.worker ? [snapshot.worker] : []), ...(snapshot.nodes ?? [])]
        if (ownerNodeId === task.rootNodeId) {
          return activeNodes.size > 0 ||
            nodes.some(node => node.status === 'running') ||
            this.#tasks.runnableNodes(task.id).length > 0
        }
        const subtree = descendantsOf(nodes, ownerNodeId)
        return subtree.some(node => node.status === 'running' || activeNodes.has(node.id)) ||
          this.#tasks.runnableNodes(task.id, ownerNodeId).length > 0
      },
      hasWorkspaceConflict: (ownerNodeId: string, worktreeId?: string) => {
        const snapshot = this.#tasks.get(task.id)
        const nodes = [...(snapshot.worker ? [snapshot.worker] : []), ...(snapshot.nodes ?? [])]
        return nodes.some(node =>
          node.id !== ownerNodeId &&
          (node.status === 'running' || activeNodes.has(node.id)) &&
          !(worktreeId && node.worktreeId && node.worktreeId !== worktreeId))
      },
    }

    const rootScopeInitial = this.#capabilities.root(task.workspaceAccess, Boolean(task.check))
    const dispatchAllowed = (toolSignal?: AbortSignal) =>
      this.#profile.delegation && !followUp && !signal.aborted && !toolSignal?.aborted && !workspaceActive && !syncWorkerActive && !hasUnknownWrite()

    /** Event-driven scheduler drain (used at pre-turn boundaries and resume without wave barriers). */
    const drainPendingNodes = async (): Promise<WorkerNode[]> => {
      if (!session || !coordinator.hasPendingWork(task.rootNodeId)) return []
      if (!dispatchAllowed()) return []
      const settledIds = new Set<string>()
      const before = this.#tasks.get(task.id)
      const beforePending = new Set([before.worker, ...(before.nodes ?? [])]
        .filter((node): node is WorkerNode => Boolean(node && (node.status === 'ready' || node.status === 'running')))
        .map(node => node.id))
      scheduleAll()
      await mailbox.waitForActivity(task.rootNodeId, () => coordinator.hasPendingWork(task.rootNodeId), signal, { wakeOnUnread: false })
      // Wait for all root/scheduled pending work to quiesce at this pre-turn boundary.
      while (!signal.aborted && coordinator.hasPendingWork(task.rootNodeId)) {
        scheduleAll()
        await mailbox.waitForActivity(task.rootNodeId, () => !activeNodes.size && !this.#tasks.runnableNodes(task.id).length ? false : true, signal, { wakeOnUnread: false })
        if (!activeNodes.size && !this.#tasks.runnableNodes(task.id).length) break
        if (mailbox.hasUnread(task.rootNodeId)) mailbox.drainUnread(task.rootNodeId)
      }
      const after = this.#tasks.get(task.id)
      const all = [after.worker, ...(after.nodes ?? [])].filter((node): node is WorkerNode => Boolean(node))
      for (const node of all) {
        if (beforePending.has(node.id) && node.status !== 'ready' && node.status !== 'running') {
          settledIds.add(node.id)
          mailbox.acknowledge(task.rootNodeId, [nodeEventKey(node)])
        }
      }
      return all.filter(node => settledIds.has(node.id))
    }

    const availableTools = this.#extensions.tools(workspace, 'root', rootScopeInitial.access)
      .filter(tool => this.#capabilities.describe(rootScopeInitial, tool))
    const tools: ExecutionTool[] = availableTools
      .map(tool => {
        const wrapped = toolRun.wrap(tool, workspace, () => event, signal, input => {
          const freshRoot = this.#resolveRootGrant(task.id)
          if (syncWorkerActive) return false
          if (!followUpAllows(followUp, tool.name)) return false
          const effect = tool.policy?.effectFor?.(input) ?? tool.effect
          if (activeNodes.size > 0 && (effect === 'write' || coordinator.hasWorkspaceConflict(task.rootNodeId))) {
            // Allow read-only root tools concurrently with read-only or worktree-isolated nodes; serialize on writes.
            const nodes = this.#tasks.get(task.id).nodes ?? []
            const activeWriteConflict = nodes.some(n =>
              (n.status === 'running' || activeNodes.has(n.id)) &&
              (n.access === 'write' || n.access === 'trusted' || effect === 'write'))
            if (activeWriteConflict) return false
          }
          return this.#capabilities.authorize(freshRoot, tool, input)
        }, undefined, undefined, task.goal)
        return {
          ...wrapped,
          execute: async (id, input, toolSignal) => {
            if (workspaceActive) return { ok: false, error: 'Another workspace tool is active' }
            workspaceActive = true
            try {
              const preview = tool.name === 'preview_page'
              if (preview) visual.beginPreview()
              const result = await wrapped.execute(id, input, toolSignal)
              if (preview) visual.previewResult(result)
              else visual.recordEdit(tool.name, input, result)
              return result
            } finally { workspaceActive = false }
          },
        }
      })

    const replay = this.#canArchiveToolEvidence(task.id) && toolRun.replayTool(() => event, signal, name => availableTools.some(tool => tool.name === name &&
      this.#capabilities.describe(this.#resolveRootGrant(task.id), tool) && followUpAllows(followUp, tool.name)))
    if (replay) tools.push(replay)

    if (this.#profile.delegation) {
      if (this.#capabilities.enabled('delegate_task')) tools.push(delegationTool('delegate_task', async (id, input, toolSignal) => {
          if (!this.#capabilities.enabled('delegate_task') || !dispatchAllowed(toolSignal)) return { ok: false, error: 'Delegation unavailable' }
          const freshRoot = this.#resolveRootGrant(task.id)
          const goal = input.goal
          const nonEmptyGoal = goal.trim().length > 0
          const operationId = event.agentRunId + ':' + id
          const shouldDelegate = await this.#judgment.decide(event, 'delegation.worth',
            { role: 'root', goalLength: goal.length, nonEmptyGoal, goal, parentGoal: task.goal },
            nonEmptyGoal, nonEmptyGoal ? [true, false] : [false], [task.rootNodeId], { delegationReceiptId: operationId, signal })
          if (!shouldDelegate || !this.#capabilities.enabled('delegate_task') || !dispatchAllowed(toolSignal)) {
            return { ok: false, error: 'Delegation unavailable' }
          }
          this.#tasks.beginTool(task.id, event, operationId, 'delegate_task', 'read')
          let result: WorkerHandoff | undefined
          let node: WorkerNode
          try {
            this.#childScope(workspace, freshRoot, input, 'worker')
            if (input.route) await this.#scheduler.validateRoute(input.route)
            const hasExtraFields = Object.keys(input).some(key => key !== 'goal' && key !== 'wait')
            node = !hasExtraFields ? this.#tasks.delegate(task.id, goal)
              : this.#tasks.delegateScoped(task.id, 'delegate:' + event.agentRunId + ':' + receiptId(id), task.rootNodeId, input)
            if (node.result) {
              result = { ...node.result, verification: node.verification }
            } else if (input.wait === false) {
              launchNode(node, event, workspace, session!.route, freshRoot, signal, false)
              this.#tasks.finishTool(event, operationId, 'succeeded')
              return { ok: true, scheduled: true, nodeId: node.id, status: 'running' }
            } else {
              syncWorkerActive = true
              try {
                result = await launchNode(node, event, workspace, session!.route, freshRoot, signal, false)
              } finally {
                syncWorkerActive = false
              }
              const latestSnapshot = this.#tasks.get(task.id)
              const settled = latestSnapshot.worker?.id === node.id ? latestSnapshot.worker
                : latestSnapshot.nodes?.find(item => item.id === node.id)
              if (settled) mailbox.acknowledge(task.rootNodeId, [nodeEventKey(settled)])
            }
          } catch {
            this.#tasks.finishTool(event, operationId, 'failed')
            return { ok: false, error: 'Delegation rejected by task scope or budget' }
          }
          this.#tasks.finishTool(event, operationId, result?.resultStatus === 'succeeded' ? 'succeeded' : 'failed')
          return result ? { ok: result.resultStatus === 'succeeded', nodeId: node.id, ...result } : { ok: false, nodeId: node.id, error: 'Worker interrupted' }
        }))

      if (this.#capabilities.enabled('propose_task_plan')) tools.push(planTool(async (id, proposals, waitMode, toolSignal) => {
        if (!this.#capabilities.enabled('propose_task_plan') || !dispatchAllowed(toolSignal) || !session || !proposals.length || proposals.length > 8) {
          return { ok: false, error: 'Planning unavailable' }
        }
        try {
          const freshRoot = this.#resolveRootGrant(task.id)
          const requestId = 'plan:' + event.agentRunId + ':' + receiptId(id)
          const planned: NodeProposal[] = []
          const teamScopes = new Map<string, CapabilityGrant>()
          for (const existing of this.#tasks.get(task.id).nodes ?? []) {
            if (existing.role === 'team' && existing.parentNodeId === task.rootNodeId) {
              teamScopes.set(existing.id, this.#childScope(workspace, freshRoot, existing, 'team'))
            }
          }
          for (const proposal of proposals) {
            if (!proposal || typeof proposal !== 'object') throw new Error('Invalid node proposal')
            if (proposal.route) await this.#scheduler.validateRoute(proposal.route)
            const teamCandidate = Boolean(proposal.teamKey)
            const baseline = proposal.role ?? (teamCandidate ? 'team' : 'worker')
            const role = await this.#judgment.decide(event, 'collaboration.mode',
              { goal: proposal.goal, parentGoal: task.goal, nodeCount: proposals.length, nodeOrdinal: planned.length,
                teamCandidate, hasDependencies: Boolean(proposal.dependencies?.length), dependencyCount: proposal.dependencies?.length },
              baseline, !proposal.role && teamCandidate ? ['worker', 'team'] : [baseline], [task.rootNodeId], { planRequestId: requestId, signal })
            const effectiveProposal: NodeProposal = { ...proposal, role, ...(role === 'worker' ? { teamKey: undefined } : {}) }
            if (!effectiveProposal.parentNodeId || effectiveProposal.parentNodeId === task.rootNodeId) {
              const scope = this.#childScope(workspace, freshRoot, effectiveProposal, role)
              if (role === 'team' && typeof effectiveProposal.ref === 'string') teamScopes.set(effectiveProposal.ref, scope)
            } else {
              const parentTeamScope = teamScopes.get(effectiveProposal.parentNodeId)
              if (!parentTeamScope || role !== 'worker') throw new Error('Invalid nested node scope')
              this.#childScope(workspace, parentTeamScope, effectiveProposal, 'worker')
            }
            planned.push(effectiveProposal)
          }
          if (!this.#capabilities.enabled('propose_task_plan') || !dispatchAllowed(toolSignal)) return { ok: false, error: 'Planning interrupted' }
          const current = this.#tasks.get(task.id)
          const nodes = this.#tasks.proposePlan(task.id, requestId, current.planVersion, planned)
          const submittedIds = nodes.map(node => node.id)
          const waitSignal = toolSignal ? AbortSignal.any([signal, toolSignal]) : signal

          // Event-driven dispatch starts immediately with zero wave barriers!
          scheduleAll()

          if (waitMode === 'none') {
            const latest = this.#tasks.get(task.id)
            const created = (latest.nodes ?? []).filter(node => submittedIds.includes(node.id))
            return { ok: true, scheduled: true, planVersion: latest.planVersion, nodes: handoffs(created) }
          }

          if (waitMode === 'any') {
            const { timedOut, matched } = await mailbox.waitForNodes(
              task.rootNodeId, submittedIds, 'any',
              () => ({
                nodes: (this.#tasks.get(task.id).nodes ?? []).filter(node => submittedIds.includes(node.id)),
                activeIds: new Set(activeNodes.keys()),
                runnableIds: new Set(this.#tasks.runnableNodes(task.id).map(item => item.id)),
              }),
              waitSignal,
            )
            const latest = this.#tasks.get(task.id)
            const currentSubmitted = (latest.nodes ?? []).filter(node => submittedIds.includes(node.id))
            return {
              ok: !timedOut && currentSubmitted.some(node => node.status === 'succeeded'),
              waited: 'any',
              completedNodes: matched,
              planVersion: latest.planVersion,
              nodes: handoffs(currentSubmitted),
            }
          }

          // waitMode === 'all': still runs pure event-driven successor scheduling with NO wave barriers!
          syncWorkerActive = true
          try {
            while (!waitSignal.aborted) {
              scheduleAll()
              const latestCheck = this.#tasks.get(task.id)
              const remainingSubmitted = (latestCheck.nodes ?? []).filter(node => submittedIds.includes(node.id))
              const anyRunning = remainingSubmitted.some(node => node.status === 'running' || activeNodes.has(node.id))
              const anyRunnable = this.#tasks.runnableNodes(task.id).some(node => submittedIds.includes(node.id))
              if (!anyRunning && !anyRunnable) break
              await mailbox.waitForActivity(task.rootNodeId, () => {
                const snap = this.#tasks.get(task.id)
                const sub = (snap.nodes ?? []).filter(n => submittedIds.includes(n.id))
                return sub.some(n => n.status === 'running' || activeNodes.has(n.id)) ||
                  this.#tasks.runnableNodes(task.id).some(n => submittedIds.includes(n.id))
              }, waitSignal, { wakeOnUnread: false })
            }
          } finally {
            syncWorkerActive = false
          }
          const latest = this.#tasks.get(task.id)
          const finished = (latest.nodes ?? []).filter(node => submittedIds.includes(node.id))
          for (const node of finished) {
            if (node.status === 'succeeded' || node.status === 'failed') {
              mailbox.acknowledge(task.rootNodeId, [nodeEventKey(node)])
            }
          }
          const handoff = handoffs(finished)
          return { ok: handoff.every(node => node.status === 'succeeded'), planVersion: latest.planVersion, nodes: handoff }
        } catch {
          return { ok: false, error: 'Plan rejected by task scope, dependency, or budget' }
        }
      }))

      if (this.#capabilities.enabled('wait_task_nodes')) tools.push(waitNodesTool(async (_id, input, toolSignal) => {
        scheduleAll()
        const waitSignal = toolSignal ? AbortSignal.any([signal, toolSignal]) : signal
        const allTaskNodes = () => this.#tasks.get(task.id).nodes ?? []
        const { timedOut, matched } = await mailbox.waitForNodes(
          task.rootNodeId,
          input.nodeIds,
          input.mode,
          () => ({
            nodes: allTaskNodes(),
            activeIds: new Set(activeNodes.keys()),
            runnableIds: new Set(this.#tasks.runnableNodes(task.id).map(item => item.id)),
          }),
          waitSignal,
          input.timeoutMs,
        )
        const latest = this.#tasks.get(task.id)
        const latestNodes = latest.nodes ?? []
        const scoped = input.nodeIds?.length ? latestNodes.filter(node => input.nodeIds!.includes(node.id)) : latestNodes
        return {
          ok: !timedOut,
          timedOut,
          planVersion: latest.planVersion,
          completedNodes: matched,
          nodes: handoffs(scoped),
        }
      }))

      if (this.#capabilities.enabled('get_task_nodes')) tools.push(inspectNodesTool(async (_id, input) => {
        const latest = this.#tasks.get(task.id)
        const latestNodes = latest.nodes ?? []
        const scoped = input.nodeIds?.length ? latestNodes.filter(node => input.nodeIds!.includes(node.id)) : latestNodes
        return { ok: true, planVersion: latest.planVersion, nodes: handoffs(scoped) }
      }))

      if (this.#capabilities.enabled('replan_task_node')) tools.push(replanTool(async (id, nodeId, update, toolSignal) => {
        if (!this.#capabilities.enabled('replan_task_node') || !dispatchAllowed(toolSignal)) return { ok: false, error: 'Replanning unavailable' }
        const current = this.#tasks.get(task.id)
        const node = current.nodes?.find(item => item.id === nodeId)
        const isRootChild = node?.parentNodeId === task.rootNodeId
        const hasWrite = Boolean(node && this.#tasks.operations(task.id)
          .some(operation => operation.taskNodeId === node.id && operation.effect === 'write'))
        const replanCount = node?.replans ?? 0
        const safe = isRootChild && !replanCount && (node?.status === 'ready' || node?.status === 'failed') && !hasWrite
        const requestId = 'replan:' + event.agentRunId + ':' + receiptId(id)
        const revise = await this.#judgment.decide(event, 'task.replan',
          { status: node?.status ?? 'missing', requested: true, isRootChild, hasWrite, replanCount,
            goal: node?.goal, proposedGoal: update.goal, parentGoal: task.goal, failure: node?.result?.remainingRisks[0] },
          safe, safe ? [true, false] : [false], node ? [node.id] : [], { planRequestId: requestId, signal })
        if (!revise || !this.#capabilities.enabled('replan_task_node') || !dispatchAllowed(toolSignal)) {
          return { ok: false, error: 'Replan declined or unsafe' }
        }
        try {
          this.#tasks.replanNode(task.id, requestId, current.planVersion, nodeId, update)
          scheduleAll()
          const targetPromise = activeNodes.get(nodeId)
          if (targetPromise) {
            syncWorkerActive = true
            try { await targetPromise } finally { syncWorkerActive = false }
          }
          const latest = this.#tasks.get(task.id)
          const updatedNode = latest.nodes?.find(item => item.id === nodeId)
          if (updatedNode && (updatedNode.status === 'succeeded' || updatedNode.status === 'failed')) {
            mailbox.acknowledge(task.rootNodeId, [nodeEventKey(updatedNode)])
          }
          return { ok: true, planVersion: latest.planVersion, nodes: handoffs(updatedNode ? [updatedNode] : []) }
        } catch {
          return { ok: false, error: 'Replan rejected by task scope, version, or budget' }
        }
      }))
    }

    const previousAttempt = task.attemptCount > 1 ? this.#tasks.attempts(task.id)
      .filter(attempt => attempt.nodeId === task.rootNodeId && attempt.finishedAt)
      .sort((left, right) => right.finishedAt!.localeCompare(left.finishedAt!))[0] : undefined
    const config = (route: ModelRoute | undefined, ref?: SessionRef): ExecutionConfig => {
      const rootGrant = this.#resolveRootGrant(task.id)
      return {
        cwd: workspace.root, role: 'root', correlationId: event.agentRunId,
        sessionDirectory: join(this.#sessions, agentKey), session: ref, route,
        tools: tools.map(tool => toolRun.guard(tool, () => event, signal, availableTools.find(item => item.name === tool.name))),
        systemPrompt: this.#extensions.workflow.systemPrompt('root', rootGrant.access, task.check),
        ...this.#runtimePolicy(workspace, rootGrant),
        ...(this.#mode === 'quality' && advice.reasoningEffort ? { reasoningEffort: advice.reasoningEffort } : {}),
        selectSkills: skillDisclosure(this.#judgment, event, task.goal, signal),
        resumeAfterOutputLimit: saved?.taskId === task.id && previousAttempt?.reason === 'model_output_limit' &&
          !this.#tasks.operations(task.id).some(operation => isUnresolvedEffect(operation)),
        canRecoverModelOutput: () => !signal.aborted && !hasUnknownWrite(),
        reserveRequest: (request) => {
          signal.throwIfAborted()
          try {
            const cap = lease!.request(request)
            visual.requestStarted()
            return cap
          } catch (error) {
            if (error instanceof ModelBudgetError) budget.abort()
            throw error
          }
        },
        onEvent: (runtime) => {
          if (runtime.type === 'prompt.accepted') promptAccepted = true
          if (runtime.type === 'instruction.applied') seenSteers.add(runtime.instructionId)
          if (runtime.type === 'message.delta' && runtime.delta) {
            streamed = true
            textProduced ||= Boolean(runtime.delta.trim())
          }
          try {
            visual.observe(runtime)
            const reservationId = runtime.type === 'model.usage' ? lease!.usage(runtime)
              : runtime.type === 'model.request_unaccounted' ? lease!.unknown() : undefined
            this.#emit(reservationId ? { ...event, correlationId: reservationId } : event, runtime, 'root')
          } catch {
            outputFailed = true
            budget.abort()
          }
        },
      }
    }

    const closeSession = async (saveCheckpoint = true) => {
      if (!session) return
      const current = session
      session = undefined
      try {
        await unwatch?.()
        if (saveCheckpoint && !this.#db.isClosed) {
          await current.checkpoint()
          this.#onCheckpoint?.(task.id)
          this.#tasks.markDelivered(task.id, [...(promptAccepted ? prompted : []), ...seenSteers])
          prompted.clear()
          promptAccepted = false
          seenSteers.clear()
        }
      } catch (error) {
        checkpointFailed = true
        throw error
      } finally {
        try {
          await current.dispose()
        } catch (error) {
          checkpointFailed = true
          throw error
        }
      }
    }

    const conversationId = task.conversationId
    const lockRoute = () => { if (conversationId) this.#openingConversations.add(conversationId) }
    const unlockRoute = () => { if (conversationId) this.#openingConversations.delete(conversationId) }
    const confirmOpenedRoute = async (candidate: ExecutionSession) => {
      try {
        await candidate.checkpoint()
      } catch (error) {
        checkpointFailed = true
        throw error
      }
    }

    let openingSavedSession = false
    try {
      lease = this.#scheduler.reserve(() => event, 'root')
      deadline = setTimeout(() => budget.abort(), deadlines[this.#mode].root)
      deadline.unref()
      lockRoute()
      const initialRoute = this.#tasks.get(task.id).route ?? saved?.route
      if (saved && initialRoute && !this.#scheduler.canSwitch(saved.route, initialRoute)) return { status: 'model_error' }
      if (initialRoute) {
        try {
          await this.#scheduler.allocate(event, initialRoute, initialRoute, false, task.goal, signal, { sessionMode: 'resume' })
        } catch {
          return { status: 'model_error' }
        }
      }
      if (signal.aborted) return { status: 'interrupted' }
      advice = await preflight(this.#judgment, event, task.goal, signal)
      signal.throwIfAborted()
      openingSavedSession = Boolean(saved)
      session = await this.#execution.open(config(initialRoute, saved?.session))
      if ((saved && (saved.session.id !== session.ref.id || saved.session.path !== session.ref.path)) ||
        (initialRoute && !sameRoute(initialRoute, session.route))) {
        outcome = { status: 'checkpoint_error' }
        await closeSession(false)
      } else {
        if (saved && !sameRoute(saved.route, session.route)) await confirmOpenedRoute(session)
        openingSavedSession = false
        signal.throwIfAborted()
        unwatch = this.#watchStop(session, signal)
        event = this.#register(task, session, event, agentKey, 'root', deadlines[this.#mode].root)
        registered = true
        activeScopes.set(task.rootNodeId, { event, route: session.route, workspace })
        this.#steering.set(task.id, async (id, text) => {
          if (!session || signal.aborted || prompted.has(id) || queuedSteers.has(id)) return false
          const item = this.#tasks.get(task.id).instructions.find((instruction) => instruction.id === id)
          if (!item || item.delivered) return false
          queuedSteers.add(id)
          try {
            const currentSession = session
            const framed = await frameInstruction(this.#judgment, event, task.goal, text, signal)
            if (session !== currentSession || signal.aborted || prompted.has(id)) {
              queuedSteers.delete(id)
              return false
            }
            await currentSession.steer(framed, id)
            return true
          } catch {
            queuedSteers.delete(id)
            return false
          }
        })
        if (saved && !sameRoute(saved.route, session.route)) {
          const route = session.route
          this.#db.transaction(() => { this.#db.append({ ...event, type: 'model.route_changed', payload: { route } }) })
        }
        unlockRoute()
        const priorTaskId = saved?.taskId
        const priorUnconfirmed = priorTaskId ? this.#tasks.operations(priorTaskId)
          .filter(operation => operation.effect === 'write' && operation.status === 'unknown_effect') : []
        const previousGoal = saved && saved.taskId !== task.id && this.#judgment.mode('task.frame', task.id) !== 'off'
          ? this.#tasks.get(saved.taskId).goal : ''
        let nextPrompt = saved?.taskId === task.id
          ? 'Resume the task using the saved conversation. Recheck current workspace state before new edits and avoid repeating confirmed changes.\n\nOriginal task goal: ' + task.goal
          : await frameInstruction(this.#judgment, event, previousGoal, task.goal, signal, true)
        if (priorUnconfirmed.length) {
          const items = priorUnconfirmed.slice(0, 8).map(item => item.target ? `${item.tool} (${item.target})` : item.tool).join(', ')
          nextPrompt += `\n\nReconciliation safety note: Previous write operation(s) [${items}] still have uncertain historical effects. Inspect current workspace state first and never automatically replay them.`
        }
        if (advice.hint) nextPrompt += '\n\n' + advice.hint

        while (!signal.aborted) {
          const current = this.#tasks.get(task.id)
          if (current.route && !sameRoute(current.route, session.route)) {
            if (!this.#scheduler.canSwitch(session.route, current.route)) throw new ModelUnavailableError('Route conflicts with current provider')
            lockRoute()
            const ref = session.ref
            await closeSession()
            if (signal.aborted) break
            openingSavedSession = true
            session = await this.#execution.open(config(current.route, ref))
            if (session.ref.id !== ref.id || session.ref.path !== ref.path || !sameRoute(current.route, session.route)) {
              outcome = { status: 'checkpoint_error' }
              await closeSession(false)
              break
            }
            await confirmOpenedRoute(session)
            openingSavedSession = false
            if (signal.aborted) break
            unwatch = this.#watchStop(session, signal)
            const applied = session.route
            activeScopes.set(task.rootNodeId, { event, route: applied, workspace })
            this.#db.transaction(() => {
              const agent = this.#db.get<AgentRecord>('agents', agentKey)!
              this.#db.put('agents', agentKey, { ...agent, route: applied })
              this.#db.append({ ...event, type: 'model.route_changed', payload: { route: applied } })
            })
            unlockRoute()
          }

          // Run any pre-existing ready/resumed nodes before entering turn prompt (preserving addTask/resume semantics).
          const completedNodes = followUp ? [] : await drainPendingNodes()
          if (signal.aborted) break
          if (completedNodes.length) nextPrompt += '\nAgent handoffs:\n' + JSON.stringify(handoffs(completedNodes)).slice(0, 8000)

          const unreadAtStart = mailbox.drainUnread(task.rootNodeId)
          if (unreadAtStart.length) {
            const latestForPrompt = this.#tasks.get(task.id).nodes ?? []
            nextPrompt += '\n' + formatMailboxPrompt(unreadAtStart, latestForPrompt)
          }

          const latest = this.#tasks.get(task.id)
          if (conversationId && latest.route && !sameRoute(latest.route, session.route)) continue
          const instructions = latest.instructions.filter((item) => !item.delivered)
          prompted = new Set(instructions.map(({ id }) => id))
          const constraints = await Promise.all(instructions.map(async ({ text }) =>
            'Additional user instruction: ' + await frameInstruction(this.#judgment, event, task.goal, text, signal)))
          const prompt = await this.#context.build(event, {
            scope: memoryScope(task),
            extraScopes: [legacyProviderMemoryScope(task, session.route.provider)],
            goal: nextPrompt, judgmentGoal: task.goal,
            constraints,
            signal,
          })
          if (signal.aborted) break
          streamed = false
          promptAccepted = !this.#execution.verifySession
          const result = await session.run(prompt)
          followUp = undefined
          if (result.status !== 'completed') {
            outcome = result
            break
          }
          textProduced ||= Boolean(result.text.trim())
          if (!streamed && result.text) {
            try {
              this.#emit(event, { type: 'message.delta', delta: result.text }, 'root')
            } catch {
              outputFailed = true
              break
            }
          }
          try {
            await session.checkpoint()
            this.#onCheckpoint?.(task.id)
          } catch (error) {
            checkpointFailed = true
            throw error
          }
          this.#tasks.markDelivered(task.id, [...prompted, ...seenSteers])
          prompted.clear()
          promptAccepted = false
          seenSteers.clear()
          queuedSteers.clear()

          const receipts = await toolRun.waitForDeferred(signal)
          if (signal.aborted) break
          if (receipts.length && deferredResultRounds < 4) {
            deferredResultRounds++
            nextPrompt = deferredResultPrompt(receipts)
            continue
          }

          // Event-driven Mailbox wakeup: deliver completed/failed child events immediately at this safe turn boundary.
          scheduleAll()
          if (mailbox.hasUnread(task.rootNodeId)) {
            const arrived = mailbox.drainUnread(task.rootNodeId)
            const scopeNodes = this.#tasks.get(task.id).nodes ?? []
            nextPrompt = formatMailboxPrompt(arrived, scopeNodes)
            continue
          }
          if (coordinator.hasPendingWork(task.rootNodeId) && !hasUnknownWrite()) {
            await mailbox.waitForActivity(task.rootNodeId, () => coordinator.hasPendingWork(task.rootNodeId), signal)
            if (signal.aborted) break
            const arrived = mailbox.drainUnread(task.rootNodeId)
            const scopeNodes = this.#tasks.get(task.id).nodes ?? []
            if (arrived.length || coordinator.hasPendingWork(task.rootNodeId)) {
              nextPrompt = arrived.length
                ? formatMailboxPrompt(arrived, scopeNodes)
                : 'Child execution progressed. Inspect the latest DAG status and continue.'
              continue
            }
          }

          const after = this.#tasks.get(task.id)
          const more = after.instructions.some((item) => !item.delivered) ||
            this.#tasks.runnableNodes(task.id).length > 0 ||
            (!conversationId && after.route && !sameRoute(after.route, session.route))
          if (!more && !hasUnknownWrite() && completionAttempts < 1 && this.#judgment.mode('turn.completion', task.id) !== 'off') {
            const children = this.#tasks.get(task.id).nodes ?? []
            const completedChildren = children.filter(child => child.status === 'succeeded').length
            const review = await reviewCompletion(this.#judgment, event, {
              goal: task.goal, summary: result.text, role: 'root', access: this.#resolveRootGrant(task.id).access,
              checkConfigured: Boolean(task.check), completedChildren,
              operations: this.#tasks.operations(task.id), completedReceipts: this.#completedReceipts(event),
              attemptCount: completionAttempts, maxFollowUps: 1, signal,
            })
            completionAttempts++
            followUp = review.followUp
            if (signal.aborted) break
            const postReview = this.#tasks.get(task.id)
            const arrivedDuringReview = postReview.instructions.some((item) => !item.delivered) ||
              this.#tasks.runnableNodes(task.id).length > 0 ||
              mailbox.hasUnread(task.rootNodeId) ||
              coordinator.hasPendingWork(task.rootNodeId) ||
              (!conversationId && postReview.route && !sameRoute(postReview.route, session.route))
            if (arrivedDuringReview) {
              followUp = undefined
              if (hasUnknownWrite()) {
                outcome = { status: 'completed', route: session.route, textProduced, event }
                break
              }
              nextPrompt = 'Continue the current task using the updates in this turn.'
              continue
            }
            if (followUp && !hasUnknownWrite()) {
              nextPrompt = followUp.nudge
              continue
            }
          }
          if (!more || hasUnknownWrite()) {
            outcome = { status: 'completed', route: session.route, textProduced, event }
            break
          }
          nextPrompt = 'Continue the current task using the updates in this turn.'
        }
      }
    } catch (error) {
      outcome = { status: error instanceof ModelUnavailableError ? 'model_error'
        : openingSavedSession || checkpointFailed ? 'checkpoint_error' : 'runtime_error' }
    } finally {
      this.#steering.delete(task.id)
      // Ensure any active background child Workers settle cleanly before Root tears down.
      if (activeNodes.size > 0) {
        await Promise.allSettled([...activeNodes.values()])
      }
      activeScopes.clear()
      mailbox.wakeAll()
      try {
        await closeSession()
      } catch {
        checkpointFailed = true
      } finally {
        try { await toolRun.close() } catch { checkpointFailed = true }
        try { visual.finish() } catch { /* A telemetry write cannot change the execution result. */ }
        unlockRoute()
        clearTimeout(deadline)
        lease?.release()
      }
      if (checkpointFailed || outputFailed) outcome = { status: 'checkpoint_error' }
      else if (stopSignal.aborted) outcome = { status: 'interrupted' }
      else if (stalled.signal.aborted) outcome = { status: 'tool_retry_loop' }
      else if (budget.signal.aborted) outcome = { status: 'budget_exhausted' }
      if (registered) {
        const status = outcome.status === 'completed' ? 'completed' : outcome.status === 'interrupted' ? 'interrupted' : 'failed'
        this.#finish(event, status)
      }
    }
    return outcome
  }
}

export function sameRoute(left: ModelRoute, right: ModelRoute): boolean {
  return left.provider === right.provider && left.model === right.model
}

export function executionFailure(status: Exclude<Outcome['status'], 'completed'>): EndReason {
  return status === 'interrupted' ? 'model_interrupted' : status
}
