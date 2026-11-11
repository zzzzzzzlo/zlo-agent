import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { handoffs, planTool, replanTool } from './agent-plan.ts'
import { ModelUnavailableError } from './execution.ts'
import type { AgentExecution, ExecutionConfig, ExecutionSession, ExecutionTool, RuntimeEvent } from './execution.ts'
import type { EndReason, EventDraft, ModelRoute, SessionRef } from './contracts/domain.ts'
import type { LocalJudgment } from './judgment.ts'
import type { ScopedContext } from './memory.ts'
import { ModelBudgetError } from './model-scheduler.ts'
import type { LocalModelScheduler } from './model-scheduler.ts'
import type { AgentRole, CapabilityScope, CodingCapabilities, CodingProfile, ExtensionRegistry } from './policies.ts'
import type { LocalStore } from './store.ts'
import type { NodeProposal, TaskEngine, TaskSnapshot, WorkerNode, WorkerResult } from './task-engine.ts'
import type { ToolApprovalBroker } from './tool-approval.ts'
import { ToolRun } from './tool-run.ts'
import { verifyWorkspace } from './verification.ts'
import { workspaceTarget } from './workspace.ts'
import type { CodingWorkspace } from './workspace.ts'

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
  | { status: 'interrupted' | 'model_error' | 'runtime_error' | 'checkpoint_error' | 'budget_exhausted' }

const MAX_TURNS = 16
const WORKER_DEADLINE_MS = 60000
const ROOT_DEADLINE_MS = 600000
type ProfileRuntime = ReturnType<ExtensionRegistry['resolve']>
type WorkerHandoff = WorkerResult & { verification?: WorkerNode['verification'] }

export function memoryScope(task: TaskSnapshot, route: ModelRoute): string {
  return JSON.stringify([task.conversationId ?? task.cwd, route.provider])
}

function receiptId(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 32)
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
  readonly #resolveWorkspace?: (workspace: CodingWorkspace, taskId: string, id: string, signal: AbortSignal) => Promise<CodingWorkspace | undefined>
  readonly #sessions: string
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
    this.#resolveWorkspace = ports.resolveWorkspace
    this.#sessions = ports.sessions
    this.#onOutput = ports.onOutput
    this.#onCheckpoint = ports.onCheckpoint
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
    return this.#db.get<SessionRef>('task-sessions', taskId) ?? this.#db.get<AgentRecord>('agents', taskId)?.session
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
    // Pi can emit the switch while opening the Session. Route changes are recorded after registration.
    if (runtime.type === 'model.route_changed' || runtime.type === 'instruction.applied') return
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
    this.#db.transaction(() => { this.#db.append({ ...event, type, payload }) })
  }

  #register(task: TaskSnapshot, session: ExecutionSession, event: EventDraft, agentKey: string, role: AgentRole,
    parentAgentId?: string): EventDraft {
    const recorded = { ...event, sessionId: session.ref.id }
    this.#db.transaction(() => {
      const agent: AgentRecord = { schemaVersion: 1, id: event.agentId!, taskId: task.id, role, session: session.ref, route: session.route, parentAgentId }
      const run: AgentRun = { schemaVersion: 1, event: recorded, role, status: 'active' }
      this.#db.put('agents', agentKey, agent)
      if (role === 'root') this.#db.put('task-sessions', task.id, session.ref)
      this.#db.put('agent-runs', event.agentRunId!, run)
      this.#db.append({ ...recorded, type: 'agent.started', payload: { role, route: session.route, parentAgentId, lifecycle: 'active' } })
    })
    return recorded
  }

  #finish(event: EventDraft, status: AgentRun['status'], result?: WorkerResult, role: AgentRole = 'root'): void {
    this.#db.transaction(() => {
      const run: AgentRun = { schemaVersion: 1, event, status, role }
      this.#db.put('agent-runs', event.agentRunId!, run)
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
    const timer = setTimeout(() => deadline.abort(), WORKER_DEADLINE_MS)
    const signal = AbortSignal.any([rootSignal, deadline.signal])
    let event: EventDraft = {
      taskId: task.id, taskRunId: task.taskRunId, taskNodeId: node.id,
      agentId: randomUUID(), agentRunId: randomUUID(), parentAgentRunId: parent.agentRunId, type: '', payload: {},
    }
    const evidence = new Set<string>()
    const artifacts = new Set<string>()
    const toolRun = new ToolRun(this.#tasks, this.#approval)
    let session: ExecutionSession | undefined
    let unwatch: (() => Promise<void>) | undefined
    let lease: ReturnType<LocalModelScheduler['reserve']> | undefined
    let result: WorkerHandoff | undefined
    let executionCompleted = false
    let verification: Awaited<ReturnType<typeof verifyWorkspace>> | undefined
    let started = false
    let registered = false
    let teamLease: string | undefined
    let childActive = false
    let workspaceActive = false
    const blockingWrite = () => this.#tasks.blocksToolWork(task.id, undefined, node.worktreeId)
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
      lease = this.#scheduler.reserve(() => event, role)
      const scope = this.#capabilities.child(parentScope, node.access, node.scopePath, role)
      const teamKey = role === 'team'
        ? 'team-' + createHash('sha256').update(JSON.stringify([task.conversationId ?? task.id, node.teamKey, parentRoute.provider,
          { access: scope.access, path: scope.path, worktreeId: node.worktreeId }])).digest('hex')
        : undefined
      const saved = teamKey ? this.#db.get<AgentRecord>('agents', teamKey) : undefined
      if (teamKey) {
        if (this.#activeTeams.has(teamKey)) throw new Error('Team Session is active')
        this.#activeTeams.add(teamKey)
        teamLease = teamKey
        if (saved) event = { ...event, agentId: saved.id }
      }
      const route = await this.#scheduler.allocate(event, parentRoute, node.route ?? saved?.route, Boolean(node.role))
      const tools = this.#extensions.tools(workspace, role, scope.access)
        .filter(tool => this.#capabilities.describe(scope, tool))
        .map(tool => {
          const wrapped = toolRun.wrap(tool, workspace, () => event, signal, input =>
            !childActive && !blockingWrite() && this.#capabilities.authorize(scope, tool, input), evidence, artifacts)
          return {
            ...wrapped,
            execute: async (id: string, input: unknown, toolSignal?: AbortSignal) => {
              if (workspaceActive) return { ok: false, error: 'Another workspace tool is active' }
              workspaceActive = true
              try { return await wrapped.execute(id, input, toolSignal) } finally { workspaceActive = false }
            },
          } as ExecutionTool
        })
      const runChild = async (child: WorkerNode) => {
        if (childActive || workspaceActive || signal.aborted || !session) return undefined
        childActive = true
        try {
          return await this.#worker(task, child, event, workspace, session.route, scope, signal, true)
        } finally {
          childActive = false
        }
      }
      if (role === 'team' && this.#profile.delegation && this.#capabilities.enabled('delegate_worker')) tools.push({
        name: 'delegate_worker',
        description: 'Delegate a scoped read-only investigation within the current Team node and wait for its evidence and verification status.',
        parameters: {
          type: 'object', additionalProperties: false, required: ['goal'],
          properties: { goal: { type: 'string', minLength: 1, maxLength: 8000 } },
        },
        execute: async (id, input, toolSignal) => {
          if (!this.#capabilities.enabled('delegate_worker') || !input || typeof input !== 'object' || !('goal' in input) || typeof input.goal !== 'string' ||
            signal.aborted || toolSignal?.aborted || childActive || workspaceActive || blockingWrite()) {
            return { ok: false, error: 'Delegation unavailable' }
          }
          const goal = input.goal
          const nonEmptyGoal = goal.trim().length > 0
          const requestId = 'team:' + event.agentRunId + ':' + receiptId(id)
          if (!await this.#judgment.decide(event, 'delegation.worth', { role, goalLength: goal.length, nonEmptyGoal }, nonEmptyGoal,
            [true, false], [node.id], { planRequestId: requestId }) || !this.#capabilities.enabled('delegate_worker') || signal.aborted || toolSignal?.aborted) {
            return { ok: false, error: 'Delegation declined' }
          }
          try {
            const current = this.#tasks.get(task.id)
            const existing = current.nodes?.find(child => child.parentNodeId === node.id && child.goal === goal)
            const child = existing ?? this.#tasks.proposePlan(task.id, requestId,
              current.planVersion, [{ ref: 'child', goal, parentNodeId: node.id, role: 'worker' }])[0]!
            const result = child.result ? { ...child.result, verification: child.verification } : await runChild(child)
            return result ? { ok: result.resultStatus === 'succeeded', ...result } : { ok: false, error: 'Worker interrupted' }
          } catch {
            return { ok: false, error: 'Delegation rejected by task scope or budget' }
          }
        },
      })
      signal.throwIfAborted()
      session = await this.#execution.open({
        cwd: workspace.root, role, correlationId: event.agentRunId,
        sessionDirectory: join(this.#sessions, teamKey ?? task.id), session: saved?.session, route, tools,
        systemPrompt: this.#extensions.workflow.systemPrompt(role, scope.access, node.check),
        reserveRequest: (request) => {
          signal.throwIfAborted()
          if (blockingWrite()) throw new Error('Unconfirmed workspace operation')
          lease!.request(request)
        },
        onEvent: (runtime) => {
          if (runtime.type === 'model.usage') lease!.usage(runtime)
          this.#emit(event, runtime, role)
        },
      })
      if (!sameRoute(session.route, route) || (saved && (session.ref.id !== saved.session.id || session.ref.path !== saved.session.path))) {
        throw new Error('Child Session identity or route changed')
      }
      event = this.#register(task, session, event, teamKey ?? event.agentId!, role, parent.agentId)
      registered = true
      unwatch = this.#watchStop(session, signal)
      while (role === 'team' && !signal.aborted) {
        const child = this.#tasks.runnableNodes(task.id, node.id)[0]
        if (!child || !await runChild(child)) break
      }
      if (!signal.aborted) {
        const nodes = this.#tasks.get(task.id).nodes ?? []
        const childNodes = nodes.filter(child => child.parentNodeId === node.id)
        const dependencies = nodes.filter(item => node.dependencies.includes(item.id))
        const constraints = [
          scope.access === 'read' ? 'Read-only workspace access.' : 'Workspace changes must remain inside the assigned scope.',
          scope.path ? 'Use workspace-relative paths under ' + scope.path + '.' : 'Use workspace-relative paths.',
          'Return a short summary of observed evidence and any remaining risks.',
          ...(childNodes.length ? ['Child handoffs: ' + JSON.stringify(handoffs(childNodes)).slice(0, 8000)] : []),
          ...(dependencies.length ? ['Completed prerequisites: ' + JSON.stringify(dependencies.map(item => ({
            id: item.id, status: item.status, evidenceRefs: item.result?.evidenceRefs, verification: item.verification,
          }))).slice(0, 4000)] : []),
        ]
        const target = workspaceTarget(node.check ?? (scope.path ? undefined : task.check))
        const prompt = await this.#context.build(event, {
          scope: scope.path || node.worktreeId ? JSON.stringify([memoryScope(task, session.route), scope.path, node.worktreeId])
            : memoryScope(task, session.route),
          goal: node.goal, constraints,
          artifactRefs: target ? [target] : [], availableTools: tools.map(tool => tool.name), signal,
        })
        signal.throwIfAborted()
        const outcome = await session.run(prompt)
        executionCompleted = outcome.status === 'completed'
        if (!signal.aborted && outcome.status === 'completed' && outcome.text.trim()) {
          if (node.check?.command && !this.#capabilities.enabled('run_project_command')) {
            verification = { passed: false, evidence: 'project_command_disabled' }
          } else if (node.check) verification = await verifyWorkspace(this.#tasks, this.#extensions.workflow,
            workspace, event, node.check, signal,
            node.check.command && !node.worktreeId && !scope.path && parentScope.access === 'trusted' && node.access === 'write' ? 'trusted' : scope.access)
          const completedChildren = this.#tasks.get(task.id).nodes?.filter(child =>
            child.parentNodeId === node.id && child.status === 'succeeded').length ?? 0
          const hardEvidence = node.check ? verification?.passed === true : evidence.size > 0 || completedChildren > 0
          const accepted = await this.#judgment.decide(event, 'handoff.sufficiency', {
            evidenceCount: evidence.size, artifactCount: artifacts.size, checked: Boolean(node.check),
            checkPassed: verification?.passed === true, role, access: scope.access, completedChildren,
          }, hardEvidence, hardEvidence ? [true, false] : [false], [...evidence])
          result = {
            resultStatus: hardEvidence && accepted ? 'succeeded' : 'failed',
            executionStatus: 'completed',
            summary: outcome.text.slice(0, 1600), artifactRefs: [...artifacts], evidenceRefs: [...evidence],
            remainingRisks: hardEvidence && accepted ? [] : ['verification_failed'],
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
        remainingRisks: [deadline.signal.aborted ? 'worker_deadline' : 'worker_failed'],
      }
      if (rootSignal.aborted) result = undefined
      if (started) {
        const settled = this.#tasks.settleWorker(task.id, node.id, result, verification, event.taskAttemptId)
        result = settled?.result ? { ...settled.result, verification: settled.verification } : undefined
      }
      if (registered) this.#finish(event, rootSignal.aborted ? 'interrupted'
        : result?.resultStatus === 'succeeded' ? 'completed' : result ? 'failed' : 'interrupted', result, role)
    }
    return result
  }


  async run(task: TaskSnapshot, workspace: CodingWorkspace, stopSignal: AbortSignal): Promise<Outcome> {
    const toolRun = new ToolRun(this.#tasks, this.#approval)
    const budget = new AbortController()
    const signal = AbortSignal.any([stopSignal, budget.signal])
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
    const seenSteers = new Set<string>()
    const queuedSteers = new Set<string>()
    let prompted = new Set<string>()
    let outcome: Outcome = { status: 'runtime_error' }
    const rootScope = this.#capabilities.root(task.workspaceAccess, Boolean(task.check))
    const hasUnknownWrite = () => this.#tasks.blocksToolWork(task.id)
    const dispatchAllowed = (toolSignal?: AbortSignal) =>
      this.#profile.delegation && !signal.aborted && !toolSignal?.aborted && !workspaceActive && !workerActive && !hasUnknownWrite()
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
      try {
        while (!signal.aborted && !hasUnknownWrite()) {
          const batch = this.#tasks.runnableNodes(task.id)
          if (!batch.length) break
          const settled = await Promise.allSettled(batch.map(node =>
            this.#worker(task, node, event, workspace, route, rootScope, signal)))
          const failure = settled.find(outcome => outcome.status === 'rejected')
          if (failure) throw failure.reason
          const latest = this.#tasks.get(task.id)
          let progressed = false
          for (const previous of batch) {
            const node = latest.worker?.id === previous.id ? latest.worker : latest.nodes?.find(item => item.id === previous.id)
            if (!node || node.status === 'ready') continue
            progressed = true
            completed.add(node.id)
          }
          if (!progressed) break
        }
      } finally {
        workerActive = false
      }
      const latest = this.#tasks.get(task.id)
      return [latest.worker, ...(latest.nodes ?? [])].filter((node): node is WorkerNode => Boolean(node && completed.has(node.id)))
    }
    const tools: ExecutionTool[] = this.#extensions.tools(workspace, 'root', rootScope.access)
      .filter(tool => this.#capabilities.describe(rootScope, tool))
      .map(tool => {
        const wrapped = toolRun.wrap(tool, workspace, () => event, signal, input =>
          !workerActive && !this.#tasks.blocksToolWork(task.id, tool.policy?.whileActive ? event.agentRunId : undefined) &&
          this.#capabilities.authorize(rootScope, tool, input))
        return {
          ...wrapped,
          execute: async (id, input, toolSignal) => {
            if (workspaceActive) return { ok: false, error: 'Another workspace tool is active' }
            workspaceActive = true
            try { return await wrapped.execute(id, input, toolSignal) } finally { workspaceActive = false }
          },
        }
      })
    if (this.#profile.delegation) {
      if (this.#capabilities.enabled('delegate_task')) tools.push({
        name: 'delegate_task',
        description: 'Run a single temporary read-only worker for a well-scoped investigation. Returns a structured result.',
        parameters: {
          type: 'object', additionalProperties: false, required: ['goal'],
          properties: { goal: { type: 'string', minLength: 1, maxLength: 8000 } },
        },
        execute: async (id, input, toolSignal) => {
          if (!this.#capabilities.enabled('delegate_task') || !dispatchAllowed(toolSignal) || !input || typeof input !== 'object' ||
            !('goal' in input) || typeof input.goal !== 'string') return { ok: false, error: 'Delegation unavailable' }
          const goal = input.goal
          const nonEmptyGoal = goal.trim().length > 0
          const operationId = event.agentRunId + ':' + id
          const shouldDelegate = await this.#judgment.decide(event, 'delegation.worth',
            { role: 'root', goalLength: goal.length, nonEmptyGoal }, nonEmptyGoal, [true, false], [task.rootNodeId],
            { delegationReceiptId: operationId })
          if (!shouldDelegate || !this.#capabilities.enabled('delegate_task') || !dispatchAllowed(toolSignal)) {
            return { ok: false, error: 'Delegation unavailable' }
          }
          this.#tasks.beginTool(task.id, event, operationId, 'delegate_task', 'read')
          let result: WorkerHandoff | undefined
          try {
            const node = this.#tasks.delegate(task.id, goal)
            result = await runWorker(node)
          } catch {
            this.#tasks.finishTool(event, operationId, 'failed')
            return { ok: false, error: 'Delegation rejected by task scope or budget' }
          }
          this.#tasks.finishTool(event, operationId, result?.resultStatus === 'succeeded' ? 'succeeded' : 'failed')
          return result ? { ok: result.resultStatus === 'succeeded', ...result } : { ok: false, error: 'Worker interrupted' }
        },
      })
      if (this.#capabilities.enabled('propose_task_plan')) tools.push(planTool(async (id, proposals, toolSignal) => {
        if (!this.#capabilities.enabled('propose_task_plan') || !dispatchAllowed(toolSignal) || !session || !proposals.length || proposals.length > 8) {
          return { ok: false, error: 'Planning unavailable' }
        }
        try {
          const requestId = 'plan:' + event.agentRunId + ':' + receiptId(id)
          const planned: NodeProposal[] = []
          for (const proposal of proposals) {
            if (!proposal || typeof proposal !== 'object') throw new Error('Invalid node proposal')
            this.#capabilities.child(rootScope, proposal.access, proposal.scopePath)
            if (proposal.route && !this.#scheduler.canSwitch(session.route, proposal.route)) {
              throw new Error('Cross-provider delegation is not authorized')
            }
            const teamCandidate = Boolean(proposal.teamKey)
            const baseline = proposal.role ?? (teamCandidate ? 'team' : 'worker')
            const role = await this.#judgment.decide(event, 'collaboration.mode',
              { nodeCount: proposals.length, nodeOrdinal: planned.length, teamCandidate, hasDependencies: Boolean(proposal.dependencies?.length) },
              baseline, !proposal.role && teamCandidate ? ['worker', 'team'] : [baseline], [task.rootNodeId], { planRequestId: requestId })
            planned.push({ ...proposal, role, ...(role === 'worker' ? { teamKey: undefined } : {}) })
          }
          if (!this.#capabilities.enabled('propose_task_plan') || !dispatchAllowed(toolSignal)) return { ok: false, error: 'Planning interrupted' }
          const current = this.#tasks.get(task.id)
          const nodes = this.#tasks.proposePlan(task.id, requestId, current.planVersion, planned)
          await drain()
          const latest = this.#tasks.get(task.id)
          const handoff = handoffs((latest.nodes ?? []).filter(node => nodes.some(({ id }) => id === node.id)))
          return { ok: handoff.every(node => node.status === 'succeeded'), planVersion: latest.planVersion, nodes: handoff }
        } catch {
          return { ok: false, error: 'Plan rejected by task scope, dependency, or budget' }
        }
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
          { status: node?.status ?? 'missing', requested: true, isRootChild, hasWrite, replanCount },
          safe, safe ? [true, false] : [false], node ? [node.id] : [], { planRequestId: requestId })
        if (!revise || !this.#capabilities.enabled('replan_task_node') || !dispatchAllowed(toolSignal)) {
          return { ok: false, error: 'Replan declined or unsafe' }
        }
        try {
          this.#tasks.replanNode(task.id, requestId, current.planVersion, nodeId, update)
          await drain()
          const latest = this.#tasks.get(task.id)
          return { ok: true, planVersion: latest.planVersion, nodes: handoffs(latest.nodes?.filter(node => node.id === nodeId) ?? []) }
        } catch {
          return { ok: false, error: 'Replan rejected by task scope, version, or budget' }
        }
      }))
    }
    const config = (route: ModelRoute | undefined, ref?: SessionRef): ExecutionConfig => ({
      cwd: workspace.root, role: 'root', correlationId: event.agentRunId,
      sessionDirectory: join(this.#sessions, agentKey), session: ref, route, tools,
      systemPrompt: this.#extensions.workflow.systemPrompt('root', rootScope.access, task.check),
      reserveRequest: (request) => {
        signal.throwIfAborted()
        if (this.#tasks.blocksToolWork(task.id, event.agentRunId)) throw new Error('Unconfirmed workspace operation')
        try { lease!.request(request) } catch (error) {
          if (error instanceof ModelBudgetError) budget.abort()
          throw error
        }
      },
      onEvent: (runtime) => {
        if (runtime.type === 'instruction.applied') seenSteers.add(runtime.instructionId)
        if (runtime.type === 'message.delta' && runtime.delta) {
          streamed = true
          textProduced ||= Boolean(runtime.delta.trim())
        }
        try {
          if (runtime.type === 'model.usage') lease!.usage(runtime)
          this.#emit(event, runtime, 'root')
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
        if (saveCheckpoint) {
          await current.checkpoint()
          this.#onCheckpoint?.(task.id)
          this.#tasks.markDelivered(task.id, [...seenSteers])
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
      deadline = setTimeout(() => budget.abort(), ROOT_DEADLINE_MS)
      lockRoute()
      const initialRoute = this.#tasks.get(task.id).route ?? saved?.route
      if (saved && initialRoute && !this.#scheduler.canSwitch(saved.route, initialRoute)) return { status: 'model_error' }
      if (initialRoute) {
        try {
          await this.#scheduler.allocate(event, initialRoute, initialRoute)
        } catch {
          return { status: 'model_error' }
        }
      }
      if (signal.aborted) return { status: 'interrupted' }
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
        event = this.#register(task, session, event, agentKey, 'root')
        registered = true
        this.#steering.set(task.id, async (id, text) => {
          if (!session || signal.aborted || prompted.has(id) || queuedSteers.has(id)) return false
          const item = this.#tasks.get(task.id).instructions.find((instruction) => instruction.id === id)
          if (!item || item.delivered) return false
          queuedSteers.add(id)
          try {
            await session.steer(text, id)
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
        let nextPrompt = saved?.taskId === task.id
          ? 'Resume the task using the saved conversation. Recheck current workspace state before new edits and avoid repeating confirmed changes.\n\nOriginal task goal: ' + task.goal
          : task.goal
        for (let turn = 0; turn < MAX_TURNS && !signal.aborted; turn++) {
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
            this.#db.transaction(() => {
              const agent = this.#db.get<AgentRecord>('agents', agentKey)!
              this.#db.put('agents', agentKey, { ...agent, route: applied })
              this.#db.append({ ...event, type: 'model.route_changed', payload: { route: applied } })
            })
            unlockRoute()
          }
          const completedNodes = await drain()
          if (signal.aborted) break
          if (completedNodes.length) nextPrompt += '\nAgent handoffs:\n' + JSON.stringify(handoffs(completedNodes)).slice(0, 8000)
          const latest = this.#tasks.get(task.id)
          if (conversationId && latest.route && !sameRoute(latest.route, session.route)) continue
          const instructions = latest.instructions.filter((item) => !item.delivered)
          prompted = new Set(instructions.map(({ id }) => id))
          const prompt = await this.#context.build(event, {
            scope: memoryScope(task, session.route), goal: nextPrompt,
            constraints: instructions.map(({ text }) => 'Additional user instruction: ' + text),
            signal,
          })
          if (signal.aborted) break
          streamed = false
          const result = await session.run(prompt)
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
          seenSteers.clear()
          queuedSteers.clear()
          const after = this.#tasks.get(task.id)
          const more = after.instructions.some((item) => !item.delivered) || this.#tasks.runnableNodes(task.id).length > 0 ||
            (!conversationId && after.route && !sameRoute(after.route, session.route))
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
        unlockRoute()
        clearTimeout(deadline)
        lease?.release()
      }
      if (checkpointFailed || outputFailed) outcome = { status: 'checkpoint_error' }
      else if (stopSignal.aborted) outcome = { status: 'interrupted' }
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
