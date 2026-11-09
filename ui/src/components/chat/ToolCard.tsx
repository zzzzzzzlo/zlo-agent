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

export function RunBadge({ status }: { status: RunStatus }) {
  const { icon: Icon, label } = statuses[status]
  return <span className={`run-badge status-${status}`}><Icon size={13} />{label}</span>
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
