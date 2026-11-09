import { create } from 'zustand'
import { MockAgentAdapter } from '../integrations/agent/MockAgentAdapter'
import type { AgentAdapter, AgentEvent, AgentMessage } from '../integrations/agent/AgentAdapter'
import { demoSessions, newTitle } from '../features/sessions/model'
import type { Session, Turn } from '../features/sessions/model'
import type { GlassStrength, Theme } from '../features/appearance/preferences'

interface WorkspaceData {
  sessions: Session[]
  activeId: string | null
  theme: Theme
  strength: GlassStrength
  sidebar: boolean
}

interface Workspace extends WorkspaceData {
  drafts: Record<string, string>
  createSession(): void
  selectSession(id: string): void
  renameSession(id: string, title: string): void
  deleteSession(id: string): void
  setTheme(theme: Theme): void
  setStrength(strength: GlassStrength): void
  toggleSidebar(): void
  setDraft(id: string | null, text: string): void
  send(): void
  cancel(): void
}

const storageKey = 'zlo-agent.workspace.v1'

function interrupted(turn: Turn): Turn {
  if (turn.status !== 'running') return turn
  return {
    ...turn, status: 'cancelled',
    tools: turn.tools.map((tool) => tool.status === 'running'
      ? { ...tool, status: 'cancelled', detail: '上次会话已关闭。' }
      : tool),
  }
}

function load(): WorkspaceData {
  const defaults: WorkspaceData = { sessions: demoSessions(), activeId: null, theme: 'light', strength: 'balanced', sidebar: true }
  try {
    const saved: WorkspaceData = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
    if (!saved || !Array.isArray(saved.sessions)) return defaults
    const sessions = saved.sessions.map((session) => ({ ...session, turns: session.turns.map(interrupted) }))
    return {
      sessions,
      activeId: sessions.some(({ id }) => id === saved.activeId) ? saved.activeId : null,
      theme: saved.theme === 'dark' ? 'dark' : 'light',
      strength: saved.strength === 'soft' || saved.strength === 'vivid' ? saved.strength : 'balanced',
      sidebar: saved.sidebar !== false,
    }
  } catch {
    return defaults
  }
}

function newSession(): Session {
  return { id: crypto.randomUUID(), title: newTitle, updatedAt: Date.now(), turns: [] }
}

const draftKey = (id: string | null) => id ?? 'welcome'

function createWorkspace(adapter: AgentAdapter) {
  const store = create<Workspace>((set, get) => {
    function persist() {
      const { sessions, activeId, theme, strength, sidebar } = get()
      try {
        localStorage.setItem(storageKey, JSON.stringify({ sessions, activeId, theme, strength, sidebar }))
      } catch (error) {
        console.warn('Unable to save workspace', error)
      }
    }

    function receive(event: AgentEvent) {
      const { sessions } = get()
      const target = sessions.find((session) => session.id === event.sessionId)
      const turn = target?.turns.find((turn) => turn.id === event.runId)
      if (!target || !turn || turn.status !== 'running') return

      let next: Turn
      switch (event.type) {
        case 'message.delta':
          next = { ...turn, response: turn.response + event.delta }
          break
        case 'tool.updated': {
          const index = turn.tools.findIndex((tool) => tool.id === event.tool.id)
          const tools = [...turn.tools]
          if (index < 0) tools.push(event.tool)
          else tools[index] = event.tool
          next = { ...turn, tools }
          break
        }
        case 'run.ended':
          next = {
            ...turn, status: event.status, error: event.error,
            tools: turn.tools.map((tool) => tool.status === 'running'
              ? { ...tool, status: event.status, detail: event.error ?? tool.detail }
              : tool),
          }
          break
      }
      set({ sessions: sessions.map((session) => session === target
        ? { ...session, turns: session.turns.map((item) => item === turn ? next : item) }
        : session) })
      if (event.type === 'run.ended') persist()
    }

    const unsubscribe = adapter.subscribe(receive)
    if (import.meta.hot) import.meta.hot.dispose(unsubscribe)

    return {
      ...load(),
      drafts: {},
      createSession() {
        const state = get()
        const selected = state.sessions.find(({ id }) => id === state.activeId)
        if (selected && selected.turns.length === 0 && selected.title === newTitle && !state.drafts[selected.id]) return
        const session = newSession()
        set({ sessions: [session, ...state.sessions], activeId: session.id })
        persist()
      },
      selectSession(id) {
        if (!get().sessions.some((session) => session.id === id)) return
        set({ activeId: id })
        persist()
      },
      renameSession(id, title) {
        const name = title.trim().slice(0, 80)
        if (!name) return
        set(({ sessions }) => ({ sessions: sessions.map((session) => session.id === id ? { ...session, title: name } : session) }))
        persist()
      },
      deleteSession(id) {
        const state = get()
        const session = state.sessions.find((item) => item.id === id)
        const running = session?.turns.find(({ status }) => status === 'running')
        const drafts = { ...state.drafts }
        delete drafts[id]
        set({ sessions: state.sessions.filter((item) => item.id !== id), drafts, activeId: state.activeId === id ? null : state.activeId })
        if (running) void adapter.cancel({ sessionId: id, runId: running.id }).catch(console.warn)
        persist()
      },
      setTheme(theme) { set({ theme }); persist() },
      setStrength(strength) { set({ strength }); persist() },
      toggleSidebar() { set(({ sidebar }) => ({ sidebar: !sidebar })); persist() },
      setDraft(id, text) { set(({ drafts }) => ({ drafts: { ...drafts, [draftKey(id)]: text } })) },
      send() {
        const state = get()
        const text = state.drafts[draftKey(state.activeId)]?.trim()
        if (!text) return
        const session = state.sessions.find(({ id }) => id === state.activeId) ?? newSession()
        if (session.turns.some(({ status }) => status === 'running')) return
        const turn: Turn = { id: crypto.randomUUID(), prompt: text, response: '', status: 'running', tools: [] }
        const next = {
          ...session, updatedAt: Date.now(),
          title: session.title === newTitle ? Array.from(text.replace(/\s+/g, ' ')).slice(0, 26).join('') : session.title,
          turns: [...session.turns, turn],
        }
        set({
          activeId: session.id,
          sessions: [next, ...state.sessions.filter(({ id }) => id !== session.id)],
          drafts: { ...state.drafts, [draftKey(state.activeId)]: '' },
        })
        persist()
        const messages: AgentMessage[] = []
        for (const previous of session.turns) {
          messages.push({ role: 'user', text: previous.prompt })
          if (previous.response) messages.push({ role: 'assistant', text: previous.response })
        }
        messages.push({ role: 'user', text })
        const key = { sessionId: session.id, runId: turn.id }
        void adapter.send({ ...key, messages }).catch((error: unknown) =>
          receive({ ...key, type: 'run.ended', status: 'error', error: error instanceof Error ? error.message : '演示运行失败。' }))
      },
      cancel() {
        const { activeId, sessions } = get()
        const running = sessions.find(({ id }) => id === activeId)?.turns.find(({ status }) => status === 'running')
        if (!activeId || !running) return
        const key = { sessionId: activeId, runId: running.id }
        void adapter.cancel(key).catch((error: unknown) =>
          receive({ ...key, type: 'run.ended', status: 'error', error: error instanceof Error ? error.message : '停止运行失败。' }))
      },
    }
  })
  return store
}

export const useWorkspace = createWorkspace(new MockAgentAdapter())
export const activeSession = (state: Workspace) => state.sessions.find(({ id }) => id === state.activeId)
export const activeDraft = (state: Workspace) => state.drafts[draftKey(state.activeId)] ?? ''
