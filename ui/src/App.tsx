import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { LiquiThemeProvider } from '@liqui-design/glass'
import { Info } from 'lucide-react'
import { optics } from './features/appearance/preferences'
import { useWorkspace } from './stores/workspace'
import { Glass } from './components/glass/Glass'
import { TitleBar } from './components/layout/TitleBar'
import { ActivityPanel } from './components/layout/ActivityPanel'
import { Sidebar } from './components/sidebar/Sidebar'
import type { SessionAction } from './components/sidebar/Sidebar'
import { SessionDialog } from './components/sidebar/SessionDialog'
import { NewConversationDialog } from './components/sidebar/NewConversationDialog'
import { ChatSurface } from './components/chat/ChatSurface'
import { Composer } from './components/chat/Composer'
import { Settings } from './components/settings/Settings'
import type { SettingsSection } from './components/settings/Settings'

export function App() {
  const theme = useWorkspace((state) => state.theme)
  const strength = useWorkspace((state) => state.strength)
  const sidebar = useWorkspace((state) => state.sidebar)
  const initialize = useWorkspace((state) => state.initialize)
  const hostState = useWorkspace((state) => state.host.state)
  const [activity, setActivity] = useState(false)
  const [settings, setSettings] = useState<SettingsSection>()
  const [sessionAction, setSessionAction] = useState<SessionAction>()
  const [newConversation, setNewConversation] = useState(false)
  const [toast, setToast] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.dataset.glass = strength
  }, [theme, strength])
  const notify = useCallback((message: string) => {
    clearTimeout(timer.current)
    setToast(message)
    timer.current = setTimeout(() => setToast(''), 3300)
  }, [])
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(initialize, [initialize])

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() === 'n' && !settings && !sessionAction && !newConversation && hostState === 'ready') {
        event.preventDefault()
        setNewConversation(true)
      }
      if (event.key === ',' && !sessionAction && !newConversation) {
        event.preventDefault()
        setSettings('appearance')
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [hostState, settings, sessionAction, newConversation])

  return (
    <LiquiThemeProvider injectTokens={false} theme={{ glass: optics[strength] }}>
      <div className="app-shell">
        <div className="window-backdrop" aria-hidden="true" />
        <TitleBar activity={activity} onActivity={() => setActivity((visible) => !visible)} notify={notify} />
        <div className="workspace">
          {sidebar && <Sidebar onCreate={() => setNewConversation(true)} onSettings={() => setSettings('appearance')} onSessionAction={setSessionAction} />}
          <main className="chat-surface" aria-label="对话">
            <ChatSurface />
            <Composer notify={notify} onReconcile={() => setSettings('diagnostics')} />
          </main>
          {activity && <ActivityPanel onClose={() => setActivity(false)} onManage={setSettings} />}
        </div>
        <div className="toast-anchor" role="status">
          {toast && <Glass variant="popover" className="toast" elevated contentClassName="toast-content"><Info size={16} />{toast}</Glass>}
        </div>
        {settings && <Settings initialSection={settings} onClose={() => setSettings(undefined)} />}
        {sessionAction && <SessionDialog action={sessionAction} onClose={() => setSessionAction(undefined)} />}
        {newConversation && <NewConversationDialog onClose={() => setNewConversation(false)} />}
      </div>
    </LiquiThemeProvider>
  )
}
