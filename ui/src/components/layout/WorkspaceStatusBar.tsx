import { CircleHelp, Database } from 'lucide-react'
import { activeSession, useWorkspace } from '../../stores/workspace'
import { RunBadge } from '../chat/ToolCard'

export function WorkspaceStatusBar({ onReconcile }: { onReconcile(): void }) {
  const host = useWorkspace(state => state.host)
  const mock = useWorkspace(state => state.mock)
  const session = useWorkspace(activeSession)
  const latest = session?.turns.at(-1)
  const status = latest?.status ?? session?.latestStatus
  const hostLabel = mock ? 'Mock 演示' : host.state === 'ready'
    ? host.mode === 'faux' ? 'Host · Faux' : host.mode === 'fake' ? 'Host · Fake' : 'Host 已连接'
    : host.state === 'starting' ? 'Host 启动中' : 'Host 已断开'

  return (
    <footer className="app-statusbar" aria-label="应用状态" data-host-state={host.state}>
      <div className="status-host" role="status">
        <i className="live-dot" data-state={host.state} />
        <span>{hostLabel}</span>
        <span className="status-separator" aria-hidden="true" />
        <Database size={12} />
        <span>{mock ? '演示数据' : '数据保存在本机'}</span>
      </div>
      <div className="status-run" aria-live="polite">
        {session && <span>{session.turns.length} 轮对话</span>}
        {status && <RunBadge status={status} />}
        {latest && <span>{latest.tools.length} 次工具调用</span>}
        {!session && <span>等待新任务</span>}
      </div>
      <div className="status-note">
        <CircleHelp size={12} />
        <span>{session?.check ? (session.check.command ? '命令验收' : '文件验收') : '按任务结果显示验收状态'}</span>
        {status === 'reconciliation' && globalThis.window?.agentManagement && (
          <button type="button" className="composer-reconcile" onClick={onReconcile}>核对异常操作</button>
        )}
      </div>
    </footer>
  )
}
