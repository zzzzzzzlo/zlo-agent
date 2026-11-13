import { useEffect, useState } from 'react'
import { ChevronRight, X } from 'lucide-react'
import type { ConversationObservatory } from '../../../../shared/contracts/management.ts'
import type { Session, Turn } from '../../features/sessions/model'
import { verificationExplanation, verificationLabel } from '../../features/sessions/verification'
import type { RunStatus } from '../../integrations/agent/AgentAdapter'
import { isBusy } from '../../integrations/agent/conversationProjection'
import { useWorkspace } from '../../stores/workspace'
import { RunBadge, ToolCard } from '../chat/ToolCard'
import { managementError } from '../settings/managementData'
import { IconButton } from '../ui/IconButton'

const format = new Intl.NumberFormat('zh-CN')
const price = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 })
const nodeStates: Record<NonNullable<Turn['nodes']>[number]['status'], RunStatus> = {
  running: 'running', succeeded: 'completed', failed: 'error', interrupted: 'stopped',
}
const toolStates: Record<string, string> = {
  running: '运行中', succeeded: '成功', failed: '失败', interrupted: '中断', unknown_effect: '需核对',
}

function useConversationObservatory(session: Session, ready: boolean) {
  const api = globalThis.window?.agentManagement
  const [snapshot, setSnapshot] = useState<ConversationObservatory>()
  const [error, setError] = useState<string>()
  const [retry, setRetry] = useState(0)
  const latest = session.turns.at(-1)
  const status = latest?.status ?? session.latestStatus
  const live = isBusy(status)
  useEffect(() => {
    if (!api || !ready) return
    let current = true
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const result = await api!.conversationObservatory({ conversationId: session.id })
        if (current && result.conversationId === session.id) { setSnapshot(result); setError(undefined) }
      } catch (failure) {
        if (current) setError(managementError(failure))
      } finally {
        if (current && live) timer = setTimeout(() => void refresh(), 1500)
      }
    }
    void refresh()
    return () => { current = false; clearTimeout(timer) }
  }, [api, ready, session.id, latest?.id, status, live, retry])
  return { api, snapshot, error: ready ? error : undefined, refresh: () => setRetry(value => value + 1) }
}

export function ActivityPanel({ session, onClose, onManage }: {
  session: Session
  onClose(): void
  onManage(section: 'tasks' | 'diagnostics'): void
}) {
  const ready = useWorkspace(state => state.host.state === 'ready')
  const { api, snapshot, error, refresh } = useConversationObservatory(session, ready)
  const [selected, setSelected] = useState<string>()
  const [view, setView] = useState<'run' | 'usage'>('run')
  const turn = session.turns.find(item => item.id === selected) ?? session.turns.at(-1)
  return (
    <aside className="activity-panel" id="conversation-observatory" aria-label="会话中台">
      <div className="activity-content">
        <header><h2>会话中台</h2><IconButton label="关闭会话中台" onClick={onClose}><X size={16} /></IconButton></header>
        <nav className="activity-tabs" aria-label="中台视图">
          <button type="button" aria-pressed={view === 'run'} onClick={() => setView('run')}>运行</button>
          <button type="button" aria-pressed={view === 'usage'} onClick={() => setView('usage')}>用量</button>
        </nav>
        <div className="activity-body">
          <div className="observatory-context"><strong title={session.title}>{session.title}</strong><span>{snapshot ? format.format(snapshot.turns) + ' 轮' : '当前会话'}</span></div>
          {!api && <p className="management-note">完整用量需要通过 Electron 连接 Host。</p>}
          {api && !ready && <p className="management-note" role="status">Host 未连接，数据更新已暂停。</p>}
          {error && <div className="observatory-error"><p role="alert">{error}</p><button type="button" className="button-neutral" onClick={refresh}>重试</button></div>}
          {api && ready && !snapshot && !error && <p className="management-note" role="status">正在读取会话用量…</p>}
          {view === 'run' ? (
            <>
              {snapshot && <ObservatoryTotals snapshot={snapshot} />}
              {turn ? <section className="observatory-section run-details" aria-label="运行明细">
                <div className="activity-run"><h3>运行明细</h3><RunBadge status={turn.status} label={turn.status === 'completed' ? '执行完成' : undefined} /></div>
                {session.turns.length > 1 && <label className="field-label">查看运行
                  <select value={selected ?? ''} onChange={event => setSelected(event.target.value || undefined)}>
                    <option value="">最新一轮</option>
                    {[...session.turns].reverse().map(item => <option key={item.id} value={item.id}>{item.prompt.slice(0, 48) || item.id}</option>)}
                  </select>
                </label>}
                {turn.verification && <div>
                  <p className="management-note">{verificationLabel(turn.verification)}</p>
                  {verificationExplanation(turn.verification) && <p className="management-note">{verificationExplanation(turn.verification)}</p>}
                </div>}
                {turn.nodes && turn.nodes.length > 0 && <ul className="observatory-nodes" aria-label="协作进度">
                  {turn.nodes.map(node => <li className="activity-run" key={node.id}>
                    <span>{node.role === 'team' ? 'Team Agent' : '临时 Worker'}</span><RunBadge status={nodeStates[node.status]} />
                  </li>)}
                </ul>}
                <div className="run-tool-list">
                  {turn.tools.length ? turn.tools.map(tool => <ToolCard key={tool.id} tool={tool} />) : <p className="management-note">这轮没有工具调用。</p>}
                </div>
                {api && <div className="observatory-links">
                  {turn.status === 'reconciliation' && <button type="button" className="page-back" onClick={() => onManage('diagnostics')}>核对异常操作<ChevronRight size={14} /></button>}
                  <button type="button" className="page-back" onClick={() => onManage('tasks')}>{turn.id === session.turns.at(-1)?.id ? '查看任务详情' : '打开任务历史'}<ChevronRight size={14} /></button>
                </div>}
              </section> : <div className="panel-empty"><strong>还没有运行记录</strong><p>发送第一条消息后，这里会显示任务、工具与验收状态。</p></div>}
            </>
          ) : (
            snapshot ? <ObservatoryTotals snapshot={snapshot} /> : <div className="panel-empty"><strong>暂无用量数据</strong><p>Host 返回用量后，这里会显示 Token、费用与工具统计。</p></div>
          )}
        </div>
      </div>
    </aside>
  )
}

function ObservatoryTotals({ snapshot }: { snapshot: ConversationObservatory }) {
  const { usage, tools, modelRequests, usageReports, pricedReports, estimatedCostUsd, latestTask } = snapshot
  const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite
  const unknownUsage = modelRequests > 0 && usageReports === 0
  const toolCount = tools.reduce((sum, tool) => sum + tool.count, 0)
  const counts = Object.entries(Object.groupBy(tools, tool => tool.status))
  const groups = Object.entries(Object.groupBy(tools, tool => tool.name)).sort(([, a], [, b]) =>
    b!.reduce((sum, row) => sum + row.count, 0) - a!.reduce((sum, row) => sum + row.count, 0))
  return (
    <>
      <div className="observatory-overview">
        <div><span>累计 Token</span><strong data-observatory-tokens>{unknownUsage ? '—' : format.format(total)}</strong></div>
        <div><span>估算费用</span><strong>{estimatedCostUsd === null ? '—' : price.format(estimatedCostUsd)}</strong></div>
        <div><span>模型请求</span><strong>{format.format(modelRequests)}</strong></div>
        <div><span>工具调用</span><strong data-observatory-tools>{format.format(toolCount)}</strong></div>
      </div>
      {modelRequests > 0 && <p className="observatory-coverage">{usageReports} 条用量报告 · {pricedReports} 条有价格 · 供应商剩余额度未提供</p>}
      {<section className="observatory-section">
        <h3>Token 用量</h3>
        <dl className="activity-usage" aria-label="Token 用量">
          {([['未缓存输入', usage.input], ['输出', usage.output], ['缓存读取', usage.cacheRead], ['缓存写入', usage.cacheWrite]] as const)
            .map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{unknownUsage ? '—' : format.format(value)}</dd></div>)}
        </dl>
      </section>}
      {latestTask && <section className="observatory-section">
        <h3>最近任务预算</h3>
        <div className="observatory-budget"><span>已确认用量</span><strong>{format.format(latestTask.confirmed)} / {format.format(latestTask.tokenLimit)}</strong></div>
        <meter min={0} max={latestTask.tokenLimit} value={Math.min(latestTask.tokenLimit, latestTask.confirmed)} aria-label="最近任务 Token 预算" />
        <p className="observatory-coverage">已预留 {format.format(latestTask.reserved)} · 未确认 {format.format(latestTask.uncertain)}</p>
      </section>}
      <details className="observatory-section observatory-tools">
        <summary>会话工具统计 <span>{format.format(toolCount)}</span></summary>
        {counts.length > 0 && <p className="observatory-coverage">{counts.map(([status, rows]) => (toolStates[status] ?? status) + ' ' + rows!.reduce((sum, row) => sum + row.count, 0)).join(' · ')}</p>}
        {groups.map(([name, rows]) => <div className="activity-run" key={name}><code>{name}</code><span>{format.format(rows!.reduce((sum, row) => sum + row.count, 0))}</span></div>)}
      </details>
    </>
  )
}
