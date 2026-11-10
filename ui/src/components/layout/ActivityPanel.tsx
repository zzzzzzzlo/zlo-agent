import { Activity, X } from 'lucide-react'
import { workspaceAccessLabels } from '../../features/sessions/model'
import type { Turn } from '../../features/sessions/model'
import type { RunStatus } from '../../integrations/agent/AgentAdapter'
import { useWorkspace, activeSession } from '../../stores/workspace'
import { Glass } from '../glass/Glass'
import { IconButton } from '../ui/IconButton'
import { RunBadge, ToolCard } from '../chat/ToolCard'

const nodeStates: Record<NonNullable<Turn['nodes']>[number]['status'], RunStatus> = {
  running: 'running',
  succeeded: 'completed',
  failed: 'error',
  interrupted: 'stopped',
}

export function ActivityPanel({ onClose }: { onClose: () => void }) {
  const turn = useWorkspace((state) => activeSession(state)?.turns.at(-1))
  const session = useWorkspace(activeSession)
  return (
    <aside className="activity-panel" aria-label="活动面板">
      <Glass variant="panel" material="frost" className="activity-glass" contentClassName="activity-content">
        <header><Activity size={17} /><h2>活动</h2><IconButton label="关闭活动面板" onClick={onClose}><X size={16} /></IconButton></header>
        <div className="activity-body">
          <div className="activity-caption mono">当前会话</div>
          {turn ? (
            <>
              <div className="activity-run"><strong>最近一次运行</strong><RunBadge status={turn.status} /></div>
              <div className="activity-prompt">{turn.prompt}</div>
              {turn.usage && (
                <dl className="activity-usage" aria-label="Token 用量">
                  <div><dt>输入 Token</dt><dd>{turn.usage.input}</dd></div>
                  <div><dt>输出 Token</dt><dd>{turn.usage.output}</dd></div>
                  <div><dt>缓存读取</dt><dd>{turn.usage.cacheRead}</dd></div>
                  <div><dt>缓存写入</dt><dd>{turn.usage.cacheWrite}</dd></div>
                </dl>
              )}
              {session?.workspace && <p className="activity-workspace" title={session.workspace}>{session.workspace}</p>}
              {session?.workspaceAccess && <p>工作区权限 · {workspaceAccessLabels[session.workspaceAccess]}</p>}
              {turn.nodes && turn.nodes.length > 0 && (
                <>
                  <h3 id="activity-collaboration">协作进度</h3>
                  <ul aria-labelledby="activity-collaboration">
                    {turn.nodes.map((node) => (
                      <li className="activity-run" key={node.id} title={node.id}>
                        <span>{node.role === 'team' ? 'Team Agent' : '临时 Worker'}</span>
                        <RunBadge status={nodeStates[node.status]} />
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <h3>工具</h3>
              {turn.tools.length ? turn.tools.map((tool) => <ToolCard key={tool.id} tool={tool} />) : <p>本轮暂无工具记录。</p>}
            </>
          ) : (
            <div className="activity-empty"><Activity size={24} /><strong>暂无运行</strong><p>发送一条消息后，可在这里查看进度和工具状态。</p></div>
          )}
        </div>
      </Glass>
    </aside>
  )
}
