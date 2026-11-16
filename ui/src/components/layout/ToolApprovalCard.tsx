import { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import type { ApprovalKind, ToolApprovalRequest } from '../../../../shared/contracts/tool-approval.ts'
import { useWorkspace } from '../../stores/workspace.ts'

const titles: Record<ApprovalKind, string> = {
  shell: '运行系统命令', destructive: '确认文件操作', git: '修改 Git 仓库',
  browser_action: '确认浏览器操作', export: '导出文件', network: '访问外部服务',
}

function details(request: ToolApprovalRequest): string {
  try {
    const input = JSON.parse(request.detail)
    if (request.kind === 'shell' && typeof input?.command === 'string') {
      const meta: string[] = []
      if (typeof input.shell === 'string' && input.shell) meta.push(`Shell: ${input.shell}`)
      if (typeof input.path === 'string' && input.path && input.path !== '.') meta.push(`子目录: ${input.path}`)
      if (typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)) meta.push(`超时: ${Math.round(input.timeoutMs / 1000)}s`)
      return meta.length ? `[${meta.join(' · ')}]\n${input.command}` : input.command
    }
    return JSON.stringify(input, null, 2)
  } catch { return request.detail }
}

export function ToolApprovalCard() {
  const api = window.agentToolApprovals
  const sessions = useWorkspace(state => state.sessions)
  const [requests, setRequests] = useState<ToolApprovalRequest[]>([])
  const [responding, setResponding] = useState<string>()
  const [failed, setFailed] = useState<string>()
  useEffect(() => {
    if (!api) return
    let active = true
    let notified = false
    const stop = api.onChange(items => {
      notified = true
      if (active) setRequests(items)
    })
    void api.pending().then(items => { if (active && !notified) setRequests(items) }, () => {})
    return () => { active = false; stop() }
  }, [api])
  const request = requests[0]
  if (!api || !request) return null
  const sessionLabel = request.conversationTitle
    || (request.conversationId ? sessions.find(item => item.id === request.conversationId)?.title || request.conversationId : undefined)

  function decide(approved: boolean) {
    if (!api || !request || responding === request.id) return
    setResponding(request.id)
    setFailed(undefined)
    void api.decide({ id: request.id, approved }).then(() => {
      setRequests(items => items.filter(item => item.id !== request.id))
    }, () => setFailed(request.id)).finally(() => setResponding(undefined))
  }

  return (
    <section className="approval-card" aria-label="工具审批" aria-live="polite">
      <header className="approval-card-header">
        <span className="approval-card-symbol"><ShieldAlert size={18} aria-hidden="true" /></span>
        <div><h2>{titles[request.kind]}</h2><span className="mono">{request.tool}</span></div>
        {requests.length > 1 && <small>待处理 {requests.length} 项</small>}
      </header>
      {sessionLabel && <p className="approval-workspace" title={sessionLabel}>会话：{sessionLabel}</p>}
      <p className="approval-workspace" title={request.workspace}>{request.workspace}</p>
      <pre className="approval-command" tabIndex={0}>{details(request)}</pre>
      {request.kind === 'shell' && <p className="approval-risk">命令以当前 Windows 用户权限运行，可访问工作区以外的资源。</p>}
      {failed === request.id && <p role="alert" className="dialog-error">审批未送达，请重试。</p>}
      <div className="approval-card-actions">
        <button type="button" className="button-neutral" disabled={responding === request.id} onClick={() => decide(false)}>拒绝</button>
        <button type="button" className="button-primary" disabled={responding === request.id} onClick={() => decide(true)}>仅本次允许</button>
      </div>
    </section>
  )
}
