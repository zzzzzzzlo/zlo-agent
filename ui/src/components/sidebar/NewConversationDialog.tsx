import { useState } from 'react'
import { useWorkspace } from '../../stores/workspace'
import { Modal } from '../ui/Modal'

export function NewConversationDialog({ onClose }: { onClose: () => void }) {
  const create = useWorkspace((state) => state.createSession)
  const choose = useWorkspace((state) => state.chooseWorkspace)
  const pending = useWorkspace((state) => state.pending)
  const ready = useWorkspace((state) => state.host.state === 'ready')
  const error = useWorkspace((state) => state.error)
  const mock = useWorkspace((state) => state.mock)
  const [title, setTitle] = useState('')
  const [workspace, setWorkspace] = useState<string>()
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [path, setPath] = useState('')
  const [contains, setContains] = useState('')
  const invalid = Boolean(provider.trim()) !== Boolean(model.trim()) || Boolean(contains.trim() && !path.trim()) ||
    Boolean(path.trim() && !workspace)

  return (
    <Modal title="新建会话" subtitle="为此会话选择模型和工作区" onClose={onClose} className="session-dialog new-conversation-dialog">
      <form onSubmit={(event) => {
        event.preventDefault()
        if (invalid) return
        const input = {
          title: title.trim() || undefined,
          workspace,
          route: provider.trim() && model.trim() ? { provider: provider.trim(), model: model.trim() } : undefined,
          check: path.trim() ? { path: path.trim(), contains: contains.trim() ? contains : undefined } : undefined,
        }
        void create(input).then((completed) => {
          if (!completed) return
          onClose()
          requestAnimationFrame(() => document.getElementById('composer-input')?.focus())
        })
      }}>
        <label className="field-label">会话名称<input autoFocus maxLength={80} placeholder="新会话" value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        {!mock && (
          <>
            <div className="conversation-route-fields">
              <label className="field-label">Provider<input maxLength={80} placeholder="openai" value={provider} onChange={(event) => setProvider(event.target.value)} /></label>
              <label className="field-label">模型 ID<input maxLength={200} placeholder="使用默认模型" value={model} onChange={(event) => setModel(event.target.value)} /></label>
            </div>
            <div className="workspace-choice">
              <button type="button" className="button-neutral" onClick={() => void choose().then((value) => { if (value) setWorkspace(value) })}>选择工作区</button>
              <span title={workspace}>{workspace ?? '默认本地工作区'}</span>
            </div>
            <label className="field-label">验收文件（相对路径）<input maxLength={512} placeholder="例如 index.html" value={path} onChange={(event) => setPath(event.target.value)} /></label>
            <label className="field-label">文件包含内容<input maxLength={16000} placeholder="可选" value={contains} onChange={(event) => setContains(event.target.value)} /></label>
            <p className="settings-hint">留空模型时使用 Host 配置。填写验收文件并选择工作区后可使用受控写入工具。</p>
          </>
        )}
        {invalid && <p className="dialog-error" role="alert">请配对填写 Provider 与模型 ID。文件验收需要所选工作区和相对路径。</p>}
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="button-neutral" onClick={onClose}>取消</button>
          <button type="submit" className="button-primary" disabled={!ready || pending || invalid}>创建会话</button>
        </div>
      </form>
    </Modal>
  )
}
