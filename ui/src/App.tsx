import { useEffect, useLayoutEffect, useState } from 'react'
import { LiquiThemeProvider } from '@liqui-design/glass'
import { optics } from './features/appearance/preferences'
import { activeSession, useWorkspace } from './stores/workspace'
import { TitleBar } from './components/layout/TitleBar'
import { WorkspaceStatusBar } from './components/layout/WorkspaceStatusBar'
import { ConversationToolbar } from './components/layout/ConversationToolbar'
import { ManagementPage } from './components/layout/ManagementPage'
import { ActivityPanel } from './components/layout/ActivityPanel'
import { Sidebar } from './components/sidebar/Sidebar'
import type { SessionAction } from './components/sidebar/Sidebar'
import { SessionDialog } from './components/sidebar/SessionDialog'
import { NewConversationDialog } from './components/sidebar/NewConversationDialog'
import { ChatSurface } from './components/chat/ChatSurface'
import { Composer } from './components/chat/Composer'
import { settingsLabels } from './components/settings/Settings'
import type { SettingsSection } from './components/settings/Settings'
import type { ManagementSection } from './components/settings/ManagementSections'

export function App() {
  const theme = useWorkspace((state) => state.theme)
  const strength = useWorkspace((state) => state.strength)
  const sidebar = useWorkspace((state) => state.sidebar)
  const initialize = useWorkspace((state) => state.initialize)
  const hostState = useWorkspace((state) => state.host.state)
  const session = useWorkspace(activeSession)
  const toggleSidebar = useWorkspace(state => state.toggleSidebar)
  const [activity, setActivity] = useState(false)
  const [page, setPage] = useState<SettingsSection>()
  const [lastSetting, setLastSetting] = useState<SettingsSection>('models')
  const [sessionAction, setSessionAction] = useState<SessionAction>()
  const [newConversation, setNewConversation] = useState(false)

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.dataset.glass = strength
  }, [theme, strength])
  useEffect(initialize, [initialize])

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() === 'n' && !page && !sessionAction && !newConversation && hostState === 'ready') {
        event.preventDefault()
        setPage(undefined)
        setNewConversation(true)
      }
      if (event.key === ',' && !sessionAction && !newConversation) {
        event.preventDefault()
        setPage(lastSetting)
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [hostState, page, lastSetting, sessionAction, newConversation])

  function navigate(section?: ManagementSection) {
    setPage(section)
    if (section) setLastSetting(section)
    if (sidebar && window.matchMedia('(max-width: 580px)').matches) toggleSidebar()
  }

  return (
    <LiquiThemeProvider injectTokens={false} theme={{ glass: optics[strength] }}>
      <div className="app-shell">
        <div className="window-backdrop" aria-hidden="true" />
        <TitleBar destination={page && settingsLabels[page]} />
        <div className="workspace">
          {!page && sidebar && <Sidebar onCreate={() => { navigate(); setNewConversation(true) }}
            onSettings={() => setPage(lastSetting)} onSessionAction={setSessionAction} onSession={() => navigate()} />}
          <main className="chat-surface" aria-label="对话" hidden={Boolean(page)}>
            <ConversationToolbar expanded={activity} onObservatory={() => setActivity(visible => !visible)} onManageModels={() => navigate('models')} />
            <ChatSurface />
            <Composer />
          </main>
          {page && <ManagementPage section={page} onSelect={(section) => { setLastSetting(section); setPage(section) }}
            onBack={() => setPage(undefined)} />}
          {!page && activity && session && <ActivityPanel key={session.id} session={session} onClose={() => setActivity(false)} onManage={navigate} />}
        </div>
        <WorkspaceStatusBar onReconcile={() => navigate('diagnostics')} />
        {sessionAction && <SessionDialog action={sessionAction} onClose={() => setSessionAction(undefined)} />}
        {newConversation && <NewConversationDialog onClose={() => setNewConversation(false)} />}
      </div>
    </LiquiThemeProvider>
  )
}
