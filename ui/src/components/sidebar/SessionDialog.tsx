import { useState } from 'react'
import { useWorkspace } from '../../stores/workspace'
import { Modal } from '../ui/Modal'
import type { SessionAction } from './Sidebar'

export function SessionDialog({ action, onClose }: { action: SessionAction; onClose: () => void }) {
  const [title, setTitle] = useState(action.session.title)
  const rename = useWorkspace((state) => state.renameSession)
  const remove = useWorkspace((state) => state.deleteSession)
  const isRename = action.type === 'rename'
  return (
    <Modal title={isRename ? '重命名会话' : '删除会话'} onClose={onClose} className="session-dialog">
      <form onSubmit={(event) => {
        event.preventDefault()
        if (isRename) {
          if (!title.trim()) return
          rename(action.session.id, title)
        } else remove(action.session.id)
        onClose()
      }}>
        {isRename
          ? <label className="field-label">会话名称<input autoFocus maxLength={80} value={title} onFocus={(event) => event.target.select()} onChange={(event) => setTitle(event.target.value)} /></label>
          : <p className="delete-copy">删除「{action.session.title}」及其中的演示记录。此操作无法撤销。</p>}
        <div className="dialog-actions">
          <button autoFocus={!isRename} type="button" className="button-neutral" onClick={onClose}>取消</button>
          <button type="submit" className={isRename ? 'button-primary' : 'button-danger'} disabled={isRename && !title.trim()}>{isRename ? '保存名称' : '删除会话'}</button>
        </div>
      </form>
    </Modal>
  )
}
