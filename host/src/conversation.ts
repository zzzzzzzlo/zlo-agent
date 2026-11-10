import { randomUUID } from 'node:crypto'
import type {
  ArchiveConversationInput, ConversationAction, ConversationEvent, ConversationHistory, ConversationMessage,
  ConversationSummary, ConversationTool, ConversationTurn, CreateConversationInput, DesktopErrorCode,
  HistoryInput, RenameConversationInput, SendMessageInput, SendMessageResult, SteerInput, UsageTotals,
} from '../../shared/contracts/desktop.ts'
import type { AgentEvent, EndReason, EventDraft, ModelRoute, TaskStatus } from './contracts/domain.ts'
import type { LocalStore } from './store.ts'
import type { TaskSnapshot } from './task-engine.ts'
import { workspaceTarget } from './workspace.ts'

const conversations = 'conversations'
const taskBindings = 'conversation-task-bindings'
const requests = 'conversation-requests'
const historyPageSize = 50
const deltaBatchMs = 25
const deltaBatchBytes = 16 * 1024
const assistantCheckpoints = 'conversation-assistant-checkpoints'
const live = new Set<TaskStatus>(['ready', 'running', 'verifying', 'stop_requested', 'stopping'])
const transitions = new Set(['task.created', 'task.state_changed', 'task.stop_requested', 'task.stopped', 'task.resumed'])

interface StoredConversation extends ConversationSummary {
  turnCount: number
}

interface TurnBinding {
  conversationId: string
  ordinal: number
}

interface AssistantCheckpoint {
  text: string
  through: number
}

interface PendingDelta {
  source: EventDraft
  binding: TurnBinding
  messageId: string
  chunks: string[]
  bytes: number
  timer: NodeJS.Timeout
  flushing: boolean
}

export class ConversationError extends Error {
  readonly code: DesktopErrorCode

  constructor(code: DesktopErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function text(input: unknown, name: string, max: number): string {
  if (typeof input !== 'string' || !input.trim() || input.length > max || input.includes('\0')) {
    throw new ConversationError('INVALID_INPUT', 'Invalid ' + name)
  }
  return input
}

function object(input: unknown, name: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConversationError('INVALID_INPUT', 'Invalid ' + name)
  }
  return input as Record<string, unknown>
}

export function requestId(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(input)) {
    throw new ConversationError('INVALID_INPUT', 'Invalid request ID')
  }
  return input
}

function entityId(input: unknown): string {
  if (typeof input !== 'string' || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(input)) {
    throw new ConversationError('INVALID_INPUT', 'Invalid entity ID')
  }
  return input
}

export function parseRoute(input: unknown): ModelRoute {
  const route = object(input, 'model route')
  const provider = text(route.provider, 'provider', 80)
  const model = text(route.model, 'model', 200)
  if (!/^[\w-]+$/.test(provider) || !/^[\w.:/-]+$/.test(model)) {
    throw new ConversationError('INVALID_INPUT', 'Invalid model route')
  }
  return { provider, model }
}

export function parseCreateConversation(input: CreateConversationInput): CreateConversationInput {
  const body = object(input, 'conversation')
  const check = body.check === undefined ? undefined : object(body.check, 'file check')
  const workspace = body.workspace === undefined ? undefined : text(body.workspace, 'workspace', 1024)
  if (check && !workspace) throw new ConversationError('INVALID_INPUT', 'A file check requires a selected workspace')
  const target = check && workspaceTarget({ path: check.path })
  if (check && !target) throw new ConversationError('INVALID_INPUT', 'A file check requires an allowed relative path')
  const contains = check?.contains === undefined ? undefined : text(check.contains, 'verification text', 16000)
  return {
    requestId: requestId(body.requestId),
    title: body.title === undefined ? undefined : text(body.title, 'title', 120).trim(),
    workspace,
    route: body.route === undefined ? undefined : parseRoute(body.route),
    check: target ? { path: target, ...(contains !== undefined ? { contains } : {}) } : undefined,
  }
}

export function parseSendMessage(input: SendMessageInput): SendMessageInput {
  const body = object(input, 'message')
  return { conversationId: entityId(body.conversationId), requestId: requestId(body.requestId), text: text(body.text, 'message', 16000) }
}

export function parseConversationAction(input: ConversationAction): ConversationAction {
  const body = object(input, 'conversation action')
  return { conversationId: entityId(body.conversationId), taskId: entityId(body.taskId), requestId: requestId(body.requestId) }
}

export function parseSteer(input: SteerInput): SteerInput {
  return { ...parseConversationAction(input), text: text(input.text, 'instruction', 8000) }
}

function summary(record: StoredConversation): ConversationSummary {
  const { turnCount, ...result } = record
  return result
}

function conversationStream(id: string): string { return 'conversation:' + id }

function turnNamespace(id: string): string { return 'conversation-turns:' + id }

function ordinalKey(ordinal: number): string { return String(ordinal).padStart(16, '0') }

function toDesktopEvent(conversationId: string, event: AgentEvent): ConversationEvent {
  return {
    schemaVersion: 1, eventId: event.id, seq: event.seq, timestamp: Date.parse(event.occurredAt),
    conversationId, taskId: event.taskId || undefined, taskRunId: event.taskRunId, taskAttemptId: event.taskAttemptId,
    taskNodeId: event.taskNodeId, agentRunId: event.agentRunId, parentAgentRunId: event.parentAgentRunId,
    sessionId: event.sessionId, type: event.type, payload: event.payload,
  }
}

function message(role: ConversationMessage['role'], value: string, time: number): ConversationMessage {
  return { id: randomUUID(), role, text: value, createdAt: time }
}

function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

function accumulate(previous: UsageTotals, payload: EventDraft['payload']): UsageTotals {
  return {
    input: previous.input + tokens(payload.input), output: previous.output + tokens(payload.output),
    cacheRead: previous.cacheRead + tokens(payload.cacheRead), cacheWrite: previous.cacheWrite + tokens(payload.cacheWrite),
  }
}

/** Owns conversation records and an ordered read projection of TaskEngine and runtime events. */
export class ConversationService {
  readonly #store: LocalStore
  readonly #pending = new Map<string, PendingDelta>()
  readonly #onPersistenceFailure: () => void

  constructor(store: LocalStore, onPersistenceFailure: () => void = () => {}) {
    this.#store = store
    this.#onPersistenceFailure = onPersistenceFailure
    store.projectEvents((event) => this.#projectTask(event))
  }

  #record(id: string): StoredConversation {
    const record = this.#store.get<StoredConversation>(conversations, entityId(id))
    if (!record) throw new ConversationError('NOT_FOUND', 'Conversation does not exist')
    return record
  }

  #saveConversation(record: StoredConversation): void {
    this.#store.put(conversations, record.id, record)
  }

  #saveTurn(binding: TurnBinding, turn: ConversationTurn): void {
    this.#store.put(turnNamespace(binding.conversationId), ordinalKey(binding.ordinal), turn)
  }

  #turn(binding: TurnBinding): ConversationTurn {
    const turn = this.#store.get<ConversationTurn>(turnNamespace(binding.conversationId), ordinalKey(binding.ordinal))
    if (!turn) throw new Error('Conversation history projection is missing')
    return turn
  }

  #readAssistant(conversationId: string, turn: ConversationTurn): AssistantCheckpoint | undefined {
    const checkpoint = this.#store.get<AssistantCheckpoint>(assistantCheckpoints, turn.taskId)
    if (!checkpoint || !live.has(turn.status)) return checkpoint
    const deltas = this.#store.messageDeltas(conversationStream(conversationId), turn.assistant.id, checkpoint.through)
    return deltas.length
      ? { text: checkpoint.text + deltas.map(({ delta }) => delta).join(''), through: deltas.at(-1)!.seq }
      : checkpoint
  }

  #displayTurn(conversationId: string, turn: ConversationTurn): ConversationTurn {
    const assistant = this.#readAssistant(conversationId, turn)
    return assistant ? { ...turn, assistant: { ...turn.assistant, text: assistant.text } } : turn
  }

  #compactAssistant(conversationId: string, turn: ConversationTurn): void {
    const previous = this.#store.get<AssistantCheckpoint>(assistantCheckpoints, turn.taskId)
    if (!previous) return
    const latest = this.#readAssistant(conversationId, turn)!
    if (latest.through > previous.through) this.#store.put(assistantCheckpoints, turn.taskId, latest)
  }

  #event(id: string, type: string, payload: ConversationEvent['payload'], source?: Partial<EventDraft>): void {
    this.#store.append({ ...source, taskId: source?.taskId ?? '', type, payload }, conversationStream(id))
  }

  #receipt<T>(id: string, signature: string): T | undefined {
    const receipt = this.#store.get<{ signature: string; value: T }>(requests, requestId(id))
    if (!receipt) return undefined
    if (receipt.signature !== signature) throw new ConversationError('CONFLICT', 'Request ID already used for another command')
    return receipt.value
  }

  #command<T>(id: string, signature: string, execute: () => T): T {
    return this.#store.transaction(() => {
      const previous = this.#receipt<T>(id, signature)
      if (previous !== undefined) return previous
      const result = execute()
      this.#store.put(requests, id, { signature, value: result })
      return result
    })
  }

  #createSignature(input: CreateConversationInput): string {
    return JSON.stringify(['create', input.title, input.workspace, input.route, input.check])
  }

  created(input: CreateConversationInput): ConversationSummary | undefined {
    return this.#receipt(input.requestId, this.#createSignature(input))
  }

  create(input: CreateConversationInput, workspace: string, defaultRoute?: ModelRoute): ConversationSummary {
    return this.#command(input.requestId, this.#createSignature(input), () => {
      const now = Date.now()
      const route = input.route ?? defaultRoute
      const conversation: StoredConversation = {
        id: randomUUID(), title: input.title ?? '新会话', createdAt: now, updatedAt: now, archived: false,
        workspace, ...(route ? { route } : {}), ...(input.check ? { check: input.check } : {}), turnCount: 0,
      }
      this.#saveConversation(conversation)
      const result = summary(conversation)
      this.#event(conversation.id, 'conversation.created', { conversation: result })
      return result
    })
  }

  list(): ConversationSummary[] {
    return this.#store.list<StoredConversation>(conversations).filter(({ archived }) => !archived)
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id)).map(summary)
  }

  get(id: string): ConversationSummary { return summary(this.#record(id)) }

  history({ conversationId, before }: HistoryInput): ConversationHistory {
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) {
      throw new ConversationError('INVALID_INPUT', 'Invalid history cursor')
    }
    const conversation = this.#record(conversationId)
    const rows = this.#store.listBefore<ConversationTurn>(
      turnNamespace(conversationId), before === undefined ? null : ordinalKey(before), historyPageSize + 1,
    )
    const turns = rows.slice(0, historyPageSize).reverse().map((turn) => this.#displayTurn(conversationId, turn))
    const newest = Math.min(conversation.turnCount, before === undefined ? conversation.turnCount : before - 1)
    return {
      conversation: summary(conversation), turns, cursor: this.#store.eventCursor(conversationStream(conversationId)),
      nextBefore: rows.length > historyPageSize ? newest - historyPageSize + 1 : undefined,
    }
  }

  subscribe(conversationId: string, after: number, sink: (event: ConversationEvent) => void | Promise<void>): () => void {
    this.#record(conversationId)
    if (!Number.isSafeInteger(after) || after < 0) throw new ConversationError('INVALID_INPUT', 'Invalid event cursor')
    return this.#store.subscribe(conversationStream(conversationId), after, (event) => sink(toDesktopEvent(conversationId, event)))
  }

  rename(input: RenameConversationInput): ConversationSummary {
    const id = entityId(input.conversationId)
    const title = text(input.title, 'title', 120).trim()
    return this.#command(input.requestId, JSON.stringify(['rename', id, title]), () => {
      const conversation = this.#record(id)
      if (conversation.archived) throw new ConversationError('CONFLICT', 'Conversation is archived')
      const next = { ...conversation, title, updatedAt: Date.now() }
      this.#saveConversation(next)
      const result = summary(next)
      this.#event(id, 'conversation.updated', { conversation: result })
      return result
    })
  }

  archive(input: ArchiveConversationInput): ConversationSummary {
    const id = entityId(input.conversationId)
    return this.#command(input.requestId, JSON.stringify(['archive', id]), () => {
      const conversation = this.#record(id)
      if (conversation.latestStatus && live.has(conversation.latestStatus)) {
        throw new ConversationError('CONFLICT', 'Stop the active task before archiving this conversation')
      }
      if (conversation.archived) return summary(conversation)
      const next = { ...conversation, archived: true, updatedAt: Date.now() }
      this.#saveConversation(next)
      const result = summary(next)
      this.#event(id, 'conversation.archived', { conversation: result })
      return result
    })
  }

  #sendSignature(input: SendMessageInput): string {
    return JSON.stringify(['send', input.conversationId, input.text])
  }

  sent(input: SendMessageInput): SendMessageResult | undefined {
    return this.#receipt(input.requestId, this.#sendSignature(input))
  }

  canSend(id: string): ConversationSummary {
    const conversation = this.#record(id)
    if (conversation.archived) throw new ConversationError('CONFLICT', 'Conversation is archived')
    if (conversation.latestStatus === 'needs_reconciliation') {
      throw new ConversationError('CONFLICT', 'The previous task requires reconciliation')
    }
    if (conversation.latestStatus && live.has(conversation.latestStatus)) {
      throw new ConversationError('CONFLICT', 'Conversation already has an active task')
    }
    return summary(conversation)
  }

  /** Called from the task creation transaction before task.created becomes visible. */
  attachTask(input: SendMessageInput, task: TaskSnapshot): void {
    this.canSend(input.conversationId)
    if (this.sent(input)) throw new Error('Conversation message already has a task')
    const conversation = this.#record(input.conversationId)
    const time = Date.now()
    const binding = { conversationId: conversation.id, ordinal: conversation.turnCount + 1 }
    const turn: ConversationTurn = {
      taskId: task.id, taskRunId: task.taskRunId, status: task.status,
      user: message('user', input.text, time), assistant: message('assistant', '', time),
      instructions: [], tools: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }
    const next: StoredConversation = {
      ...conversation, turnCount: binding.ordinal, latestTaskId: task.id, latestStatus: task.status, updatedAt: time,
    }
    if (binding.ordinal === 1 && next.title === '新会话') {
      next.title = Array.from(input.text.trim().replace(/\s+/g, ' ')).slice(0, 26).join('')
    }
    this.#saveConversation(next)
    this.#saveTurn(binding, turn)
    this.#store.put(taskBindings, task.id, binding)
    this.#store.put(requests, input.requestId, { signature: this.#sendSignature(input), value: { taskId: task.id, taskRunId: task.taskRunId } })
    this.#event(conversation.id, 'message.created', { conversation: summary(next), turn, messageId: turn.user.id }, {
      taskId: task.id, taskRunId: task.taskRunId, taskNodeId: task.rootNodeId,
    })
  }

  assertTaskOwner({ conversationId, taskId }: ConversationAction): void {
    this.#record(conversationId)
    if (this.#store.get<TurnBinding>(taskBindings, taskId)?.conversationId !== conversationId) {
      throw new ConversationError('NOT_FOUND', 'Task does not belong to this conversation')
    }
  }

  assertCurrentTask(input: ConversationAction): ConversationSummary {
    this.assertTaskOwner(input)
    const conversation = this.#record(input.conversationId)
    if (conversation.archived || conversation.latestTaskId !== input.taskId) {
      throw new ConversationError('CONFLICT', 'Task is no longer current in this conversation')
    }
    return summary(conversation)
  }

  /** Called inside the instruction transaction. */
  attachInstruction(input: SteerInput): void {
    this.assertCurrentTask(input)
    const binding = this.#store.get<TurnBinding>(taskBindings, input.taskId)!
    this.#flushInTransaction(input.taskId)
    const turn = this.#turn(binding)
    const instruction = message('user', input.text, Date.now())
    turn.instructions.push(instruction)
    this.#saveTurn(binding, turn)
    this.#event(input.conversationId, 'message.created', { turn: this.#displayTurn(input.conversationId, turn), messageId: instruction.id }, {
      taskId: input.taskId, taskRunId: turn.taskRunId, taskAttemptId: turn.taskAttemptId,
    })
  }

  recordDelta(source: EventDraft, delta: string): void {
    if (!delta) return
    const taskId = source.taskId
    let pending = this.#pending.get(taskId)
    if (pending && pending.source.agentRunId !== source.agentRunId) {
      this.#store.transaction(() => this.#flushInTransaction(taskId))
      pending = undefined
    }
    if (!pending) {
      const binding = this.#store.get<TurnBinding>(taskBindings, taskId)
      if (!binding) return
      const turn = this.#turn(binding)
      if (!live.has(turn.status)) return
      const timer = setTimeout(() => {
        try {
          this.#store.transaction(() => this.#flushInTransaction(taskId))
        } catch {
          this.#onPersistenceFailure()
        }
      }, deltaBatchMs)
      timer.unref()
      pending = { source, binding, messageId: turn.assistant.id, chunks: [], bytes: 0, timer, flushing: false }
      this.#pending.set(taskId, pending)
    }
    pending.chunks.push(delta)
    pending.bytes += Buffer.byteLength(delta)
    if (pending.bytes >= deltaBatchBytes) this.#store.transaction(() => this.#flushInTransaction(taskId))
  }

  checkpointOutput(taskId: string): void {
    const binding = this.#store.get<TurnBinding>(taskBindings, taskId)
    if (!binding) return
    this.#store.transaction(() => {
      this.#flushInTransaction(taskId)
      this.#compactAssistant(binding.conversationId, this.#turn(binding))
    })
  }

  #flushInTransaction(taskId: string): void {
    const pending = this.#pending.get(taskId)
    if (!pending || pending.flushing) return
    const { binding, messageId, chunks, source, timer } = pending
    pending.flushing = true
    this.#store.onTransactionSettled((committed) => {
      pending.flushing = false
      if (committed) {
        clearTimeout(timer)
        this.#pending.delete(taskId)
      }
    })
    if (!this.#store.get<AssistantCheckpoint>(assistantCheckpoints, taskId)) {
      const turn = this.#turn(binding)
      // Legacy turns already contain all deltas through this point.
      this.#store.put(assistantCheckpoints, taskId, {
        text: turn.assistant.text, through: this.#store.eventCursor(conversationStream(binding.conversationId)),
      } satisfies AssistantCheckpoint)
      if (turn.assistant.text) {
        turn.assistant.text = ''
        this.#saveTurn(binding, turn)
      }
    }
    this.#event(binding.conversationId, 'message.delta', { delta: chunks.join(''), messageId }, source)
  }

  #projectTask(source: AgentEvent): void {
    const binding = this.#store.get<TurnBinding>(taskBindings, source.taskId)
    if (!binding) return
    this.#flushInTransaction(source.taskId)
    const { conversationId } = binding
    const type = source.type
    if (type === 'agent.started' || type === 'agent.finished') {
      this.#projectAgent(conversationId, source)
    } else if (type === 'tool.started' || type === 'tool.finished') {
      this.#projectTool(binding, source)
    } else if (type === 'model.usage') {
      const turn = this.#turn(binding)
      turn.usage = accumulate(turn.usage, source.payload)
      this.#saveTurn(binding, turn)
      this.#event(conversationId, type, { usage: turn.usage }, source)
    } else if (type === 'verification.finished') {
      const turn = this.#turn(binding)
      turn.verification = { passed: source.payload.passed === true, evidence: String(source.payload.evidence) }
      this.#saveTurn(binding, turn)
    } else if (type === 'operation.reconciliation_required') {
      const turn = this.#turn(binding)
      const ids = source.payload.operationIds
      if (Array.isArray(ids)) {
        for (const tool of turn.tools) if (ids.includes(tool.id)) tool.status = 'unknown_effect'
      }
      this.#saveTurn(binding, turn)
    } else if (transitions.has(type)) {
      this.#projectStatus(binding, source)
    } else if (type === 'model.route_changed') {
      const conversation = this.#record(conversationId)
      const next = { ...conversation, route: parseRoute(source.payload.route) }
      this.#saveConversation(next)
      this.#event(conversationId, type, { conversation: summary(next) }, source)
    }
  }

  #projectAgent(conversationId: string, source: AgentEvent): void {
    const status = source.payload.status
    const payload: ConversationEvent['payload'] = {
      agentRole: source.parentAgentRunId ? 'worker' : 'root',
      agentStatus: source.type === 'agent.started' ? 'active'
        : status === 'completed' || status === 'interrupted' || status === 'failed' ? status : undefined,
    }
    if (source.type === 'agent.started' && payload.agentRole === 'root' && source.sessionId) {
      const conversation = this.#record(conversationId)
      const next = { ...conversation, piSessionId: source.sessionId, route: parseRoute(source.payload.route) }
      this.#saveConversation(next)
      payload.conversation = summary(next)
    }
    this.#event(conversationId, source.type, payload, source)
  }

  #projectTool(binding: TurnBinding, source: AgentEvent): void {
    const turn = this.#turn(binding)
    const tool: ConversationTool = {
      id: String(source.payload.id), name: String(source.payload.tool), agentRunId: source.agentRunId,
      status: source.type === 'tool.started' ? 'running' : source.payload.status as ConversationTool['status'],
    }
    const index = turn.tools.findIndex((entry) => entry.id === tool.id)
    if (index < 0) turn.tools.push(tool)
    else turn.tools[index] = tool
    this.#saveTurn(binding, turn)
    this.#event(binding.conversationId, source.type === 'tool.started' ? source.type : 'tool.updated', { tool }, source)
  }

  #projectStatus(binding: TurnBinding, source: AgentEvent): void {
    const conversation = this.#record(binding.conversationId)
    const turn = this.#turn(binding)
    const status = source.payload.status as TaskStatus
    const terminal = !live.has(status)
    if (terminal) this.#compactAssistant(conversation.id, turn)
    turn.status = status
    turn.reason = source.payload.reason as EndReason | undefined
    turn.taskAttemptId = source.taskAttemptId
    if (source.type === 'task.resumed') turn.verification = undefined
    if (terminal) {
      for (const tool of turn.tools) if (tool.status === 'running') tool.status = 'interrupted'
    }
    this.#saveTurn(binding, turn)
    if (conversation.latestTaskId === source.taskId) {
      conversation.latestStatus = status
      conversation.updatedAt = Date.now()
      this.#saveConversation(conversation)
    }
    const displayed = this.#displayTurn(conversation.id, turn)
    const payload = { conversation: summary(conversation), turn: displayed, status, reason: turn.reason }
    this.#event(conversation.id, source.type === 'task.created' ? 'task.created' : 'task.updated', payload, source)
    if (status === 'succeeded' || (status === 'failed' && turn.verification && displayed.assistant.text)) {
      this.#event(conversation.id, 'message.completed', { messageId: turn.assistant.id, status }, source)
    }
    if (terminal) {
      const interrupted = status === 'stopped' || status === 'needs_reconciliation'
      this.#event(conversation.id, interrupted ? 'run.interrupted' : 'run.finished', { status, reason: turn.reason }, source)
    }
  }
}
