import { useState } from 'react'
import type { VerificationCheck, WorkspaceAccess } from '../../../../shared/contracts/desktop.ts'
import { workspaceAccessLabels } from '../../features/sessions/model'
import { useWorkspace } from '../../stores/workspace'
import { Modal } from '../ui/Modal'

const npmChecks = {
  npm_test: 'npm test',
  npm_build: 'npm run build',
  npm_lint: 'npm run lint',
  npm_typecheck: 'npm run typecheck',
} as const

export function NewConversationDialog({ onClose }: { onClose: () => void }) {
  const create = useWorkspace((state) => state.createSession)
  const choose = useWorkspace((state) => state.chooseWorkspace)
  const pending = useWorkspace((state) => state.pending)
  const ready = useWorkspace((state) => state.host.state === 'ready')
  const error = useWorkspace((state) => state.error)
  const mock = useWorkspace((state) => state.mock)
  const [title, setTitle] = useState('')
  const [workspace, setWorkspace] = useState<string>()
  const [workspaceAccess, setWorkspaceAccess] = useState<WorkspaceAccess>('write')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [path, setPath] = useState('')
  const [contains, setContains] = useState('')
  const [verificationMode, setVerificationMode] = useState<'file' | 'command'>('file')
  const [npmCheck, setNpmCheck] = useState<keyof typeof npmChecks>('npm_test')
  const [commandPath, setCommandPath] = useState('.')
  const commandVerification = workspaceAccess === 'trusted' && verificationMode === 'command'
  const invalid = Boolean(provider.trim()) !== Boolean(model.trim()) ||
    Boolean(workspace && (commandVerification ? !commandPath.trim() : contains.trim() && !path.trim()))

  async function selectWorkspace() {
    const selected = await choose()
    if (!selected || selected === workspace) return
    setWorkspace(selected)
    setWorkspaceAccess('write')
    setVerificationMode('file')
  }

  function check(): VerificationCheck | undefined {
    if (!workspace) return undefined
    if (commandVerification) return { command: { command: npmCheck, path: commandPath.trim() } }
    if (path.trim()) return { path: path.trim(), contains: contains.trim() ? contains : undefined }
  }

  return (
    <Modal title="新建会话" subtitle="为此会话选择模型和工作区" onClose={onClose} className="session-dialog new-conversation-dialog">
      <form onSubmit={(event) => {
        event.preventDefault()
        if (invalid) return
        const input = {
          title: title.trim() || undefined,
          workspace,
          workspaceAccess: workspace ? workspaceAccess : undefined,
          route: provider.trim() && model.trim() ? { provider: provider.trim(), model: model.trim() } : undefined,
          check: check(),
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
              <button type="button" className="button-neutral" onClick={() => void selectWorkspace()} disabled={pending}>选择工作区</button>
              <span title={workspace}>{workspace ?? '默认本地工作区 · 只读'}</span>
            </div>
            {workspace && (
              <>
                <label className="field-label">
                  工作区权限
                  <select value={workspaceAccess} onChange={(event) => {
                    const access = event.target.value as WorkspaceAccess
                    setWorkspaceAccess(access)
                    if (access !== 'trusted') setVerificationMode('file')
                  }}>
                    {Object.entries(workspaceAccessLabels).map(([access, label]) => <option key={access} value={access}>{label}</option>)}
                  </select>
                </label>
                {workspaceAccess === 'trusted' && (
                  <>
                    <p className="settings-hint">项目脚本以当前用户身份运行。创建会话时会弹出系统授权确认。</p>
                    <label className="field-label">
                      验收方式
                      <select value={verificationMode} onChange={(event) => setVerificationMode(event.target.value as 'file' | 'command')}>
                        <option value="file">可选文件验收</option>
                        <option value="command">项目命令验收</option>
                      </select>
                    </label>
                  </>
                )}
                {commandVerification ? (
                  <>
                    <label className="field-label">
                      验收命令
                      <select value={npmCheck} onChange={(event) => setNpmCheck(event.target.value as keyof typeof npmChecks)}>
                        {Object.entries(npmChecks).map(([command, label]) => <option key={command} value={command}>{label}</option>)}
                      </select>
                    </label>
                    <label className="field-label">命令目录（相对路径）<input maxLength={512} placeholder="." value={commandPath} onChange={(event) => setCommandPath(event.target.value)} /></label>
                  </>
                ) : (
                  <>
                    <label className="field-label">验收文件（相对路径）<input maxLength={512} placeholder="可选，例如 index.html" value={path} onChange={(event) => setPath(event.target.value)} /></label>
                    <label className="field-label">文件包含内容<input maxLength={16000} placeholder="可选" value={contains} onChange={(event) => setContains(event.target.value)} /></label>
                  </>
                )}
              </>
            )}
            <p className="settings-hint">留空模型时使用 Host 配置。工作区权限与验收检查分别设置。</p>
          </>
        )}
        {invalid && <p className="dialog-error" role="alert">请配对填写 Provider 与模型 ID，并补全所选验收方式需要的路径。</p>}
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="button-neutral" onClick={onClose}>取消</button>
          <button type="submit" className="button-primary" disabled={!ready || pending || invalid}>创建会话</button>
        </div>
      </form>
    </Modal>
  )
}
