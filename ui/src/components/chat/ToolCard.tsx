import { Check, ChevronDown, CircleAlert, CircleStop, LoaderCircle, Wrench } from 'lucide-react'
import type { RunStatus, ToolUpdate } from '../../integrations/agent/AgentAdapter'

const statuses = {
  running: { icon: LoaderCircle, label: '运行中' },
  completed: { icon: Check, label: '已完成' },
  cancelled: { icon: CircleStop, label: '已取消' },
  error: { icon: CircleAlert, label: '错误' },
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
        <span className="tool-mock mono">MOCK</span>
        <RunBadge status={tool.status} />
        <ChevronDown className="tool-chevron" size={14} />
      </summary>
      <p>{tool.detail}</p>
    </details>
  )
}
