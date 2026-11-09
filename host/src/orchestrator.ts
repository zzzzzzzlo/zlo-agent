import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ModelUnavailableError } from './execution.ts'
import type { AgentExecution, ExecutionConfig, ExecutionSession, ExecutionTool, RuntimeEvent } from './execution.ts'
import type { EndReason, EventDraft, ModelRoute, SessionRef } from './contracts/domain.ts'
import type { CapabilityGateway, CodingProfile, ContextBuilder, JudgmentKernel, ModelResourceScheduler } from './policies.ts'
import type { LocalStore } from './store.ts'
import type { TaskEngine, TaskSnapshot, WorkerNode, WorkerResult } from './task-engine.ts'
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
  | { status: 'completed'; route: ModelRoute; textProduced: boolean }
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
  readonly #onOutput?: (event: EventDraft, delta: string) => void
  readonly #outputSinks = new Set<(event: OutputEvent) => void | Promise<void>>()
  readonly #steering = new Map<string, (id: string, text: string) => Promise<boolean>>()

  constructor(ports: {
    store: LocalStore; tasks: TaskEngine; execution: AgentExecution; scheduler: ModelResourceScheduler;
    capabilities: CapabilityGateway; profile: Readonly<CodingProfile>; context: ContextBuilder; judgment: JudgmentKernel; sessions: string;
    onOutput?: (event: EventDraft, delta: string) => void
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
    this.#onOutput = ports.onOutput
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
        this.#db.append({ ...run.event, taskRunId, type: 'agent.finished', payload: { status: 'interrupted', reason: 'process_interrupted' } })
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

  #register(task: TaskSnapshot, session: ExecutionSession, event: EventDraft, agentKey: string, role: AgentRecord['role']): EventDraft {
    const recorded = { ...event, sessionId: session.ref.id }
    this.#db.transaction(() => {
      const agent: AgentRecord = { schemaVersion: 1, id: event.agentId!, taskId: task.id, role, session: session.ref, route: session.route }
      const run: AgentRun = { schemaVersion: 1, event: recorded, status: 'active' }
      this.#db.put('agents', agentKey, agent)
      if (role === 'root') this.#db.put('task-sessions', task.id, session.ref)
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
      taskId: task.id, taskRunId: task.taskRunId, taskNodeId: node.id,
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
      const tools = workspace.tools('worker').map((tool) =>
        this.#wrap(tool, () => event, signal, () => this.#capabilities.authorize('worker', tool.effect), evidence, artifacts))
      session = await this.#execution.open({
        cwd: workspace.root, role: 'worker', sessionDirectory: join(this.#sessions, task.id), route,
        tools,
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
        const target = task.check ? workspaceTarget(task.check) : undefined
        const outcome = await session.run(this.#context.worker({
          taskId: task.id, nodeId: node.id, goal: node.goal,
          constraints: ['Read-only workspace access.', 'Return only evidence relevant to this goal.'],
          sourceMessageIds: [], artifactRefs: target ? [target] : [],
          availableTools: tools.map((tool) => tool.name), maxModelRequests: WORKER_MODEL_REQUESTS,
        }))
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
    const agentKey = task.conversationId ?? task.id
    const saved = this.#db.get<AgentRecord>('agents', agentKey)
    let event: EventDraft = {
      taskId: task.id, taskRunId: task.taskRunId, taskAttemptId: task.attemptId, taskNodeId: task.rootNodeId,
      agentId: saved?.id ?? randomUUID(), agentRunId: randomUUID(), type: '', payload: {},
    }
    let session: ExecutionSession | undefined
    let unwatch: (() => Promise<void>) | undefined
    let registered = false
    let workerActive = false
    let workspaceActive = false
    let checkpointFailed = false
    let outputFailed = false
    let textProduced = false
    let streamed = false
    let requests = 0
    const seenSteers = new Set<string>()
    const queuedSteers = new Set<string>()
    let prompted = new Set<string>()
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
    const allowTool = (tool: WorkspaceTool) => this.#capabilities.authorize('root', tool.effect) &&
      (tool.effect === 'read' || Boolean(task.check))
    const tools = workspace.tools('root').filter(allowTool).map((tool) => {
      const wrapped = this.#wrap(tool, () => event, signal, () =>
        !workerActive && !hasUnknownWrite() && allowTool(tool))
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
      cwd: workspace.root, role: 'root', sessionDirectory: join(this.#sessions, agentKey), session: ref, route, tools,
      systemPrompt: task.check
        ? 'You are a local coding agent. Use the listed tools for scoped text changes. A deterministic file check decides acceptance. Do not request credentials.'
        : 'You are a local assistant. Workspace access is read-only. Respond directly to the user and do not request credentials.',
      onEvent: (runtime) => {
        if (runtime.type === 'model.request_started' && ++requests > ROOT_MODEL_REQUESTS) budget.abort()
        if (runtime.type === 'instruction.applied') seenSteers.add(runtime.instructionId)
        if (runtime.type === 'message.delta' && runtime.delta) {
          streamed = true
          textProduced ||= Boolean(runtime.delta.trim())
        }
        try {
          this.#emit(event, runtime, 'root')
        } catch {
          outputFailed = true
          budget.abort()
        }
      },
    })
    const closeSession = async () => {
      if (!session) return
      const current = session
      session = undefined
      try {
        await unwatch?.()
        await current.checkpoint()
        this.#tasks.markDelivered(task.id, [...seenSteers])
        seenSteers.clear()
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
      if (saved && initialRoute && !this.#scheduler.canSwitch(saved.route, initialRoute)) return { status: 'model_error' }
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
        let nextPrompt = saved?.taskId === task.id
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
              const agent = this.#db.get<AgentRecord>('agents', agentKey)!
              this.#db.put('agents', agentKey, { ...agent, route: applied })
              this.#db.append({ ...event, type: 'model.route_changed', payload: { route: applied } })
            })
          }
          const workerResult = current.worker?.status === 'ready' ? await runWorker(current.worker) : undefined
          if (signal.aborted) break
          if (workerResult) nextPrompt += '\nWorker result:\n' + JSON.stringify(workerResult)
          const instructions = this.#tasks.get(task.id).instructions.filter((item) => !item.delivered)
          prompted = new Set(instructions.map(({ id }) => id))
          const prompt = [nextPrompt, ...instructions.map(({ text }) => 'Additional user instruction: ' + text)].join('\n\n')
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
          } catch (error) {
            checkpointFailed = true
            throw error
          }
          this.#tasks.markDelivered(task.id, [...prompted, ...seenSteers])
          seenSteers.clear()
          queuedSteers.clear()
          const after = this.#tasks.get(task.id)
          const more = after.instructions.some((item) => !item.delivered) || after.worker?.status === 'ready' ||
            (after.route && !sameRoute(after.route, session.route))
          if (!more || hasUnknownWrite()) {
            outcome = { status: 'completed', route: session.route, textProduced }
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
        release()
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
