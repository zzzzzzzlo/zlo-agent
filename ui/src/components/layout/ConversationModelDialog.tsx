import { useState } from 'react'
import type { ModelRoute } from '../../../../shared/contracts/desktop.ts'
import type { Session } from '../../features/sessions/model'
import { useWorkspace } from '../../stores/workspace'
import { Modal } from '../ui/Modal'

export function routeLabel(route?: ModelRoute): string {
  return route ? route.provider + '/' + route.model : '未设置模型'
}

export function ConversationModelDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const change = useWorkspace((state) => state.setConversationModel)
  const ready = useWorkspace((state) => state.host.state === 'ready')
  const busy = useWorkspace((state) => state.pending)
  const error = useWorkspace((state) => state.error)
  const initial = session.pendingRoute ?? session.route
  const [provider, setProvider] = useState(initial?.provider ?? '')
  const [model, setModel] = useState(initial?.model ?? '')
  const [attempted, setAttempted] = useState(false)
  const lockedProvider = session.route?.provider
  const route = { provider: lockedProvider ?? provider.trim(), model: model.trim() }
  const valid = /^[\w-]{1,80}$/.test(route.provider) && /^[\w.:/-]{1,200}$/.test(route.model)
  const unchanged = route.provider === initial?.provider && route.model === initial?.model
  const status = session.turns.at(-1)?.status ?? session.latestStatus
  const available = ready && session.loaded && !busy && status !== 'stopping' && status !== 'reconciliation'

  function submit(target: ModelRoute | null) {
    if (!available) return
    setAttempted(true)
    void change(session.id, target).then((completed) => { if (completed) onClose() })
  }

  return (
    <Modal title="会话模型" subtitle={session.title} onClose={onClose} className="session-dialog new-conversation-dialog">
      <form onSubmit={(event) => {
        event.preventDefault()
        if (valid && !unchanged) submit(route)
      }}>
        <p className="settings-hint">当前模型 · {routeLabel(session.route)}</p>
        {session.pendingRoute && <p className="settings-hint">待应用 · {routeLabel(session.pendingRoute)}</p>}
        <label className="field-label">
          Provider
          <input maxLength={80} placeholder="openai" value={lockedProvider ?? provider} readOnly={Boolean(lockedProvider)}
            onChange={(event) => setProvider(event.target.value)} />
        </label>
        <label className="field-label">
          模型 ID
          <input autoFocus maxLength={200} placeholder="填写已配置的模型 ID" value={model}
            onChange={(event) => setModel(event.target.value)} />
        </label>
        <p className="settings-hint">已有会话在同一 Provider 内切换。Host 会在安全边界应用切换。</p>
        {!valid && (provider.trim() || model.trim()) && <p className="dialog-error" role="alert">请填写有效的 Provider 和模型 ID。</p>}
        {!ready && <p className="dialog-error" role="alert">Host 未连接。</p>}
        {attempted && error && <p className="dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          {session.pendingRoute && (
            <button type="button" className="button-neutral" disabled={!available} onClick={() => submit(null)}>取消待应用模型</button>
          )}
          <button type="button" className="button-neutral" onClick={onClose}>关闭</button>
          <button type="submit" className="button-primary" disabled={!available || !valid || unchanged}>保存模型</button>
        </div>
      </form>
    </Modal>
  )
}
