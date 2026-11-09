import type {
  ArchiveConversationInput, ConversationAction, ConversationEvent, ConversationHistory, ConversationRef, ConversationSummary, ConversationTurn,
  CreateConversationInput, CursorInput, DesktopHostApi, HistoryInput, RenameConversationInput, SendMessageInput, SteerInput,
} from '../../../../host/src/contracts/desktop.ts'
import { MockAgentAdapter } from './MockAgentAdapter'
import { demoSessions, newTitle } from '../../features/sessions/model'

export class MockDesktopHost implements DesktopHostApi {
  readonly #mock = new MockAgentAdapter()
  readonly #sessions = new Map<string, ConversationSummary>()
  readonly #turns = new Map<string, ConversationTurn[]>()
  readonly #events = new Map<string, ConversationEvent[]>()
  readonly #listeners = new Set<(event: ConversationEvent) => void>()
  readonly #watched = new Set<string>()

  constructor() {
    for (const session of demoSessions()) {
      const summary: ConversationSummary = {
        id: session.id, title: session.title, createdAt: session.updatedAt, updatedAt: session.updatedAt,
        archived: false, workspace: '',
      }
      this.#sessions.set(summary.id, summary)
      this.#turns.set(summary.id, session.turns.map((turn) => ({
        ...this.#newTurn(turn.id, turn.prompt), status: 'succeeded',
        assistant: { id: crypto.randomUUID(), role: 'assistant', text: turn.response, createdAt: session.updatedAt },
        tools: turn.tools.map(({ id, name }) => ({ id, name, status: 'succeeded' })),
      })))
    }
    this.#mock.subscribe((event) => {
      const turn = this.#turns.get(event.sessionId)?.find(({ taskId }) => taskId === event.runId)
      if (!turn) return
      if (event.type === 'message.delta') {
        turn.assistant.text += event.delta
        this.#emit(event.sessionId, 'message.delta', { messageId: turn.assistant.id, delta: event.delta }, turn.taskId)
      } else if (event.type === 'tool.updated') {
        const { id, name, status } = event.tool
        const update: ConversationTurn['tools'][number] = {
          id, name, status: status === 'running' ? 'running' : status === 'completed' ? 'succeeded'
            : status === 'cancelled' ? 'interrupted' : 'failed',
        }
        turn.tools = [...turn.tools.filter((item) => item.id !== id), update]
        this.#emit(event.sessionId, 'tool.updated', { tool: update }, turn.taskId)
      } else {
        turn.status = event.status === 'completed' ? 'succeeded' : event.status === 'cancelled' ? 'stopped' : 'failed'
        const conversation = this.#get(event.sessionId)
        conversation.latestStatus = turn.status
        this.#emit(event.sessionId, 'task.updated', { turn, conversation }, turn.taskId)
      }
    })
  }

  #get(id: string): ConversationSummary {
    const conversation = this.#sessions.get(id)
    if (!conversation) throw new Error('会话不存在。')
    return conversation
  }

  #newTurn(taskId: string, text: string): ConversationTurn {
    const now = Date.now()
    return {
      taskId, taskRunId: crypto.randomUUID(), status: 'running',
      user: { id: crypto.randomUUID(), role: 'user', text, createdAt: now },
      assistant: { id: crypto.randomUUID(), role: 'assistant', text: '', createdAt: now },
      instructions: [], tools: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }
  }

  #emit(id: string, type: string, payload: ConversationEvent['payload'], taskId?: string) {
    const events = this.#events.get(id) ?? []
    const event: ConversationEvent = {
      schemaVersion: 1, eventId: crypto.randomUUID(), seq: events.length + 1, timestamp: Date.now(),
      conversationId: id, type, taskId, payload: structuredClone(payload),
    }
    events.push(event)
    this.#events.set(id, events)
    if (this.#watched.has(id)) for (const listener of this.#listeners) listener(event)
  }

  async getStatus() { return { state: 'ready', mode: 'fake' } as const }
  async restart() { return this.getStatus() }
  async chooseWorkspace() { return null }
  onStatus() { return () => {} }

  async createConversation(input: CreateConversationInput) {
    const now = Date.now()
    const summary: ConversationSummary = {
      id: crypto.randomUUID(), title: input.title ?? newTitle, createdAt: now, updatedAt: now,
      archived: false, workspace: '',
    }
    this.#sessions.set(summary.id, summary)
    this.#turns.set(summary.id, [])
    return { ...summary }
  }

  async listConversations() { return [...this.#sessions.values()].filter(({ archived }) => !archived).map((value) => ({ ...value })) }
  async getConversation(input: ConversationRef) { return { ...this.#get(input.conversationId) } }

  async getHistory({ conversationId }: HistoryInput): Promise<ConversationHistory> {
    return {
      conversation: await this.getConversation({ conversationId }),
      turns: structuredClone(this.#turns.get(conversationId) ?? []),
      cursor: this.#events.get(conversationId)?.length ?? 0,
    }
  }

  async sendMessage({ conversationId, text }: SendMessageInput) {
    const conversation = this.#get(conversationId)
    const turn = this.#newTurn(crypto.randomUUID(), text)
    if (conversation.title === newTitle) conversation.title = [...text.replace(/\s+/g, ' ')].slice(0, 26).join('')
    conversation.updatedAt = Date.now()
    conversation.latestTaskId = turn.taskId
    conversation.latestStatus = 'running'
    this.#turns.get(conversationId)?.push(turn)
    this.#emit(conversationId, 'task.created', { turn, conversation }, turn.taskId)
    await this.#mock.send({ sessionId: conversationId, runId: turn.taskId, messages: [{ role: 'user', text }] })
    return { taskId: turn.taskId, taskRunId: turn.taskRunId }
  }

  async stopConversation(input: ConversationAction) {
    await this.#mock.cancel({ sessionId: input.conversationId, runId: input.taskId })
    return { accepted: true, status: 'stopped' } as const
  }

  async steerConversation(_input: SteerInput): Promise<{ accepted: true }> {
    throw new Error('界面演示暂不接收运行中说明。')
  }

  async resumeConversation(_input: ConversationAction) {
    return { accepted: false, status: 'stopped' } as const
  }

  async renameConversation(input: RenameConversationInput) {
    const summary = this.#get(input.conversationId)
    summary.title = input.title
    this.#emit(summary.id, 'conversation.updated', { conversation: summary })
    return { ...summary }
  }

  async archiveConversation(input: ArchiveConversationInput) {
    const summary = this.#get(input.conversationId)
    if (summary.latestStatus === 'running') throw new Error('请先结束正在运行的任务。')
    summary.archived = true
    this.#emit(summary.id, 'conversation.archived', { conversation: summary })
    return { ...summary }
  }

  async watchConversation({ conversationId, after }: CursorInput) {
    this.#watched.add(conversationId)
    for (const event of this.#events.get(conversationId) ?? []) {
      if (event.seq > after) for (const listener of this.#listeners) listener(event)
    }
    return true as const
  }

  async unwatchConversation({ conversationId }: ConversationRef) {
    this.#watched.delete(conversationId)
    return true as const
  }

  onEvent(listener: (event: ConversationEvent) => void) {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }
}
