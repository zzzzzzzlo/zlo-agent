import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ModelUnavailableError } from './execution.ts'
import type { AgentExecution, ExecutionConfig, ExecutionSession, ExecutionTool, ModelRoute, RuntimeEvent, SessionRef } from './execution.ts'
import type { CapabilityGateway, CodingProfile, ContextBuilder, JudgmentKernel, ModelResourceScheduler } from './policies.ts'
import type { LocalStore, EventDraft } from './store.ts'
import type { EndReason, TaskEngine, TaskSnapshot, WorkerNode, WorkerResult } from './task-engine.ts'
import { workspaceTarget } from './workspace.ts'
import type { CodingWorkspace, WorkspaceTool } from './workspace.ts'

interface AgentRecord {
  schemaVersion: 1
  id: string
  taskId: string
  role: 'root' | 'worker'
  session: SessionRef
  route: ModelRoute
}
interface AgentRun {
  schemaVersion: 1
  event: EventDraft
  status: 'active' | 'completed' | 'interrupted' | 'failed'
}
export interface OutputEvent {
  taskId: string
  agentRunId: string
  role: 'root' | 'worker'
  delta: string
}

type Outcome =
  | { status: 'completed'; route: ModelRoute }
  | { status: 'interrupted' | 'model_error' | 'runtime_error' | 'checkpoint_error' | 'budget_exhausted' }

const MAX_TURNS = 16
const WORKER_DEADLINE_MS = 60000
const ROOT_MODEL_REQUESTS = 32
const WORKER_MODEL_REQUESTS = 8

export class MultiAgentOrchestrator {
  readonly #db: LocalStore
  readonly #tasks: TaskEngine
  readonly #execution: AgentExecution
  readonly #scheduler: ModelResourceScheduler
  readonly #capabilities: CapabilityGateway
  readonly #profile: Readonly<CodingProfile>
  readonly #context: ContextBuilder
  readonly #judgment: JudgmentKernel
  readonly #sessions: string
  readonly #outputSinks = new Set<(event: OutputEvent) => void | Promise<void>>()

  constructor(ports: {
    store: LocalStore; tasks: TaskEngine; execution: AgentExecution; scheduler: ModelResourceScheduler;
    capabilities: CapabilityGateway; profile: Readonly<CodingProfile>; context: ContextBuilder; judgment: JudgmentKernel; sessions: string;
  }) {
    this.#db = ports.store
    this.#tasks = ports.tasks
    this.#execution = ports.execution
    this.#scheduler = ports.scheduler
    this.#capabilities = ports.capabilities
    this.#profile = ports.profile
    this.#context = ports.context
    this.#judgment = ports.judgment
    this.#sessions = ports.sessions
  }

  subscribeOutput(sink: (event: OutputEvent) => void | Promise<void>): () => void {
    this.#outputSinks.add(sink)
    return () => { this.#outputSinks.delete(sink) }
  }

  rootRoute(taskId: string): ModelRoute | undefined {
    return this.#db.get<AgentRecord>('agents', taskId)?.route
  }

  session(taskId: string): SessionRef | undefined {
    return this.#db.get<AgentRecord>('agents', taskId)?.session
  }

  recover(): void {
    this.#db.transaction(() => {
      for (const run of this.#db.list<AgentRun>('agent-runs')) {
        if (run.status !== 'active' || !run.event.agentRunId) continue
        this.#db.put('agent-runs', run.event.agentRunId, { ...run, status: 'interrupted' })
        this.#db.append({ ...run.event, type: 'agent.finished', payload: { status: 'interrupted', reason: 'process_interrupted' } })
      }
    })
  }

  #emit(event: EventDraft, runtime: RuntimeEvent, role: AgentRecord['role']): void {
    // Pi can emit the switch while opening the Session. Route changes are recorded after registration.
    if (runtime.type === 'model.route_changed') return
    if (runtime.type === 'message.delta') {
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

  #register(task: TaskSnapshot, session: ExecutionSession, event: EventDraft, agentKey: string, role: AgentRecord['role']): EventDraft {
    const recorded = { ...event, sessionId: session.ref.id }
    this.#db.transaction(() => {
      const agent: AgentRecord = { schemaVersion: 1, id: event.agentId!, taskId: task.id, role, session: session.ref, route: session.route }
      const run: AgentRun = { schemaVersion: 1, event: recorded, status: 'active' }
      this.#db.put('agents', agentKey, agent)
      this.#db.put('agent-runs', event.agentRunId!, run)
      this.#db.append({ ...recorded, type: 'agent.started', payload: { role, route: session.route } })
    })
    return recorded
  }

  #finish(event: EventDraft, status: AgentRun['status'], result?: WorkerResult): void {
    this.#db.transaction(() => {
      const run: AgentRun = { schemaVersion: 1, event, status }
      this.#db.put('agent-runs', event.agentRunId!, run)
      this.#db.append({
        ...event, type: 'agent.finished',
        payload: { status, ...(result ? { evidenceCount: result.evidenceRefs.length } : {}) },
      })
    })
  }

  #wrap(tool: WorkspaceTool, event: () => EventDraft, signal: AbortSignal,
    authorize: () => boolean, evidence?: Set<string>, artifacts?: Set<string>): ExecutionTool {
    return {
      ...tool,
      execute: async (callId, input, toolSignal) => {
        if (signal.aborted || toolSignal?.aborted || !authorize()) return { ok: false, error: 'Tool work is unavailable' }
        const ref = event()
        const operationId = ref.agentRunId + ':' + callId
        this.#tasks.beginTool(ref.taskId, ref, operationId, tool.name, tool.effect,
          tool.effect === 'write' ? workspaceTarget(input) : undefined)
        let result: unknown
        try {
          const combined = toolSignal ? AbortSignal.any([signal, toolSignal]) : signal
          result = await tool.execute(callId, input, combined)
        } catch {
          this.#tasks.finishTool(ref, operationId, tool.effect === 'write' ? 'unknown_effect' : 'failed')
          return { ok: false, error: tool.effect === 'write' ? 'Write result requires reconciliation' : 'Tool failed' }
        }
        const failed = !result || typeof result !== 'object' || !('ok' in result) || result.ok !== true
        this.#tasks.finishTool(ref, operationId, failed ? 'failed' : 'succeeded')
        if (!failed) {
          evidence?.add(operationId)
          const target = tool.name === 'read_text_file' ? workspaceTarget(input) : undefined
          if (target) artifacts?.add(target)
        }
        return result
      },
    }
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
    route: ModelRoute, rootSignal: AbortSignal): Promise<WorkerResult | undefined> {
    const release = this.#scheduler.reserve(task.id, 'worker')
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), WORKER_DEADLINE_MS)
    const signal = AbortSignal.any([rootSignal, deadline.signal])
    let event: EventDraft = {
      taskId: task.id, taskRunId: task.attemptId, taskAttemptId: task.attemptId, taskNodeId: node.id,
      agentId: randomUUID(), agentRunId: randomUUID(), parentAgentRunId: parent.agentRunId, type: '', payload: {},
    }
    const evidence = new Set<string>()
    const artifacts = new Set<string>()
    let session: ExecutionSession | undefined
    let unwatch: (() => Promise<void>) | undefined
    let result: WorkerResult | undefined
    let started = false
    let registered = false
    let requests = 0
    try {
      if (rootSignal.aborted) return undefined
      const attemptId = this.#tasks.startWorker(task.id, node.id)
      event = { ...event, taskAttemptId: attemptId }
      started = true
      session = await this.#execution.open({
        cwd: workspace.root, role: 'worker', sessionDirectory: join(this.#sessions, task.id), route,
        tools: workspace.tools('worker').map((tool) =>
          this.#wrap(tool, () => event, signal, () => this.#capabilities.authorize('worker', tool.effect), evidence, artifacts)),
        systemPrompt: 'You are a temporary read-only coding worker. Use tools for evidence and return a short summary.',
        onEvent: (runtime) => {
          if (runtime.type === 'model.request_started' && ++requests > WORKER_MODEL_REQUESTS) deadline.abort()
          this.#emit(event, runtime, 'worker')
        },
      })
      event = this.#register(task, session, event, event.agentId!, 'worker')
      registered = true
      unwatch = this.#watchStop(session, signal)
      if (!signal.aborted) {
        const outcome = await session.run(this.#context.worker(node.goal))
        if (!signal.aborted && outcome.status === 'completed' && evidence.size > 0 && outcome.text.trim()) {
          result = {
            resultStatus: 'succeeded', summary: outcome.text.slice(0, 1600),
            artifactRefs: [...artifacts], evidenceRefs: [...evidence], remainingRisks: [],
          }
        }
      }
    } catch {
      // Failure is recorded after disposal, together with bounded evidence references.
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
        clearTimeout(timer)
        release()
      }
      if (!rootSignal.aborted && !result) {
        result = {
          resultStatus: 'failed', summary: 'Worker did not produce verified read evidence.',
          artifactRefs: [...artifacts], evidenceRefs: [...evidence],
          remainingRisks: [deadline.signal.aborted ? 'worker_deadline' : 'worker_failed'],
        }
      }
      if (rootSignal.aborted) result = undefined
      if (started) this.#tasks.settleWorker(task.id, node.id, result)
      if (registered) this.#finish(event, result?.resultStatus === 'succeeded' ? 'completed' : result ? 'failed' : 'interrupted', result)
    }
    return result
  }

  async run(task: TaskSnapshot, workspace: CodingWorkspace, stopSignal: AbortSignal): Promise<Outcome> {
    const release = this.#scheduler.reserve(task.id, 'root')
    const budget = new AbortController()
    const signal = AbortSignal.any([stopSignal, budget.signal])
    const saved = this.#db.get<AgentRecord>('agents', task.id)
    let event: EventDraft = {
      taskId: task.id, taskRunId: task.attemptId, taskAttemptId: task.attemptId, taskNodeId: task.rootNodeId,
      agentId: saved?.id ?? randomUUID(), agentRunId: randomUUID(), type: '', payload: {},
    }
    let session: ExecutionSession | undefined
    let unwatch: (() => Promise<void>) | undefined
    let registered = false
    let workerActive = false
    let workspaceActive = false
    let checkpointFailed = false
    let requests = 0
    let outcome: Outcome = { status: 'runtime_error' }
    const runWorker = async (node: WorkerNode): Promise<WorkerResult | undefined> => {
      if (!this.#profile.delegation) throw new Error('The Coding profile disables delegation')
      if (!session || workerActive || workspaceActive || signal.aborted) throw new Error('Worker cannot start at this boundary')
      if (node.result) return node.result
      workerActive = true
      try {
        return await this.#worker(task, node, event, workspace, session.route, signal)
      } finally {
        workerActive = false
      }
    }
    const hasUnknownWrite = () => this.#tasks.operations(task.id).some(({ effect, status }) =>
      effect === 'write' && (status === 'unknown_effect' || status === 'started'))
    const tools = workspace.tools('root').filter((tool) => this.#capabilities.authorize('root', tool.effect)).map((tool) => {
      const wrapped = this.#wrap(tool, () => event, signal, () =>
        !workerActive && !hasUnknownWrite() && this.#capabilities.authorize('root', tool.effect))
      return {
        ...wrapped,
        execute: async (id: string, input: unknown, toolSignal?: AbortSignal) => {
          if (workspaceActive) return { ok: false, error: 'Another workspace tool is active' }
          workspaceActive = true
          try {
            return await wrapped.execute(id, input, toolSignal)
          } finally {
            workspaceActive = false
          }
        },
      }
    })
    if (this.#profile.delegation) tools.push({
      name: 'delegate_task',
      description: 'Run a single temporary read-only worker for a well-scoped investigation. Returns a structured result.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['goal'],
        properties: { goal: { type: 'string', minLength: 1, maxLength: 8000 } },
      },
      execute: async (id, input, toolSignal) => {
        if (signal.aborted || toolSignal?.aborted || workerActive || workspaceActive || hasUnknownWrite()) {
          return { ok: false, error: 'Delegation unavailable' }
        }
        if (!input || typeof input !== 'object' || !('goal' in input) || typeof input.goal !== 'string') {
          return { ok: false, error: 'A scoped goal is required' }
        }
        const goal = input.goal
        const decision = await this.#judgment.evaluate({
          id: 'delegation.worth', schemaVersion: 1, mode: 'off',
          baseline: (value: string) => value.trim().length > 0,
        }, goal, [task.rootNodeId])
        this.#db.transaction(() => {
          this.#db.append({ ...event, type: 'judgment.evaluated', payload: { ...decision } })
        })
        if (!decision.baseline || signal.aborted || toolSignal?.aborted || workerActive || workspaceActive) {
          return { ok: false, error: 'Delegation unavailable' }
        }
        const operationId = event.agentRunId + ':' + id
        this.#tasks.beginTool(task.id, event, operationId, 'delegate_task', 'read')
        let result: WorkerResult | undefined
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
    const config = (route: ModelRoute | undefined, ref?: SessionRef): ExecutionConfig => ({
      cwd: workspace.root, role: 'root', sessionDirectory: join(this.#sessions, task.id), session: ref, route, tools,
      systemPrompt: 'You are a local coding agent. Use the listed tools for scoped text changes. A deterministic file check decides acceptance. Do not request credentials.',
      onEvent: (runtime) => {
        if (runtime.type === 'model.request_started' && ++requests > ROOT_MODEL_REQUESTS) budget.abort()
        this.#emit(event, runtime, 'root')
      },
    })
    const closeSession = async () => {
      if (!session) return
      const current = session
      session = undefined
      try {
        await unwatch?.()
        await current.checkpoint()
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
    let openingSavedSession = false
    try {
      const initialRoute = task.route ?? saved?.route
      if (initialRoute) {
        try {
          await this.#scheduler.validateRoute(initialRoute)
        } catch {
          return { status: 'model_error' }
        }
      }
      if (signal.aborted) return { status: 'interrupted' }
      openingSavedSession = Boolean(saved)
      session = await this.#execution.open(config(initialRoute, saved?.session))
      openingSavedSession = false
      if (saved && saved.session.id !== session.ref.id) {
        outcome = { status: 'checkpoint_error' }
      } else {
        unwatch = this.#watchStop(session, signal)
        event = this.#register(task, session, event, task.id, 'root')
        registered = true
        if (saved && !sameRoute(saved.route, session.route)) {
          const route = session.route
          this.#db.transaction(() => { this.#db.append({ ...event, type: 'model.route_changed', payload: { route } }) })
        }
        let nextPrompt = saved
          ? 'Resume the task using the saved conversation. Recheck current workspace state before new edits and avoid repeating confirmed changes.\n\nOriginal task goal: ' + task.goal
          : task.goal
        for (let turn = 0; turn < MAX_TURNS && !signal.aborted; turn++) {
          const current = this.#tasks.get(task.id)
          if (current.route && !sameRoute(current.route, session.route)) {
            if (!this.#scheduler.canSwitch(session.route, current.route)) throw new ModelUnavailableError('Route conflicts with current provider')
            const ref = session.ref
            await closeSession()
            if (signal.aborted) break
            openingSavedSession = true
            session = await this.#execution.open(config(current.route, ref))
            openingSavedSession = false
            if (session.ref.id !== ref.id) {
              outcome = { status: 'checkpoint_error' }
              break
            }
            unwatch = this.#watchStop(session, signal)
            const applied = session.route
            this.#db.transaction(() => {
              const agent = this.#db.get<AgentRecord>('agents', task.id)!
              this.#db.put('agents', task.id, { ...agent, route: applied })
              this.#db.append({ ...event, type: 'model.route_changed', payload: { route: applied } })
            })
          }
          const workerResult = current.worker?.status === 'ready' ? await runWorker(current.worker) : undefined
          if (signal.aborted) break
          if (workerResult) nextPrompt += '\nWorker result:\n' + JSON.stringify(workerResult)
          const instructions = this.#tasks.get(task.id).instructions.filter((item) => !item.delivered)
          const prompt = [nextPrompt, ...instructions.map(({ text }) => 'Additional user instruction: ' + text)].join('\n\n')
          const result = await session.run(prompt)
          if (result.status !== 'completed') {
            outcome = result
            break
          }
          try {
            await session.checkpoint()
          } catch (error) {
            checkpointFailed = true
            throw error
          }
          this.#tasks.markDelivered(task.id, instructions.map(({ id }) => id))
          const after = this.#tasks.get(task.id)
          const more = after.instructions.some((item) => !item.delivered) || after.worker?.status === 'ready' ||
            (after.route && !sameRoute(after.route, session.route))
          if (!more || hasUnknownWrite()) {
            outcome = { status: 'completed', route: session.route }
            break
          }
          nextPrompt = 'Continue the current task using the updates in this turn.'
        }
      }
    } catch (error) {
      outcome = { status: error instanceof ModelUnavailableError ? 'model_error'
        : openingSavedSession || checkpointFailed ? 'checkpoint_error' : 'runtime_error' }
    } finally {
      try {
        await closeSession()
      } catch {
        checkpointFailed = true
      } finally {
        release()
      }
      if (checkpointFailed) outcome = { status: 'checkpoint_error' }
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
