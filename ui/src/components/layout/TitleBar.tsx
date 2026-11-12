import { useEffect, useState } from 'react'
import { Minus, PanelLeft, Square, X } from 'lucide-react'
import { useWorkspace, activeSession } from '../../stores/workspace'
import { IconButton } from '../ui/IconButton'
import { BrandMark } from '../ui/BrandMark'
export function TitleBar({ destination }: { destination?: string }) {
  const sidebar = useWorkspace((state) => state.sidebar)
  const toggle = useWorkspace((state) => state.toggleSidebar)
  const session = useWorkspace(activeSession)
  return (
    <header className="titlebar">
      <div className={`title-brand ${sidebar ? '' : 'is-collapsed'}`}>
        {sidebar && <div className="wordmark"><span className="brand-tile"><BrandMark size={24} /></span><strong>Zlo Agent</strong></div>}
        <IconButton label={sidebar ? '收起侧栏' : '展开侧栏'} aria-expanded={sidebar} onClick={toggle}><PanelLeft size={17} /></IconButton>
      </div>
      <div className="title-main">
        <div className="title-location"><span>工作区</span><span aria-hidden="true">/</span><strong>{destination ?? session?.title ?? '新会话'}</strong></div>
      </div>
      <WindowControls />
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
