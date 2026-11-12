import { useState } from 'react'
import { ChartNoAxesColumn, ChevronDown, Cpu, Folder, ShieldCheck } from 'lucide-react'
import type { WorkspaceAccess } from '../../../../shared/contracts/desktop.ts'
import { workspaceAccessLabels } from '../../features/sessions/model'
import type { Session } from '../../features/sessions/model'
import { activeSession, useWorkspace } from '../../stores/workspace'
import { managementError } from '../settings/managementData'
import { Modal } from '../ui/Modal'
import { ConversationModelDialog, routeLabel } from './ConversationModelDialog'

export function ConversationToolbar({ expanded, onObservatory, onManageModels }: {
  expanded: boolean; onObservatory(): void; onManageModels(): void
}) {
  const session = useWorkspace(activeSession)
  const ready = useWorkspace(state => state.host.state === 'ready')
  const pending = useWorkspace(state => state.pending)
  const mock = useWorkspace(state => state.mock)
  const [dialog, setDialog] = useState<{ sessionId: string; type: 'model' | 'access' }>()
  if (!session) return null
  const canEdit = Boolean(session.loaded && ready && !pending && !mock)
  const status = session.turns.at(-1)?.status ?? session.latestStatus
  const access = session.workspaceAccess ?? (session.check ? 'write' : 'read')
  const folder = session.workspace?.split(/[\\/]/u).filter(Boolean).at(-1)
  const opened = dialog?.sessionId === session.id ? dialog.type : undefined
  const close = () => setDialog(undefined)
  return (
    <div className="conversation-toolbar" role="group" aria-label="会话控制">
      <div className="conversation-controls">
        <button type="button" className="conversation-control" aria-label="会话模型设置" aria-haspopup="dialog"
          disabled={!canEdit || status === 'stopping' || status === 'reconciliation'} onClick={() => setDialog({ sessionId: session.id, type: 'model' })}
          title={routeLabel(session.route)}>
          <Cpu size={15} /><span className="control-prefix">模型</span><strong data-model-current>{routeLabel(session.route)}</strong>
          {session.pendingRoute && <small data-model-pending title={routeLabel(session.pendingRoute)}>待应用 · {routeLabel(session.pendingRoute)}</small>}
          <ChevronDown size={12} />
        </button>
        <button type="button" className="conversation-control" aria-label="会话权限设置" aria-haspopup="dialog"
          disabled={!canEdit || !globalThis.window?.agentManagement} onClick={() => setDialog({ sessionId: session.id, type: 'access' })}>
          <ShieldCheck size={15} /><span className="control-prefix">权限</span><strong>{workspaceAccessLabels[access]}</strong><ChevronDown size={12} />
        </button>
        {folder && <span className="conversation-folder" title={session.workspace}><Folder size={14} />{folder}</span>}
      </div>
      <button type="button" className="conversation-control observatory-toggle" aria-expanded={expanded}
        aria-controls={expanded ? 'conversation-observatory' : undefined}
        aria-label={expanded ? '收起会话中台' : '展开会话中台'} onClick={onObservatory}><ChartNoAxesColumn size={16} /><strong>中台</strong></button>
      {opened === 'model' && <ConversationModelDialog key={session.id} session={session} onClose={close}
        onManageModels={() => { close(); onManageModels() }} />}
      {opened === 'access' && <ConversationPermissionDialog key={session.id} session={session} current={access} onClose={close} />}
    </div>
  )
}

function ConversationPermissionDialog({ session, current, onClose }: { session: Session; current: WorkspaceAccess; onClose(): void }) {
  const [selected, setSelected] = useState<WorkspaceAccess>(current)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const ready = useWorkspace(state => state.host.state === 'ready')
  const api = globalThis.window?.agentManagement
  function save() {
    if (!api || pending || !ready || selected === current) return
    setPending(true)
    setError(undefined)
    void api.setWorkspaceAccess({ conversationId: session.id, access: selected }).then(onClose, reason => {
      setPending(false)
      setError(managementError(reason))
    })
  }
  return (
    <Modal title="会话权限" subtitle={session.title} onClose={onClose} className="session-dialog new-conversation-dialog">
      <form onSubmit={event => { event.preventDefault(); save() }}>
        <p className="management-path">{session.workspace}</p>
        <label className="field-label">当前会话权限
          <select value={selected} disabled={pending} onChange={event => setSelected(event.target.value as WorkspaceAccess)}>
            {Object.entries(workspaceAccessLabels).map(([value, name]) => <option value={value} key={value}>{name}</option>)}
          </select>
        </label>
        <p className="settings-hint">收紧权限会收敛当前运行。提高权限时，系统会确认工作区路径和授权范围。</p>
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="button-neutral" onClick={onClose}>关闭</button>
          <button type="submit" className="button-primary" disabled={pending || !ready || selected === current}>保存权限</button>
        </div>
      </form>
    </Modal>
  )
}
