import type {
  ConversationEvent, ConversationHistory, DesktopHostApi,
} from '../../../../shared/contracts/desktop.ts'

interface WatchSink {
  history(history: ConversationHistory): void
  event(event: ConversationEvent): void
  error(error: unknown): void
}

interface Watch {
  sink: WatchSink
  cursor: number
  loading: boolean
  buffered: ConversationEvent[]
}

export class HostAgentAdapter {
  readonly commands: Omit<DesktopHostApi, 'onEvent' | 'watchConversation' | 'unwatchConversation'>
  readonly #api: DesktopHostApi
  readonly #watches = new Map<string, Watch>()
  readonly #disconnect: () => void

  constructor(api: DesktopHostApi) {
    this.commands = api
    this.#api = api
    this.#disconnect = api.onEvent((event) => this.#receive(event))
  }

  watch(conversationId: string, sink: WatchSink, from = 0): () => void {
    const watch: Watch = { sink, cursor: from, loading: true, buffered: [] }
    this.#watches.set(conversationId, watch)
    void this.#restore(conversationId, watch)
    return () => {
      if (this.#watches.get(conversationId) !== watch) return
      this.#watches.delete(conversationId)
      void this.#api.unwatchConversation({ conversationId }).catch(() => {})
    }
  }

  dispose(): void {
    this.#disconnect()
    for (const conversationId of this.#watches.keys()) {
      void this.#api.unwatchConversation({ conversationId }).catch(() => {})
    }
    this.#watches.clear()
  }

  #receive(event: ConversationEvent): void {
    if (event.schemaVersion !== 1) return
    const watch = this.#watches.get(event.conversationId)
    if (!watch || event.seq <= watch.cursor) return
    if (watch.loading) {
      watch.buffered.push(event)
      return
    }
    if (event.seq !== watch.cursor + 1) {
      watch.loading = true
      watch.buffered = [event]
      void this.#restore(event.conversationId, watch, event.seq)
      return
    }
    try {
      watch.sink.event(event)
      watch.cursor = event.seq
    } catch (error) {
      watch.sink.error(error)
    }
  }

  async #restore(conversationId: string, watch: Watch, minCursor = watch.cursor): Promise<void> {
    try {
      const history = await this.#api.getHistory({ conversationId })
      if (this.#watches.get(conversationId) !== watch) return
      if (history.conversation.id !== conversationId || history.cursor < minCursor) {
        throw new Error('Host 返回了与当前会话不一致的历史快照。')
      }
      watch.cursor = history.cursor
      watch.sink.history(history)
      await this.#api.watchConversation({ conversationId, after: history.cursor })
      if (this.#watches.get(conversationId) !== watch) return
      watch.loading = false
      const buffered = watch.buffered.sort((a, b) => a.seq - b.seq)
      watch.buffered = []
      for (const event of buffered) this.#receive(event)
    } catch (error) {
      if (this.#watches.get(conversationId) === watch) {
        this.#watches.delete(conversationId)
        void this.#api.unwatchConversation({ conversationId }).catch(() => {})
        watch.sink.error(error)
      }
    }
  }
}
