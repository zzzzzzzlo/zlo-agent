import { useEffect, useState } from 'react'
import { Box, Minus, PanelLeft, PanelRight, Square, X } from 'lucide-react'
import { useWorkspace, activeSession } from '../../stores/workspace'
import { IconButton } from '../ui/IconButton'
import { BrandMark } from '../ui/BrandMark'
import { Glass } from '../glass/Glass'
import { ConversationModelDialog, routeLabel } from './ConversationModelDialog'

export function TitleBar({ activity, onActivity, notify }: {
  activity: boolean
  onActivity: () => void
  notify: (text: string) => void
}) {
  const sidebar = useWorkspace((state) => state.sidebar)
  const toggle = useWorkspace((state) => state.toggleSidebar)
  const session = useWorkspace(activeSession)
  const ready = useWorkspace((state) => state.host.state === 'ready')
  const busy = useWorkspace((state) => state.pending)
  const mock = useWorkspace((state) => state.mock)
  const [modelDialogId, setModelDialogId] = useState<string>()
  const modelLabel = mock ? 'Mock 模型' : routeLabel(session?.route)
  const pendingLabel = session?.pendingRoute ? '待应用 · ' + routeLabel(session.pendingRoute) : undefined
  const modelStatus = session?.turns.at(-1)?.status ?? session?.latestStatus
  const canChangeModel = Boolean(session?.loaded && ready && !busy && modelStatus !== 'stopping' && modelStatus !== 'reconciliation')
  return (
    <header className="titlebar">
      <div className={`title-brand ${sidebar ? '' : 'is-collapsed'}`}>
        {sidebar && <div className="wordmark"><span className="brand-tile"><BrandMark size={24} /></span><strong>Zlo Agent</strong></div>}
        <IconButton label={sidebar ? '收起侧栏' : '展开侧栏'} aria-expanded={sidebar} onClick={toggle}><PanelLeft size={17} /></IconButton>
      </div>
      <div className="title-main">
        <div className="title-location"><span>工作区</span><span aria-hidden="true">/</span><strong>{session?.title ?? '新会话'}</strong></div>
        <div className="title-actions">
          <Glass variant="control" className="model-shell">
            <button className="model-button" aria-label="会话模型设置" aria-haspopup={mock ? undefined : 'dialog'}
              title={pendingLabel ? modelLabel + ' / ' + pendingLabel : modelLabel}
              disabled={!mock && !canChangeModel}
              onClick={() => { if (mock) notify('界面演示使用固定模型。'); else setModelDialogId(session?.id) }}>
              <Box size={13} /><span data-model-current>{modelLabel}</span>
              {pendingLabel && <span className="status-stopping" data-model-pending>{pendingLabel}</span>}
            </button>
          </Glass>
          <IconButton label={activity ? '收起活动面板' : '展开活动面板'} aria-expanded={activity} className={activity ? 'is-on' : ''} onClick={onActivity}><PanelRight size={17} /></IconButton>
        </div>
      </div>
      <WindowControls />
      {session && modelDialogId === session.id && <ConversationModelDialog key={session.id} session={session} onClose={() => setModelDialogId(undefined)} />}
    </header>
  )
}

function WindowControls() {
  const [maximized, setMaximized] = useState(false)
  const api = window.desktopWindow
  useEffect(() => {
    if (!api) return
    let current = true
    let received = false
    const unsubscribe = api.onMaximizedChange((value) => { received = true; setMaximized(value) })
    void api.isMaximized().then((value) => { if (current && !received) setMaximized(value) }).catch(console.warn)
    return () => { current = false; unsubscribe() }
  }, [api])
  if (!api) return null

  return (
    <div className="window-controls" data-maximized={maximized} role="group" aria-label="窗口控制">
      <IconButton label="最小化" onClick={() => void api.minimize().catch(console.warn)}><Minus size={15} /></IconButton>
      <IconButton label={maximized ? '还原' : '最大化'} onClick={() => void api.toggleMaximize().catch(console.warn)}>
        {maximized
          ? <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 5V3h7v7h-2M3 6h7v7H3z" stroke="currentColor" strokeWidth="1.2" /></svg>
          : <Square size={12} strokeWidth={1.7} />}
      </IconButton>
      <IconButton label="关闭窗口" className="window-close" onClick={() => void api.close().catch(console.warn)}><X size={16} strokeWidth={1.5} /></IconButton>
    </div>
  )
}
