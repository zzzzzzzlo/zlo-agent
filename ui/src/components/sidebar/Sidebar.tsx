import { useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { MessageSquare, MoreHorizontal, PanelLeft, Pencil, Plus, Settings2, Trash2 } from 'lucide-react'
import { useWorkspace } from '../../stores/workspace'
import type { Session } from '../../features/sessions/model'
import { isBusy } from '../../integrations/agent/conversationProjection'
import { IconButton } from '../ui/IconButton'

export type SessionAction = { type: 'rename' | 'delete'; session: Session }

export function Sidebar({ onCreate, onSettings, onSessionAction, onSession }: {
  onCreate: () => void
  onSettings: () => void
  onSessionAction: (action: SessionAction) => void
  onSession(): void
}) {
  const sessions = useWorkspace((state) => state.sessions)
  const activeId = useWorkspace((state) => state.activeId)
  const ready = useWorkspace((state) => state.host.state === 'ready')
  const select = useWorkspace((state) => state.selectSession)
  const toggle = useWorkspace((state) => state.toggleSidebar)
  const popover = useRef<HTMLDivElement>(null)
  const [menuId, setMenuId] = useState<string>()
  const target = sessions.find(({ id }) => id === menuId)

  function openMenu(event: MouseEvent<HTMLButtonElement>, id: string) {
    const menu = popover.current
    if (!menu) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (menu.matches(':popover-open')) {
      menu.hidePopover()
      if (menuId === id) return
    }
    menu.style.left = `${Math.min(rect.right - 140, innerWidth - 160)}px`
    menu.style.top = `${Math.min(rect.bottom + 4, innerHeight - 100)}px`
    setMenuId(id)
    menu.showPopover()
    menu.querySelector('button')?.focus()
  }

  function act(type: SessionAction['type']) {
    if (!target) return
    popover.current?.hidePopover()
    onSessionAction({ type, session: target })
  }

  return (
    <aside className="sidebar" aria-label="会话导航">
      <div className="sidebar-content">
        <div className="sidebar-top">
          <button className="new-session" onClick={onCreate} disabled={!ready}>
            <Plus size={16} /><span>新建会话</span><kbd>Ctrl N</kbd>
          </button>
        </div>
        <div className="sidebar-label session-label"><span>会话历史</span><span>{sessions.length.toString().padStart(2, '0')}</span></div>
        <nav className="session-list" aria-label="会话历史">
          {sessions.length === 0 && <div className="list-empty"><MessageSquare size={18} /><p>还没有会话</p><span>从一个新任务开始。</span></div>}
          {sessions.map((session) => (
            <div className={`session-row ${session.id === activeId ? 'is-selected' : ''}`} key={session.id}>
              <button className="session-select" onClick={() => { select(session.id); onSession() }} aria-current={session.id === activeId ? 'page' : undefined} title={session.title}>
                <span>{session.title}</span>
                {isBusy(session.turns.at(-1)?.status ?? session.latestStatus) && <i className="live-dot" aria-label="运行中" />}
              </button>
              <IconButton label={`${session.title}的会话操作`} className="session-more" aria-haspopup="dialog" onClick={(event) => openMenu(event, session.id)}>
                <MoreHorizontal size={16} />
              </IconButton>
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button className="settings-entry" onClick={onSettings}>
            <Settings2 size={16} /><strong>设置</strong>
          </button>
          <IconButton className="mobile-sidebar-close" label="关闭会话导航" onClick={toggle}><PanelLeft size={16} /></IconButton>
        </div>
      </div>
      <div className="session-popover" ref={popover} popover="auto" role="dialog" aria-label="会话操作">
        <div className="session-menu">
          <button onClick={() => act('rename')}><Pencil size={14} />重命名</button>
          <button onClick={() => act('delete')}><Trash2 size={14} />归档会话</button>
        </div>
      </div>
    </aside>
  )
}
