import { useState } from 'react'
import { useWorkspace } from '../../stores/workspace'
import { Modal } from '../ui/Modal'
import type { SessionAction } from './Sidebar'

export function SessionDialog({ action, onClose }: { action: SessionAction; onClose: () => void }) {
  const [title, setTitle] = useState(action.session.title)
  const rename = useWorkspace((state) => state.renameSession)
  const remove = useWorkspace((state) => state.deleteSession)
  const pending = useWorkspace((state) => state.pending)
  const error = useWorkspace((state) => state.error)
  const isRename = action.type === 'rename'
  return (
    <Modal title={isRename ? '重命名会话' : '归档会话'} onClose={onClose} className="session-dialog">
      <form onSubmit={(event) => {
        event.preventDefault()
        if (isRename && !title.trim()) return
        const result = isRename ? rename(action.session.id, title.trim()) : remove(action.session.id)
        void result.then((completed) => { if (completed) onClose() })
      }}>
        {isRename
          ? <label className="field-label">会话名称<input autoFocus maxLength={80} value={title} onFocus={(event) => event.target.select()} onChange={(event) => setTitle(event.target.value)} /></label>
          : <p className="delete-copy">从列表中归档「{action.session.title}」，Host 会保留历史记录。</p>}
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button autoFocus={!isRename} type="button" className="button-neutral" onClick={onClose}>取消</button>
          <button type="submit" className="button-primary" disabled={pending || (isRename && !title.trim())}>{isRename ? '保存名称' : '归档会话'}</button>
        </div>
      </form>
    </Modal>
  )
}
