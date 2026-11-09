import { create } from 'zustand'
import type {
  CreateConversationInput, DesktopHostStatus, SendMessageInput, SteerInput,
} from '../../../host/src/contracts/desktop.ts'
import { HostAgentAdapter } from '../integrations/agent/HostAgentAdapter'
import { MockDesktopHost } from '../integrations/agent/MockDesktopHost'
import { applyHistory, applyHostEvent, isBusy, toSession, toTurn } from '../integrations/agent/conversationProjection'
import type { Session } from '../features/sessions/model'
import type { GlassStrength, Theme } from '../features/appearance/preferences'

interface Preferences {
  activeId: string | null
  theme: Theme
  strength: GlassStrength
  sidebar: boolean
  drafts: Record<string, string>
}

type NewConversation = Omit<CreateConversationInput, 'requestId'>

interface Workspace extends Preferences {
  sessions: Session[]
  host: DesktopHostStatus
  mock: boolean
  pending: boolean
  error?: string
  initialize(): () => void
  restart(): Promise<void>
  chooseWorkspace(): Promise<string | null>
  createSession(input?: NewConversation): Promise<boolean>
  selectSession(id: string): void
  renameSession(id: string, title: string): Promise<boolean>
  deleteSession(id: string): Promise<boolean>
  loadOlder(): Promise<boolean>
  setTheme(theme: Theme): void
  setStrength(strength: GlassStrength): void
  toggleSidebar(): void
  setDraft(id: string | null, text: string): void
  send(): Promise<void>
  cancel(): Promise<void>
  resume(): Promise<void>
}

const storageKey = 'zlo-agent.desktop.preferences.v1'
const legacyPreferences = 'zlo-agent.workspace.v1'
const draftKey = (id: string | null) => id ?? 'welcome'

function load(storage?: Storage): Preferences {
  const defaults: Preferences = { activeId: null, theme: 'light', strength: 'balanced', sidebar: true, drafts: {} }
  try {
    const saved: Partial<Preferences> | null = JSON.parse(storage?.getItem(storageKey) ?? storage?.getItem(legacyPreferences) ?? 'null')
    if (!saved) return defaults
    return {
      activeId: typeof saved.activeId === 'string' ? saved.activeId : null,
      theme: saved.theme === 'dark' ? 'dark' : 'light',
      strength: saved.strength === 'soft' || saved.strength === 'vivid' ? saved.strength : 'balanced',
      sidebar: saved.sidebar !== false,
      drafts: Object.fromEntries(Object.entries(saved.drafts ?? {}).filter(([, value]) => typeof value === 'string')),
    }
  } catch {
    return defaults
  }
}

const unavailable: DesktopHostStatus = { state: 'offline', mode: 'pi', message: '桌面 Host 接口不可用，请从 Electron 启动。' }

function rejected(error: unknown): boolean {
  return error instanceof Error && /\[(INVALID_INPUT|NOT_FOUND|CONFLICT|MODEL_UNAVAILABLE)\]/.test(error.message)
}

function createWorkspace(adapter: HostAgentAdapter | undefined, mock: boolean, storage?: Storage) {
  const preferences = load(storage)
  return create<Workspace>((set, get) => {
    const commands = adapter?.commands
    const watchers = new Map<string, () => void>()
    let connection = 0
    let pendingMessage: SendMessageInput | SteerInput | undefined
    let pendingCreate: { signature: string; requestId: string } | undefined

    function persist() {
      const { activeId, theme, strength, sidebar, drafts } = get()
      try {
        storage?.setItem(storageKey, JSON.stringify({ activeId, theme, strength, sidebar, drafts }))
      } catch {
        // Storage is optional for UI preferences.
      }
    }

    function issue(error: unknown) {
      set({ error: error instanceof Error ? error.message : '桌面 Host 请求失败。' })
    }

    function updateSession(id: string, update: (session: Session) => Session) {
      set(({ sessions }) => ({
        sessions: sessions.map((session) => session.id === id ? update(session) : session),
      }))
    }

    function clearWatches() {
      for (const close of watchers.values()) close()
      watchers.clear()
    }

    function remove(id: string) {
      watchers.get(id)?.()
      watchers.delete(id)
      const state = get()
      const drafts = { ...state.drafts }
      delete drafts[id]
      set({ sessions: state.sessions.filter((item) => item.id !== id), drafts, activeId: state.activeId === id ? null : state.activeId })
      persist()
    }

    function watch(id: string) {
      if (!adapter || watchers.has(id)) return
      const close = adapter.watch(id, {
        history: (history) => updateSession(id, (previous) => applyHistory(history, previous)),
        event: (event) => {
          if (event.payload.conversation?.archived) remove(id)
          else updateSession(id, (session) => applyHostEvent(session, event))
        },
        error: (error) => {
          watchers.delete(id)
          updateSession(id, (session) => ({ ...session, loaded: false }))
          if (id === get().activeId) issue(error)
        },
      })
      watchers.set(id, close)
    }

    async function applyConnection(status: DesktopHostStatus) {
      const old = get().host
      if (old.state === status.state && old.mode === status.mode && old.state === 'ready') return
      const generation = ++connection
      clearWatches()
      const host: DesktopHostStatus = status.state === 'ready' ? { ...status, state: 'starting' } : status
      set(({ sessions }) => ({ host, sessions: sessions.map((session) => ({ ...session, loaded: false })) }))
      if (!commands || status.state !== 'ready') return
      try {
        const summaries = await commands.listConversations()
        if (generation !== connection) return
        const state = get()
        const sessions = summaries.filter((summary) => !summary.archived)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((summary) => toSession(summary))
        const activeId = sessions.some((session) => session.id === state.activeId) ? state.activeId : (sessions[0]?.id ?? null)
        set({ sessions, activeId, host: status, error: undefined })
        persist()
        if (activeId) watch(activeId)
        for (const session of sessions) {
          if (isBusy(session.latestStatus)) watch(session.id)
        }
      } catch (error) {
        if (generation === connection) {
          set({ host: { state: 'offline', mode: status.mode } })
          issue(error)
        }
      }
    }

    async function createConversation(input: NewConversation): Promise<string> {
      if (!commands) throw new Error('桌面 Host 接口不可用。')
      const signature = JSON.stringify(input)
      if (pendingCreate?.signature !== signature) pendingCreate = { signature, requestId: crypto.randomUUID() }
      const conversation = await commands.createConversation({ requestId: pendingCreate.requestId, ...input })
      pendingCreate = undefined
      set(({ sessions }) => ({
        activeId: conversation.id,
        sessions: [toSession(conversation, sessions.find((session) => session.id === conversation.id)),
          ...sessions.filter((session) => session.id !== conversation.id)],
      }))
      persist()
      watch(conversation.id)
      return conversation.id
    }

    async function mutate(action: () => Promise<void>): Promise<boolean> {
      if (!commands || get().host.state !== 'ready' || get().pending) return false
      set({ pending: true, error: undefined })
      try {
        await action()
        return true
      } catch (error) {
        issue(error)
        return false
      } finally {
        set({ pending: false })
      }
    }

    async function control(action: 'stopConversation' | 'resumeConversation') {
      const session = activeSession(get())
      const turn = session?.turns.at(-1)
      if (!session || !turn || !commands) return
      await mutate(async () => {
        const result = await commands[action]({
          conversationId: session.id, taskId: turn.id, requestId: crypto.randomUUID(),
        })
        if (!result.accepted) throw new Error('该任务的状态已变化，请查看最新记录。')
      })
    }

    return {
      ...preferences, sessions: [], mock, pending: false,
      host: commands ? { state: 'starting', mode: mock ? 'fake' : 'pi' } : unavailable,
      initialize() {
        if (!commands) return () => {}
        let received = false
        let disposed = false
        const unsubscribe = commands.onStatus((status) => {
          received = true
          void applyConnection(status)
        })
        void commands.getStatus().then((status) => {
          if (!received && !disposed) return applyConnection(status)
        }).catch((error) => {
          if (!disposed && !received) void applyConnection({ ...unavailable, message: error instanceof Error ? error.message : unavailable.message })
        })
        return () => {
          disposed = true
          ++connection
          unsubscribe()
          clearWatches()
          set({ host: { state: 'starting', mode: get().host.mode } })
        }
      },
      async restart() {
        if (!commands || get().host.state === 'starting') return
        try {
          await applyConnection({ state: 'starting', mode: get().host.mode })
          await applyConnection(await commands.restart())
        } catch (error) {
          await applyConnection({ state: 'offline', mode: get().host.mode, message: error instanceof Error ? error.message : 'Host 无法重启。' })
        }
      },
      async chooseWorkspace() {
        try {
          return await commands?.chooseWorkspace() ?? null
        } catch (error) {
          issue(error)
          return null
        }
      },
      createSession(input = {}) { return mutate(async () => { await createConversation(input) }) },
      selectSession(id) {
        if (!get().sessions.some((session) => session.id === id)) return
        set({ activeId: id, error: undefined })
        persist()
        if (get().host.state === 'ready') watch(id)
      },
      renameSession(id, title) {
        return mutate(async () => {
          const summary = await commands!.renameConversation({ conversationId: id, requestId: crypto.randomUUID(), title })
          updateSession(id, (session) => ({ ...session, title: summary.title }))
        })
      },
      deleteSession(id) {
        return mutate(async () => {
          await commands!.archiveConversation({ conversationId: id, requestId: crypto.randomUUID() })
          remove(id)
        })
      },
      async loadOlder() {
        const session = activeSession(get())
        if (!commands || !session?.nextBefore) return false
        return mutate(async () => {
          const history = await commands.getHistory({ conversationId: session.id, before: session.nextBefore })
          updateSession(session.id, (current) => {
            const seen = new Set(current.turns.map(({ id }) => id))
            const older = history.turns.map(toTurn).filter(({ id }) => !seen.has(id))
            return { ...current, turns: [...older, ...current.turns], nextBefore: history.nextBefore }
          })
        })
      },
      setTheme(theme) { set({ theme }); persist() },
      setStrength(strength) { set({ strength }); persist() },
      toggleSidebar() { set(({ sidebar }) => ({ sidebar: !sidebar })); persist() },
      setDraft(id, text) { set(({ drafts }) => ({ drafts: { ...drafts, [draftKey(id)]: text } })); persist() },
      async send() {
        const state = get()
        const text = activeDraft(state).trim()
        const session = activeSession(state)
        if (!commands || !text || (session && !session.loaded)) return
        const current = session?.turns.at(-1)
        if (current && (current.status === 'stopping' || current.status === 'reconciliation')) return
        await mutate(async () => {
          const conversationId = session?.id ?? await createConversation({})
          const draft = draftKey(state.activeId)
          if (!session && draft !== conversationId && get().drafts[draft] !== undefined) {
            const drafts = { ...get().drafts, [conversationId]: get().drafts[draft] }
            delete drafts[draft]
            set({ drafts })
            persist()
          }
          if (pendingMessage?.conversationId !== conversationId || pendingMessage.text !== text) {
            const request = { conversationId, requestId: crypto.randomUUID(), text }
            pendingMessage = current && isBusy(current.status) ? { ...request, taskId: current.id } : request
          }
          const request = pendingMessage
          try {
            if ('taskId' in request) await commands.steerConversation(request)
            else await commands.sendMessage(request)
          } catch (error) {
            if (rejected(error)) pendingMessage = undefined
            throw error
          }
          pendingMessage = undefined
          const key = draftKey(conversationId)
          const input = get().drafts[key]
          if (input?.trim() === text) get().setDraft(conversationId, '')
        })
      },
      cancel: () => control('stopConversation'),
      resume: () => control('resumeConversation'),
    }
  })
}

const mockMode = import.meta.env.DEV && import.meta.env.VITE_ZLO_AGENT_MODE === 'mock'
const api = mockMode ? new MockDesktopHost() : window.agentHost
const adapter = api ? new HostAgentAdapter(api) : undefined
if (import.meta.hot) import.meta.hot.dispose(() => adapter?.dispose())
export const useWorkspace = createWorkspace(adapter, mockMode, window.localStorage)
export const activeSession = (state: Workspace) => state.sessions.find(({ id }) => id === state.activeId)
export const activeDraft = (state: Workspace) => state.drafts[draftKey(state.activeId)] ?? ''
