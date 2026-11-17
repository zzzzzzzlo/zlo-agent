import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { delegationTool, handoffs, inspectDagTool, planTool, replanTool } from './agent-plan.ts'
import type { DagInspectQuery } from './agent-plan.ts'
import { ModelUnavailableError } from './execution.ts'
import type { AgentExecution, ExecutionConfig, ExecutionSession, ExecutionTool, RuntimeEvent } from './execution.ts'
import type { EndReason, EventDraft, ModelRoute, SessionRef } from './contracts/domain.ts'
import type { LocalJudgment } from './judgment.ts'
import { frameInstruction, preflight, skillDisclosure } from './input-judgment.ts'
import { memoryEntryInScope, workspaceMemoryScope } from './memory.ts'
import type { ScopedContext } from './memory.ts'
import { ModelBudgetError } from './model-scheduler.ts'
import type { LocalModelScheduler } from './model-scheduler.ts'
import type { AgentRole, CapabilityScope, CodingCapabilities, CodingProfile, ExtensionRegistry } from './policies.ts'
import type { LocalStore } from './store.ts'
import { isUnresolvedEffect } from './task-engine.ts'
import type { NodeProposal, TaskEngine, TaskSnapshot, WorkerNode, WorkerResult } from './task-engine.ts'
import type { ToolApprovalBroker } from './tool-approval.ts'
import type { ToolApprovalMode } from '../../shared/contracts/tool-approval.ts'
import { ToolRun } from './tool-run.ts'
import { ToolEvidenceArchive } from './tool-judgment.ts'
import { followUpAllows, reviewCompletion } from './turn-judgment.ts'
import type { CompletionFollowUp } from './turn-judgment.ts'
import { verifyWorkspace } from './verification.ts'
import { VisualTelemetry } from './visual-workflow.ts'
import { workspaceTarget } from './workspace.ts'
import type { CodingWorkspace, WorkspaceLease } from './workspace.ts'

interface AgentRecord {
  schemaVersion: 1
  id: string
  taskId: string
  role: AgentRole
  parentAgentId?: string
  session: SessionRef
  route: ModelRoute
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
type WorkerHandoff = WorkerResult & { verification?: WorkerNode['verification'] }

export function memoryScope(task: TaskSnapshot, _route?: ModelRoute): string {
  return workspaceMemoryScope(task.cwd)
}

export function legacyMemoryScope(task: TaskSnapshot, route: ModelRoute): string {
  return JSON.stringify([task.conversationId ?? task.cwd, route.provider])
}

function receiptId(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 32)
}

function deferredResultPrompt(receipts: readonly string[]): string {
  return 'A shell command was still running when you responded. Its recorded result is now: ' + receipts.join(', ') +
    '. Check the process status and output before finalizing. If the result is uncertain, inspect using scoped read-only tools and explain what needs verification. Do not rerun a command with unknown effects.'
}

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

  #runtimePolicy(workspace: CodingWorkspace, scope: CapabilityScope) {
    return {
      instructionScopes: { user: join(dirname(this.#sessions), 'instructions'),
        ...(scope.access === 'trusted' && !scope.path ? { project: workspace.root } : {}) },
      skillReadsAllowed: () => this.#capabilities.enabled('read_skill') &&
        (scope.tools === undefined || scope.tools.includes('read_skill')),
      reasoningEffort: this.#mode === 'fast' ? 'low' as const : undefined,
    }
  }

  #childScope(workspace: CodingWorkspace, parent: CapabilityScope, proposal: Partial<NodeProposal>, role: 'team' | 'worker') {
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
    const task = this.#tasks.getMeta(taskId)
    const rootScope = this.#capabilities.root(task.workspaceAccess, Boolean(task.check))
    const currentRoute = this.rootRoute(taskId) ?? task.route
    const teamScopes = new Map<string, CapabilityScope>()
    for (const existing of this.#tasks.nodesByParent(taskId, task.rootNodeId)) {
      if (existing.role === 'team') {
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
      if (proposal.route) {
        if (currentRoute && !this.#scheduler.canSwitch(currentRoute, proposal.route)) {
          throw new Error('Cross-provider delegation is not authorized')
        }
        await this.#scheduler.validateRoute(proposal.route)
      }
    }
  }

  subscribeOutput(sink: (event: OutputEvent) => void | Promise<void>): () => void {
    this.#outputSinks.add(sink)
    return () => { this.#outputSinks.delete(sink) }
  }

  rootRoute(taskId: string): ModelRoute | undefined {
    const task = this.#tasks.getMeta(taskId)
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
    const task = this.#tasks.getMeta(taskId)
    return this.#db.get<SessionRef>('task-sessions', taskId)
      ?? this.#db.get<AgentRecord>('agents', task.conversationId ?? taskId)?.session
  }

  clearBrokenSession(taskId: string): void {
    this.#db.transaction(() => {
      const task = this.#tasks.getMeta(taskId)
      const agentKey = task.conversationId ?? taskId
      this.#db.delete('task-sessions', taskId)
      this.#db.delete('agents', agentKey)
    })
  }

  #inspectDag(taskId: string, query: DagInspectQuery, scopedTeamId?: string): Record<string, unknown> {
    try {
      const limit = query.limit ?? 50
      if (query.view === 'active') {
        const nodes = this.#tasks.activeNodes(taskId, scopedTeamId ?? query.parentNodeId).slice(0, limit)
        return {
          ok: true,
          count: nodes.length,
          nodes: nodes.map(node => ({
            id: node.id,
            parentNodeId: node.parentNodeId,
            role: node.role ?? 'worker',
            status: node.status,
            access: node.access ?? 'read',
            goal: node.goal.slice(0, 200),
            dependencies: node.dependencies,
            ...(node.verification ? { verification: node.verification } : {}),
            ...(node.result ? { resultSummary: node.result.summary.slice(0, 240) } : {}),
          })),
        }
      }
      if (query.view === 'team_summaries') {
        const summaries = this.#tasks.teamSummaries(taskId, scopedTeamId ?? query.teamNodeId).slice(0, limit)
        return { ok: true, count: summaries.length, summaries }
      }
      if (query.view === 'history_page') {
        const page = this.#tasks.listNodesPage(taskId, {
          limit,
          afterOrdinal: query.afterOrdinal,
          parentNodeId: scopedTeamId ?? query.parentNodeId,
        })
        return { ok: true, ...page }
      }
      if (query.view === 'node_detail') {
        if (!query.nodeId) return { ok: false, error: 'nodeId is required for node_detail view' }
        const detail = this.#tasks.getNodeDetail(taskId, query.nodeId)
        if (!detail) return { ok: false, error: 'DAG node not found' }
        if (scopedTeamId !== undefined && detail.node.id !== scopedTeamId && detail.node.parentNodeId !== scopedTeamId) {
          return { ok: false, error: 'Requested node is outside this Team scope' }
        }
        return { ok: true, ...detail }
      }
      if (query.view === 'evidence') {
        if (!query.evidenceRef) return { ok: false, error: 'evidenceRef is required for evidence view' }
        const resolved = this.#tasks.resolveEvidence(taskId, query.evidenceRef)
        if (!resolved) return { ok: false, error: 'Evidence reference not found' }
        if (scopedTeamId !== undefined) {
          const belongs = resolved.nodeId === scopedTeamId ||
            (resolved.nodeId !== undefined && this.#tasks.getNode(taskId, resolved.nodeId)?.parentNodeId === scopedTeamId)
          if (!belongs) return { ok: false, error: 'Evidence reference is outside this Team scope' }
        }
        return { ok: true, ...resolved }
      }
      return { ok: false, error: 'Unsupported DAG inspection view' }
    } catch {
      return { ok: false, error: 'Could not inspect task DAG' }
    }
  }

  recover(): void {
    this.#db.transaction(() => {
      for (const run of this.#db.list<AgentRun>('agent-runs')) {
        if (run.status !== 'active' || !run.event.agentRunId) continue
        this.#db.put('agent-runs', run.event.agentRunId, { ...run, status: 'interrupted' })
        const taskRunId = this.#tasks.getMeta(run.event.taskId).taskRunId
        this.#db.append({ ...run.event, taskRunId, type: 'agent.finished', payload: {
          role: run.role, status: 'interrupted', reason: 'process_interrupted',
          lifecycle: run.role === 'team' ? 'idle' : 'released',
        } })
      }
    })
  }

  #emit(event: EventDraft, runtime: RuntimeEvent, role: AgentRecord['role']): void {
    // Pi can emit the switch while opening the Session. Route changes are recorded after registration.
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

  #recordCompletionFollowUp(event: EventDraft, followUp: CompletionFollowUp): void {
    this.#db.transaction(() => {
      this.#db.append({ ...event, correlationId: followUp.correlationId, type: 'turn.followup_triggered',
        payload: { source: followUp.id } })
    })
  }

  #register(task: TaskSnapshot, session: ExecutionSession, event: EventDraft, agentKey: string, role: AgentRole,
    maxDurationMs: number, parentAgentId?: string): EventDraft {
    const recorded = { ...event, sessionId: session.ref.id }
    this.#db.transaction(() => {
      const agent: AgentRecord = { schemaVersion: 1, id: event.agentId!, taskId: task.id, role, session: session.ref, route: session.route, parentAgentId }
      const run: AgentRun = { schemaVersion: 1, event: recorded, role, status: 'active' }
      this.#db.put('agents', agentKey, agent)
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
      const taskStatus = this.#tasks.getMeta(event.taskId).status
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

  async #worker(task: TaskSnapshot, node: WorkerNode, parent: EventDraft, workspace: CodingWorkspace,
    parentRoute: ModelRoute, parentScope: CapabilityScope, rootSignal: AbortSignal, suspendParent = false): Promise<WorkerHandoff | undefined> {
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
    let followUp: CompletionFollowUp | undefined
    let session: ExecutionSession | undefined
    let unwatch: (() => Promise<void>) | undefined
    let lease: ReturnType<LocalModelScheduler['reserve']> | undefined
    let result: WorkerHandoff | undefined
    let executionCompleted = false
    let verification: Awaited<ReturnType<typeof verifyWorkspace>> | undefined
    let started = false
    let registered = false
    let teamLease: string | undefined
    let workspaceLease: WorkspaceLease | undefined
    let activeChildCount = 0
    let activeChildWrite = false
    let workspaceActive = false
    let exhausted = false
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
      const leaseMode = node.access === 'write' || node.access === 'trusted' ? 'write' : 'read'
      workspaceLease = await workspace.acquireLease(leaseMode, { ownerId: event.agentRunId, signal })
      const parentNode = node.parentNodeId !== task.rootNodeId ? this.#tasks.getNode(task.id, node.parentNodeId) : undefined
      const scopes = [node, ...(parentNode ? [parentNode] : [])].flatMap(({ id, budget }) =>
        budget?.requests === undefined ? [] : [{ nodeId: id, requests: budget.requests }])
      lease = this.#scheduler.reserve(() => event, role, scopes)
      const scope = this.#childScope(workspace, parentScope, node, role)
      const teamKey = role === 'team'
        ? 'team-' + createHash('sha256').update(JSON.stringify([task.conversationId ?? task.id, node.teamKey, parentRoute.provider,
          { access: scope.access, path: scope.path, tools: scope.tools, disallowedTools: scope.disallowedTools, worktreeId: node.worktreeId }])).digest('hex')
        : undefined
      const saved = teamKey ? this.#db.get<AgentRecord>('agents', teamKey) : undefined
      if (teamKey) {
        if (this.#activeTeams.has(teamKey)) throw new Error('Team Session is active')
        this.#activeTeams.add(teamKey)
        teamLease = teamKey
        if (saved) event = { ...event, agentId: saved.id }
      }
      const route = await this.#scheduler.allocate(event, parentRoute, node.route ?? saved?.route, Boolean(node.role), node.goal, signal)
      const availableTools = this.#extensions.tools(workspace, role, scope.access)
        .filter(tool => this.#capabilities.describe(scope, tool))
      const tools = availableTools
        .map(tool => {
          const wrapped = toolRun.wrap(tool, workspace, () => event, signal, input =>
            activeChildCount === 0 &&
            followUpAllows(followUp, tool.name) && this.#capabilities.authorize(scope, tool, input), evidence, artifacts, node.goal, scope.path)
          return {
            ...wrapped,
            execute: async (id: string, input: unknown, toolSignal?: AbortSignal) => {
              if (workspaceActive) return { ok: false, error: 'Another workspace tool is active' }
              workspaceActive = true
              try { return await wrapped.execute(id, input, toolSignal) } finally { workspaceActive = false }
            },
          } as ExecutionTool
        })
      const replay = !scope.disallowedTools?.includes('read_tool_evidence') &&
        (!scope.tools || scope.tools.includes('read_tool_evidence')) &&
        this.#canArchiveToolEvidence(task.id) &&
        toolRun.replayTool(() => event, signal, name => availableTools.some(tool => tool.name === name &&
          this.#capabilities.describe(scope, tool) && followUpAllows(followUp, tool.name)))
      if (replay) tools.push(replay)
      const runChild = async (child: WorkerNode) => {
        if (followUp || workspaceActive || signal.aborted || !session) return undefined
        const isWriteChild = child.access === 'write' || child.access === 'trusted'
        if (activeChildCount > 0 && (isWriteChild || activeChildWrite)) return undefined
        activeChildCount++
        if (isWriteChild) activeChildWrite = true
        try {
          return await this.#worker(task, child, event, workspace, session.route, scope, signal, true)
        } finally {
          activeChildCount--
          if (isWriteChild) activeChildWrite = false
        }
      }
      const drainTeamChildren = async () => {
        if (followUp || workspaceActive || signal.aborted || !session) return
        const inFlight = new Map<string, Promise<void>>()
        try {
          while (!signal.aborted && !blockingWrite()) {
            const runnable = this.#tasks.runnableNodes(task.id, node.id)
            for (const child of runnable) {
              if (inFlight.has(child.id)) continue
              const isWriteChild = child.access === 'write' || child.access === 'trusted'
              if (inFlight.size > 0 && (isWriteChild || activeChildWrite)) continue
              const promise = runChild(child).finally(() => { inFlight.delete(child.id) }).then(() => undefined)
              inFlight.set(child.id, promise)
            }
            if (inFlight.size === 0) break
            await Promise.race(inFlight.values())
          }
        } finally {
          if (inFlight.size > 0) await Promise.allSettled(inFlight.values())
        }
      }
      if (role === 'team' && this.#profile.delegation &&
        (scope.tools === undefined || scope.tools.includes('inspect_task_dag')) &&
        !scope.disallowedTools?.includes('inspect_task_dag') &&
        this.#capabilities.enabled('inspect_task_dag')) {
        tools.push(inspectDagTool(query => Promise.resolve(this.#inspectDag(task.id, query, node.id))))
      }
      if (role === 'team' && this.#profile.delegation && this.#capabilities.enabled('delegate_worker')) tools.push(delegationTool('delegate_worker',
        async (id, input, toolSignal) => {
          if (!this.#capabilities.enabled('delegate_worker') ||
            followUp || signal.aborted || toolSignal?.aborted || activeChildCount > 0 || workspaceActive || blockingWrite()) {
            return { ok: false, error: 'Delegation unavailable' }
          }
          const goal = input.goal
          const nonEmptyGoal = goal.trim().length > 0
          const requestId = 'team:' + event.agentRunId + ':' + receiptId(id)
          if (!await this.#judgment.decide(event, 'delegation.worth', {
            role, goalLength: goal.length, nonEmptyGoal, goal, parentGoal: node.goal,
          }, nonEmptyGoal,
            nonEmptyGoal ? [true, false] : [false], [node.id], { planRequestId: requestId, signal }) || !this.#capabilities.enabled('delegate_worker') ||
            signal.aborted || toolSignal?.aborted || activeChildCount > 0 || workspaceActive || blockingWrite()) {
            return { ok: false, error: 'Delegation declined' }
          }
          try {
            this.#childScope(workspace, scope, input, 'worker')
            const child = this.#tasks.delegateScoped(task.id, requestId, node.id, input)
            const invokeChild = () => runChild(child)
            const result = child.result
              ? { ...child.result, verification: child.verification }
              : await (workspaceLease ? workspaceLease.suspendAndRun(invokeChild, signal) : invokeChild())
            return result ? { ok: result.resultStatus === 'succeeded', ...result } : { ok: false, error: 'Worker interrupted' }
          } catch {
            return { ok: false, error: 'Delegation rejected by task scope or budget' }
          }
        }))
      signal.throwIfAborted()
      const advice = await preflight(this.#judgment, event, node.goal, signal)
      signal.throwIfAborted()
      session = await this.#execution.open({
        cwd: workspace.root, role, correlationId: event.agentRunId,
        sessionDirectory: join(this.#sessions, teamKey ?? task.id), session: saved?.session, route,
        tools: tools.map(tool => toolRun.guard(tool, () => event, signal, availableTools.find(item => item.name === tool.name))),
        systemPrompt: this.#extensions.workflow.systemPrompt(role, scope.access, node.check),
        selectSkills: skillDisclosure(this.#judgment, event, node.goal, signal),
        ...(this.#mode === 'quality' && advice.reasoningEffort ? { reasoningEffort: advice.reasoningEffort } : {}),
        ...this.#runtimePolicy(workspace, scope),
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
      if (!sameRoute(session.route, route) || (saved && (session.ref.id !== saved.session.id || session.ref.path !== saved.session.path))) {
        throw new Error('Child Session identity or route changed')
      }
      event = this.#register(task, session, event, teamKey ?? event.agentId!, role, timeMs, parent.agentId)
      registered = true
      unwatch = this.#watchStop(session, signal)
      if (role === 'team' && !signal.aborted && this.#tasks.runnableNodes(task.id, node.id).length > 0) {
        if (workspaceLease) await workspaceLease.suspendAndRun(drainTeamChildren, signal)
        else await drainTeamChildren()
      }
      if (!signal.aborted) {
        const childNodes = role === 'team' ? this.#tasks.nodesByParent(task.id, node.id) : []
        const activeChildHandoffs = childNodes.filter(child => !child.archivedAt).slice(-24)
        const teamStage = role === 'team' ? this.#tasks.teamSummaries(task.id, node.id)[0] : undefined
        const dependencies = node.dependencies
          .map(depId => this.#tasks.getNode(task.id, depId))
          .filter((item): item is WorkerNode => Boolean(item))
        const constraints = [
          scope.access === 'read' ? 'Read-only workspace access.' : 'Workspace changes must remain inside the assigned scope.',
          scope.path ? 'Use workspace-relative paths under ' + scope.path + '.' : 'Use workspace-relative paths.',
          'Return a short summary of observed evidence and any remaining risks.',
          ...(teamStage ? ['Team stage summary: ' + JSON.stringify(teamStage).slice(0, 4000)] : []),
          ...(activeChildHandoffs.length ? ['Child handoffs: ' + JSON.stringify(handoffs(activeChildHandoffs)).slice(0, 8000)] : []),
          ...(dependencies.length ? ['Completed prerequisites: ' + JSON.stringify(dependencies.map(item => ({
            id: item.id, status: item.status, evidenceRefs: item.result?.evidenceRefs, verification: item.verification,
          }))).slice(0, 4000)] : []),
        ]
        const target = workspaceTarget(node.check ?? (scope.path ? undefined : task.check))
        const prompt = await this.#context.build(event, {
          scope: memoryScope(task, session.route),
          fallbackScopes: [legacyMemoryScope(task, session.route)],
          filter: scope.path ? entry => memoryEntryInScope(entry, scope.path) : undefined,
          goal: node.goal, constraints,
          artifactRefs: target ? [target] : [], availableTools: tools.map(tool => tool.name), signal,
        })
        signal.throwIfAborted()
        let outcome = await session.run(advice.hint ? prompt + '\n\n' + advice.hint : prompt)
        const drainDeferred = async () => {
          for (let round = 0; round < 3 && outcome.status === 'completed' && !signal.aborted; round++) {
            const receipts = await toolRun.waitForDeferred(signal)
            if (!receipts.length || signal.aborted) break
            await session!.checkpoint()
            outcome = await session!.run(deferredResultPrompt(receipts))
          }
        }
        await drainDeferred()
        let reviewRounds = 0
        let completionAccepted = true
        let settledEvidence = false
        let hardEvidence = false
        while (!signal.aborted && outcome.status === 'completed' && outcome.text.trim() && !blockingWrite()) {
          if (node.check?.command && (!this.#capabilities.enabled('run_project_command') ||
            (scope.tools && !scope.tools.includes('run_project_command')) ||
            scope.disallowedTools?.includes('run_project_command'))) {
            verification = { passed: false, evidence: 'project_command_disabled' }
          } else if (node.check) {
            verification = await verifyWorkspace(this.#tasks, this.#extensions.workflow,
              workspace, event, node.check, signal, scope.access)
          }
          const completedChildren = this.#tasks.completedChildCount(task.id, node.id)
          hardEvidence = node.check ? verification?.passed === true : evidence.size > 0 || completedChildren > 0
          const successfulTools = [...new Set(this.#tasks.operations(task.id)
            .filter(operation => evidence.has(operation.id)).map(operation => operation.tool))].slice(0, 24)
          settledEvidence = true
          const judgment = await reviewCompletion(this.#judgment, event, {
            goal: node.goal, parentGoal: task.goal, summary: outcome.text, role, access: scope.access,
            checkConfigured: Boolean(node.check), checked: Boolean(node.check), checkPassed: verification?.passed === true,
            evidenceCount: evidence.size, artifactCount: artifacts.size, completedChildren, successfulTools,
            operations: this.#tasks.operations(task.id), completedReceipts: this.#completedReceipts(event),
            allowed: hardEvidence || reviewRounds === 0 ? [false, true] : [false],
            attemptCount: reviewRounds, maxFollowUps: 1, signal, evidenceRefs: [...evidence],
          })
          completionAccepted = !judgment.insufficient
          if (!judgment.followUp || signal.aborted) break
          reviewRounds++
          followUp = judgment.followUp
          settledEvidence = false
          await session.checkpoint()
          if (signal.aborted) break
          this.#recordCompletionFollowUp(event, followUp)
          outcome = await session.run(followUp.nudge)
          followUp = undefined
          await drainDeferred()
        }
        followUp = undefined
        executionCompleted = outcome.status === 'completed'
        if (!signal.aborted && outcome.status === 'completed' && outcome.text.trim() && settledEvidence) {
          const review = await this.#reviewWorkerPatch(task, node, event, scope, signal)
          const patchNotice = review.flagged && review.paths.length
            ? `\n[Patch scope review: verify changes in ${review.paths.slice(0, 6).join(', ')} against assigned sub-goal.]`
            : ''
          result = {
            resultStatus: hardEvidence && completionAccepted ? 'succeeded' : 'failed',
            executionStatus: 'completed',
            summary: (outcome.text.trim() + patchNotice).slice(0, 1600), artifactRefs: [...artifacts], evidenceRefs: [...evidence],
            remainingRisks: [
              ...(!hardEvidence ? ['verification_failed'] : !completionAccepted ? ['handoff_insufficient'] : []),
              ...(review.flagged ? ['patch_scope_review'] : []),
            ],
          }
        }
      }
    } catch {
      // The Task Engine settles the attempt after resources are released.
    } finally {
      try {
        if (session) {
          try {
            await unwatch?.()
            await session.checkpoint()
          } finally {
            await session.dispose()
          }
        }
      } catch {
        result = undefined
      } finally {
        try { await toolRun.close() } catch { result = undefined }
        clearTimeout(timer)
        if (teamLease) this.#activeTeams.delete(teamLease)
        lease?.release()
      }
      if (!rootSignal.aborted && !result) result = {
        resultStatus: 'failed', summary: 'Child Agent did not produce verified evidence.',
        executionStatus: executionCompleted ? 'completed' : 'failed',
        artifactRefs: [...artifacts], evidenceRefs: [...evidence],
        remainingRisks: [stalled.signal.aborted ? 'tool_retry_loop'
          : deadline.signal.aborted ? 'worker_deadline' : exhausted ? 'budget_exhausted' : 'worker_failed'],
      }
      if (rootSignal.aborted) result = undefined
      try {
        if (started && !this.#db.isClosed) {
          const settled = this.#tasks.settleWorker(task.id, node.id, result, verification, event.taskAttemptId)
          result = settled?.result ? { ...settled.result, verification: settled.verification } : undefined
        }
      } finally {
        workspaceLease?.release()
      }
      if (registered) this.#finish(event, rootSignal.aborted ? 'interrupted'
        : result?.resultStatus === 'succeeded' ? 'completed' : result ? 'failed' : 'interrupted', result, role)
    }
    return result
  }


  async #reviewWorkerPatch(task: TaskSnapshot, node: WorkerNode, event: EventDraft, scope: CapabilityScope, signal: AbortSignal):
  Promise<{ flagged: boolean; paths: string[]; writeCount: number; targetCount: number }> {
    if (this.#judgment.mode('swarm.patch', task.id) === 'off' || signal.aborted) {
      return { flagged: false, paths: [], writeCount: 0, targetCount: 0 }
    }
    const writes = this.#tasks.operations(task.id).filter(operation => operation.taskNodeId === node.id &&
      operation.attemptId === event.taskAttemptId && operation.effect === 'write' && operation.status === 'succeeded')
    if (!writes.length) return { flagged: false, paths: [], writeCount: 0, targetCount: 0 }
    const touched = [...new Set(writes.flatMap(({ target, changedPaths }) =>
      changedPaths?.length ? changedPaths : target ? [target] : []))]
    const summary = writes.slice(0, 12).map(({ tool, target, changedPaths }) =>
      tool + ': ' + (changedPaths?.join(', ') || target || '(no individual path)')).join('\n')
    const flagged = await this.#judgment.decide(event, 'swarm.patch', {
      goal: node.goal, parentGoal: task.goal, proposedGoal: scope.path, summary, writeCount: writes.length, targetCount: touched.length,
    }, false, [false, true], writes.map(operation => operation.id), { signal })
    return { flagged, paths: touched, writeCount: writes.length, targetCount: touched.length }
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
    let workerActive = false
    let workspaceActive = false
    let checkpointFailed = false
    let outputFailed = false
    let textProduced = false
    let streamed = false
    let deferredResultRounds = 0
    let followUp: CompletionFollowUp | undefined
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
    const rootScope = this.#capabilities.root(task.workspaceAccess, Boolean(task.check))
    const visual = new VisualTelemetry(this.#mode,
      this.#db.eventsOfTypes(task.id, ['visual.preview_started', 'visual.draft_ready']).filter(item => item.taskNodeId === task.rootNodeId),
      (type, payload) => this.#db.transaction(() => { this.#db.append({ ...event, type, payload }) }))
    const hasUnknownWrite = () => this.#tasks.blocksToolWork(task.id)
    const dispatchAllowed = (toolSignal?: AbortSignal) =>
      this.#profile.delegation && !followUp && !signal.aborted && !toolSignal?.aborted && !workspaceActive && !workerActive && !hasUnknownWrite()
    const runWorker = async (node: WorkerNode): Promise<WorkerResult | undefined> => {
      if (!session || !dispatchAllowed()) throw new Error('Worker cannot start at this boundary')
      if (node.result) return node.result
      workerActive = true
      try {
        return await this.#worker(task, node, event, workspace, session.route, rootScope, signal)
      } finally {
        workerActive = false
      }
    }
    const drain = async () => {
      const completed = new Set<string>()
      if (!session || !dispatchAllowed()) return []
      const route = session.route
      workerActive = true
      const inFlight = new Map<string, Promise<void>>()
      let firstRejection: unknown
      let hasRejection = false
      try {
        while ((!signal.aborted && !hasUnknownWrite()) || inFlight.size > 0) {
          if (!signal.aborted && !hasUnknownWrite() && !hasRejection) {
            const batch = this.#tasks.runnableNodes(task.id)
            for (const node of batch) {
              if (inFlight.has(node.id)) continue
              const runNode = this.#worker(task, node, event, workspace, route, rootScope, signal)
                .then(() => {
                  const latestNode = this.#tasks.getNode(task.id, node.id)
                  if (latestNode && latestNode.status !== 'ready') completed.add(node.id)
                }, (error) => {
                  if (!hasRejection) {
                    hasRejection = true
                    firstRejection = error
                  }
                })
                .finally(() => { inFlight.delete(node.id) })
              inFlight.set(node.id, runNode)
            }
          }
          if (inFlight.size === 0) break
          await Promise.race(inFlight.values())
          if (hasRejection) {
            await Promise.allSettled(inFlight.values())
            throw firstRejection
          }
          if (this.#tasks.needsArchive(task.id)) {
            try { this.#tasks.archiveCompletedNodes(task.id) } catch { /* Stage archiving must never break running tasks. */ }
          }
        }
      } finally {
        if (inFlight.size > 0) await Promise.allSettled(inFlight.values())
        workerActive = false
      }
      const finished: WorkerNode[] = []
      for (const id of completed) {
        const node = this.#tasks.getNode(task.id, id)
        if (node) finished.push(node)
      }
      return finished
    }
    const availableTools = this.#extensions.tools(workspace, 'root', rootScope.access)
      .filter(tool => this.#capabilities.describe(rootScope, tool))
    const tools: ExecutionTool[] = availableTools
      .map(tool => {
        const wrapped = toolRun.wrap(tool, workspace, () => event, signal, input =>
          !workerActive &&
          followUpAllows(followUp, tool.name) && this.#capabilities.authorize(rootScope, tool, input), undefined, undefined, task.goal)
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
      this.#capabilities.describe(rootScope, tool) && followUpAllows(followUp, tool.name)))
    if (replay) tools.push(replay)
    if (this.#profile.delegation) {
      if (this.#capabilities.enabled('delegate_task')) tools.push(delegationTool('delegate_task', async (id, input, toolSignal) => {
          if (!this.#capabilities.enabled('delegate_task') || !dispatchAllowed(toolSignal)) return { ok: false, error: 'Delegation unavailable' }
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
          try {
            this.#childScope(workspace, rootScope, input, 'worker')
            const node = Object.keys(input).length === 1 ? this.#tasks.delegate(task.id, goal)
              : this.#tasks.delegateScoped(task.id, 'delegate:' + event.agentRunId + ':' + receiptId(id), task.rootNodeId, input)
            result = node.result ? { ...node.result, verification: node.verification } : await runWorker(node)
          } catch {
            this.#tasks.finishTool(event, operationId, 'failed')
            return { ok: false, error: 'Delegation rejected by task scope or budget' }
          }
          this.#tasks.finishTool(event, operationId, result?.resultStatus === 'succeeded' ? 'succeeded' : 'failed')
          return result ? { ok: result.resultStatus === 'succeeded', ...result } : { ok: false, error: 'Worker interrupted' }
        }))
      if (this.#capabilities.enabled('propose_task_plan')) tools.push(planTool(async (id, proposals, toolSignal) => {
        if (!this.#capabilities.enabled('propose_task_plan') || !dispatchAllowed(toolSignal) || !session || !proposals.length || proposals.length > 64) {
          return { ok: false, error: 'Planning unavailable' }
        }
        try {
          const requestId = 'plan:' + event.agentRunId + ':' + receiptId(id)
          const planned: NodeProposal[] = []
          const teamScopes = new Map<string, CapabilityScope>()
          for (const existing of this.#tasks.nodesByParent(task.id, task.rootNodeId)) {
            if (existing.role === 'team') {
              teamScopes.set(existing.id, this.#childScope(workspace, rootScope, existing, 'team'))
            }
          }
          for (const proposal of proposals) {
            if (!proposal || typeof proposal !== 'object') throw new Error('Invalid node proposal')
            if (proposal.route && !this.#scheduler.canSwitch(session.route, proposal.route)) {
              throw new Error('Cross-provider delegation is not authorized')
            }
            const teamCandidate = Boolean(proposal.teamKey)
            const baseline = proposal.role ?? (teamCandidate ? 'team' : 'worker')
            const role = await this.#judgment.decide(event, 'collaboration.mode',
              { goal: proposal.goal, parentGoal: task.goal, nodeCount: proposals.length, nodeOrdinal: planned.length,
                teamCandidate, hasDependencies: Boolean(proposal.dependencies?.length), dependencyCount: proposal.dependencies?.length },
              baseline, !proposal.role && teamCandidate ? ['worker', 'team'] : [baseline], [task.rootNodeId], { planRequestId: requestId, signal })
            const effectiveProposal: NodeProposal = { ...proposal, role, ...(role === 'worker' ? { teamKey: undefined } : {}) }
            if (!effectiveProposal.parentNodeId || effectiveProposal.parentNodeId === task.rootNodeId) {
              const scope = this.#childScope(workspace, rootScope, effectiveProposal, role)
              if (role === 'team' && typeof effectiveProposal.ref === 'string') teamScopes.set(effectiveProposal.ref, scope)
            } else {
              const parentTeamScope = teamScopes.get(effectiveProposal.parentNodeId)
              if (!parentTeamScope || role !== 'worker') throw new Error('Invalid nested node scope')
              this.#childScope(workspace, parentTeamScope, effectiveProposal, 'worker')
            }
            planned.push(effectiveProposal)
          }
          if (!this.#capabilities.enabled('propose_task_plan') || !dispatchAllowed(toolSignal)) return { ok: false, error: 'Planning interrupted' }
          const current = this.#tasks.getMeta(task.id)
          const nodes = this.#tasks.proposePlan(task.id, requestId, current.planVersion, planned)
          await drain()
          const latest = this.#tasks.getMeta(task.id)
          const settledNodes = nodes.map(({ id }) => this.#tasks.getNode(task.id, id)).filter((item): item is WorkerNode => Boolean(item))
          const handoff = handoffs(settledNodes)
          return { ok: handoff.every(node => node.status === 'succeeded'), planVersion: latest.planVersion, nodes: handoff }
        } catch {
          return { ok: false, error: 'Plan rejected by task scope, dependency, or budget' }
        }
      }))
      if (this.#capabilities.enabled('replan_task_node')) tools.push(replanTool(async (id, nodeId, update, toolSignal) => {
        if (!this.#capabilities.enabled('replan_task_node') || !dispatchAllowed(toolSignal)) return { ok: false, error: 'Replanning unavailable' }
        const current = this.#tasks.getMeta(task.id)
        const node = this.#tasks.getNode(task.id, nodeId)
        const isRootChild = node?.parentNodeId === task.rootNodeId
        const hasWrite = Boolean(node && this.#db.operationsForNode<{ effect: string }>(task.id, node.id)
          .some(operation => operation.effect === 'write'))
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
          await drain()
          const latest = this.#tasks.getMeta(task.id)
          const updatedNode = this.#tasks.getNode(task.id, nodeId)
          return { ok: true, planVersion: latest.planVersion, nodes: handoffs(updatedNode ? [updatedNode] : []) }
        } catch {
          return { ok: false, error: 'Replan rejected by task scope, version, or budget' }
        }
      }))
      if (this.#capabilities.enabled('inspect_task_dag')) tools.push(inspectDagTool(query => Promise.resolve(this.#inspectDag(task.id, query))))
    }
    const previousAttempt = task.attemptCount > 1 ? this.#tasks.attempts(task.id)
      .filter(attempt => attempt.nodeId === task.rootNodeId && attempt.finishedAt)
      .sort((left, right) => right.finishedAt!.localeCompare(left.finishedAt!))[0] : undefined
    const config = (route: ModelRoute | undefined, ref?: SessionRef): ExecutionConfig => ({
      cwd: workspace.root, role: 'root', correlationId: event.agentRunId,
      sessionDirectory: join(this.#sessions, agentKey), session: ref, route,
      tools: tools.map(tool => toolRun.guard(tool, () => event, signal, availableTools.find(item => item.name === tool.name))),
      systemPrompt: this.#extensions.workflow.systemPrompt('root', rootScope.access, task.check),
      ...this.#runtimePolicy(workspace, rootScope),
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
    })
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
      const initialRoute = this.#tasks.getMeta(task.id).route ?? saved?.route
      if (saved && initialRoute && !this.#scheduler.canSwitch(saved.route, initialRoute)) return { status: 'model_error' }
      if (initialRoute) {
        try {
          await this.#scheduler.allocate(event, initialRoute, initialRoute, false, task.goal, signal)
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
        this.#steering.set(task.id, async (id, text) => {
          if (!session || signal.aborted || prompted.has(id) || queuedSteers.has(id)) return false
          const item = this.#tasks.getMeta(task.id).instructions.find((instruction) => instruction.id === id)
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
          ? this.#tasks.getMeta(saved.taskId).goal : ''
        let nextPrompt = saved?.taskId === task.id
          ? 'Resume the task using the saved conversation. Recheck current workspace state before new edits and avoid repeating confirmed changes.\n\nOriginal task goal: ' + task.goal
          : await frameInstruction(this.#judgment, event, previousGoal, task.goal, signal, true)
        if (priorUnconfirmed.length) {
          const items = priorUnconfirmed.slice(0, 8).map(item => item.target ? `${item.tool} (${item.target})` : item.tool).join(', ')
          nextPrompt += `\n\nReconciliation safety note: Previous write operation(s) [${items}] still have uncertain historical effects. Inspect current workspace state first and never automatically replay them.`
        }
        if (advice.hint) nextPrompt += '\n\n' + advice.hint
        while (!signal.aborted) {
          const current = this.#tasks.getMeta(task.id)
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
            this.#db.transaction(() => {
              const agent = this.#db.get<AgentRecord>('agents', agentKey)!
              this.#db.put('agents', agentKey, { ...agent, route: applied })
              this.#db.append({ ...event, type: 'model.route_changed', payload: { route: applied } })
            })
            unlockRoute()
          }
          const completedNodes = followUp ? [] : await drain()
          if (signal.aborted) break
          if (completedNodes.length) {
            const rootDirect = completedNodes.filter(item => item.parentNodeId === task.rootNodeId)
            const selected = (rootDirect.length ? rootDirect : completedNodes).slice(-24)
            const summaries = this.#tasks.teamSummaries(task.id).slice(-8)
            nextPrompt += '\nAgent handoffs:\n' + JSON.stringify(handoffs(selected)).slice(0, 6000)
            if (summaries.length) {
              nextPrompt += '\nTeam stage summaries (use inspect_task_dag for node/evidence details):\n' +
                JSON.stringify(summaries).slice(0, 4000)
            }
          }
          const latest = this.#tasks.getMeta(task.id)
          if (conversationId && latest.route && !sameRoute(latest.route, session.route)) continue
          const instructions = latest.instructions.filter((item) => !item.delivered)
          if (followUp && instructions.length) {
            followUp = undefined
            nextPrompt = 'Continue the current task using the updates in this turn.'
          }
          prompted = new Set(instructions.map(({ id }) => id))
          const constraints = await Promise.all(instructions.map(async ({ text }) =>
            'Additional user instruction: ' + await frameInstruction(this.#judgment, event, task.goal, text, signal)))
          const prompt = await this.#context.build(event, {
            scope: memoryScope(task, session.route),
            fallbackScopes: [legacyMemoryScope(task, session.route)],
            includePlaybook: true,
            goal: nextPrompt, judgmentGoal: task.goal,
            constraints,
            signal,
          })
          if (signal.aborted) break
          streamed = false
          promptAccepted = !this.#execution.verifySession
          if (followUp) this.#recordCompletionFollowUp(event, followUp)
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
          const after = this.#tasks.getMeta(task.id)
          const more = after.instructions.some((item) => !item.delivered) || this.#tasks.runnableNodes(task.id).length > 0 ||
            (!conversationId && after.route && !sameRoute(after.route, session.route))
          if (!more && !hasUnknownWrite() && completionAttempts < 1 && this.#judgment.mode('turn.completion', task.id) !== 'off') {
            const completedChildren = this.#tasks.completedChildCount(task.id, task.rootNodeId)
            const review = await reviewCompletion(this.#judgment, event, {
              goal: task.goal, summary: result.text, role: 'root', access: rootScope.access,
              checkConfigured: Boolean(task.check), completedChildren,
              operations: this.#tasks.operations(task.id), completedReceipts: this.#completedReceipts(event),
              attemptCount: completionAttempts, maxFollowUps: 1, signal,
            })
            completionAttempts++
            followUp = review.followUp
            if (signal.aborted) break
            const postReview = this.#tasks.getMeta(task.id)
            const arrivedDuringReview = postReview.instructions.some((item) => !item.delivered) ||
              this.#tasks.runnableNodes(task.id).length > 0 ||
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
