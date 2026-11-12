import { useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { Activity, Brain, KeyRound, MessageSquare, MoreHorizontal, PanelLeft, Pencil, Plus, Settings2, ShieldCheck, Trash2, Workflow, Wrench } from 'lucide-react'
import { useWorkspace } from '../../stores/workspace'
import type { Session } from '../../features/sessions/model'
import { isBusy } from '../../integrations/agent/conversationProjection'
import { Glass } from '../glass/Glass'
import { IconButton } from '../ui/IconButton'
import { managementLabels } from '../settings/ManagementSections'
import type { ManagementSection } from '../settings/ManagementSections'

export type SessionAction = { type: 'rename' | 'delete'; session: Session }

const destinations = [
  ['models', KeyRound], ['permissions', ShieldCheck], ['tasks', Workflow], ['tools', Wrench], ['memory', Brain], ['diagnostics', Activity],
] as const

export function Sidebar({ onCreate, onSettings, onSessionAction, page, onNavigate }: {
  onCreate: () => void
  onSettings: () => void
  onSessionAction: (action: SessionAction) => void
  page?: ManagementSection
  onNavigate(section?: ManagementSection): void
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
      <Glass variant="panel" material="frost" className="sidebar-glass" contentClassName="sidebar-content">
        <div className="sidebar-top">
          <button className="new-session" onClick={onCreate} disabled={!ready}>
            <Plus size={17} /><span>新建会话</span><kbd>Ctrl N</kbd>
          </button>
        </div>
        <nav className="workspace-nav" aria-label="工作台">
          {destinations.map(([section, Icon]) => (
            <button key={section} type="button" aria-current={page === section ? 'page' : undefined} onClick={() => onNavigate(section)}>
              <Icon size={15} /><span>{managementLabels[section]}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-label session-label">会话历史</div>
        <nav className="session-list" aria-label="会话历史">
          {sessions.length === 0 && <p className="list-empty">暂无会话</p>}
          {sessions.map((session) => (
            <div className={`session-row ${!page && session.id === activeId ? 'is-selected' : ''}`} key={session.id}>
              <button className="session-select" onClick={() => { select(session.id); onNavigate() }} aria-current={!page && session.id === activeId ? 'page' : undefined} title={session.title}>
                <MessageSquare size={14} />
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
            <span className="settings-tile"><Settings2 size={16} /></span>
            <span><strong>设置</strong></span>
          </button>
          <IconButton className="mobile-sidebar-close" label="关闭会话导航" onClick={toggle}><PanelLeft size={16} /></IconButton>
        </div>
      </Glass>
      <div className="session-popover" ref={popover} popover="auto" role="dialog" aria-label="会话操作">
        <Glass variant="popover" elevated contentClassName="session-menu">
          <button onClick={() => act('rename')}><Pencil size={14} />重命名</button>
          <button onClick={() => act('delete')}><Trash2 size={14} />归档会话</button>
        </Glass>
      </div>
    </aside>
  )
}
