import { useState } from 'react'
import type { ModelRoute } from '../../../../shared/contracts/desktop.ts'
import type { Session } from '../../features/sessions/model'
import { useWorkspace } from '../../stores/workspace'
import { Modal } from '../ui/Modal'
import { ModelCatalogSelect, modelGroups } from '../settings/ModelCatalogSelect'
import { routeDisplayLabel, routeKey, useManagementSnapshot } from '../settings/managementData'
import { useChatGptAccount } from '../settings/ChatGptManagement'

export function routeLabel(route?: ModelRoute): string {
  return routeDisplayLabel(route)
}

export function ConversationModelDialog({ session, onClose, onManageModels }: { session: Session; onClose: () => void; onManageModels(): void }) {
  const change = useWorkspace((state) => state.setConversationModel)
  const ready = useWorkspace((state) => state.host.state === 'ready')
  const busy = useWorkspace((state) => state.pending)
  const error = useWorkspace((state) => state.error)
  const pi = useWorkspace((state) => state.host.mode === 'pi')
  const catalog = useManagementSnapshot(ready && pi)
  const chatGpt = useChatGptAccount(ready && pi)
  const initial = session.pendingRoute ?? session.route
  const [selected, setSelected] = useState(initial)
  const [provider, setProvider] = useState(initial?.provider ?? '')
  const [model, setModel] = useState(initial?.model ?? '')
  const [attempted, setAttempted] = useState(false)
  const lockedProvider = session.route?.provider
  const route = pi ? selected : { provider: lockedProvider ?? provider.trim(), model: model.trim() }
  const valid = route && /^[\w-]{1,80}$/.test(route.provider) && /^[\w.:/-]{1,200}$/.test(route.model)
  const unchanged = routeKey(route) === routeKey(initial)
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
        if (route && valid && !unchanged) submit(route)
      }}>
        <p className="settings-hint">当前模型 · {routeLabel(session.route)}</p>
        {session.pendingRoute && <p className="settings-hint">待应用 · {routeLabel(session.pendingRoute)}</p>}
        {pi ? (
          <ModelCatalogSelect label="会话模型" providers={modelGroups(catalog.snapshot?.providers ?? [], chatGpt.status)} value={selected}
            provider={lockedProvider} empty="选择已配置的模型" disabled={!catalog.snapshot || busy}
            onChange={(next) => setSelected(next ?? undefined)} />
        ) : (
          <>
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
          </>
        )}
        <p className="settings-hint">已有会话在同一 Provider 内切换。Host 会在安全边界应用切换。</p>
        {pi && <button type="button" className="page-back" onClick={onManageModels}>管理 API 与账号</button>}
        {!pi && !valid && (provider.trim() || model.trim()) && <p className="dialog-error" role="alert">请填写有效的 Provider 和模型 ID。</p>}
        {catalog.error && <p className="dialog-error" role="alert">{catalog.error}</p>}
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
