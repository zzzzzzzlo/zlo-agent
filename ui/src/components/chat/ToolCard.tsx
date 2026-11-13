import { Check, ChevronDown, CircleAlert, CircleStop, Clock3, LoaderCircle, PauseCircle, Wrench } from 'lucide-react'
import type { RunStatus, ToolUpdate } from '../../integrations/agent/AgentAdapter'

const statuses = {
  queued: { icon: Clock3, label: '排队中' },
  running: { icon: LoaderCircle, label: '运行中' },
  verifying: { icon: LoaderCircle, label: '验收中' },
  stopping: { icon: PauseCircle, label: '停止中' },
  completed: { icon: Check, label: '已完成' },
  cancelled: { icon: CircleStop, label: '已取消' },
  stopped: { icon: CircleStop, label: '已停止' },
  error: { icon: CircleAlert, label: '失败' },
  blocked: { icon: PauseCircle, label: '已阻塞' },
  reconciliation: { icon: CircleAlert, label: '待人工核对' },
}

export function RunBadge({ status, label }: { status: RunStatus; label?: string }) {
  const { icon: Icon, label: defaultLabel } = statuses[status]
  return <span className={`run-badge status-${status}`}><Icon size={13} />{label ?? defaultLabel}</span>
}

export function ToolCard({ tool }: { tool: ToolUpdate }) {
  return (
    <details className="tool-card">
      <summary>
        <Wrench size={15} />
        <strong>{tool.name}</strong>
        <RunBadge status={tool.status} />
        <ChevronDown className="tool-chevron" size={14} />
      </summary>
      <p>{tool.detail}</p>
    </details>
  )
}

export function ToolGroup({ tools }: { tools: readonly ToolUpdate[] }) {
  const running = tools.filter(tool => tool.status === 'running').length
  const failed = tools.filter(tool => tool.status === 'error').length
  const unresolved = tools.filter(tool => tool.status === 'reconciliation').length
  const stopped = tools.filter(tool => tool.status === 'stopped' || tool.status === 'cancelled').length
  const status = unresolved ? 'reconciliation' : running ? 'running' : failed ? 'error' : stopped ? 'stopped' : 'completed'
  const counts = [running && `${running} 项运行中`, failed && `${failed} 项失败`,
    unresolved && `${unresolved} 项待核对`, stopped && `${stopped} 项已停止`].filter(Boolean)
  return <details className="tool-group">
    <summary>
      <Wrench size={14} aria-hidden="true" />
      <span>{tools.length} 项工具操作</span>
      <RunBadge status={status} label={counts.length ? counts.join(' · ') : undefined} />
      <ChevronDown className="tool-chevron" size={14} aria-hidden="true" />
    </summary>
    <div className="tool-group-list">{tools.map(tool => <ToolCard key={tool.id} tool={tool} />)}</div>
  </details>
}
