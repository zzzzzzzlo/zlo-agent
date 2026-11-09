import { Activity, X } from 'lucide-react'
import { useWorkspace, activeSession } from '../../stores/workspace'
import { Glass } from '../glass/Glass'
import { IconButton } from '../ui/IconButton'
import { RunBadge, ToolCard } from '../chat/ToolCard'

export function ActivityPanel({ onClose }: { onClose: () => void }) {
  const turn = useWorkspace((state) => activeSession(state)?.turns.at(-1))
  return (
    <aside className="activity-panel" aria-label="活动面板">
      <Glass variant="panel" material="frost" className="activity-glass" contentClassName="activity-content">
        <header><Activity size={17} /><h2>活动</h2><IconButton label="关闭活动面板" onClick={onClose}><X size={16} /></IconButton></header>
        <div className="activity-body">
          <div className="activity-caption mono">MOCK / 当前会话</div>
          {turn ? (
            <>
              <div className="activity-run"><strong>最近一次运行</strong><RunBadge status={turn.status} /></div>
              <div className="activity-prompt">{turn.prompt}</div>
              <h3>工具</h3>
              {turn.tools.length ? turn.tools.map((tool) => <ToolCard key={tool.id} tool={tool} />) : <p>本轮暂无工具记录。</p>}
            </>
          ) : (
            <div className="activity-empty"><Activity size={24} /><strong>暂无运行</strong><p>发送一条消息后，可在这里查看演示进度和工具状态。</p></div>
          )}
        </div>
      </Glass>
    </aside>
  )
}
