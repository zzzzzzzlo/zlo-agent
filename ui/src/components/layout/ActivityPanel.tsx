import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, RefreshCw, X } from 'lucide-react'
import { cnyRateNote, formatCny, usdToCny } from '../../../../shared/contracts/currency.ts'
import type { ConversationJudgmentItem, ConversationObservatory, ConversationTurnMetric, VerificationRigorTier } from '../../../../shared/contracts/management.ts'
import type { Session, Turn } from '../../features/sessions/model'
import { verificationExplanation, verificationLabel } from '../../features/sessions/verification'
import type { RunStatus } from '../../integrations/agent/AgentAdapter'
import { isBusy } from '../../integrations/agent/conversationProjection'
import { useWorkspace } from '../../stores/workspace'
import { RunBadge, ToolCard } from '../chat/ToolCard'
import { managementError } from '../settings/managementData'
import { IconButton } from '../ui/IconButton'

const format = new Intl.NumberFormat('zh-CN')
const decimalFmt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 })
const nodeStates: Record<NonNullable<Turn['nodes']>[number]['status'], RunStatus> = {
  running: 'running', succeeded: 'completed', failed: 'error', interrupted: 'stopped',
}
const toolStates: Record<string, string> = {
  running: '运行中', succeeded: '成功', failed: '失败', interrupted: '中断', unknown_effect: '需核对',
}
const rigorLabels: Record<VerificationRigorTier, { label: string; tone: string }> = {
  T3: { label: 'T3 命令验证', tone: 'is-positive' },
  T2: { label: 'T2 视觉闭环', tone: 'is-accent' },
  T1: { label: 'T1 路径检查', tone: 'is-caution' },
  T0: { label: 'T0 未自动验收', tone: '' },
}

function formatDurationMs(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
  if (value < 1000) return `${Math.round(value)} ms`
  if (value < 60_000) return `${decimalFmt.format(value / 1000)} s`
  return `${decimalFmt.format(value / 60_000)} min`
}

function formatPct(numerator: number, denominator: number): string {
  if (!denominator) return '—'
  return `${decimalFmt.format((numerator / denominator) * 100)}%`
}

function resolveCostCny(snapshot: ConversationObservatory): number | null {
  if (snapshot.estimatedCostCny !== undefined) return snapshot.estimatedCostCny
  if (snapshot.estimatedCostUsd == null) return null
  return usdToCny(snapshot.estimatedCostUsd, snapshot.usdToCnyRate)
}

function useConversationObservatory(session: Session, ready: boolean) {
  const api = globalThis.window?.agentManagement
  const [snapshot, setSnapshot] = useState<ConversationObservatory>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [manualTick, setManualTick] = useState(0)
  const latest = session.turns.at(-1)
  const status = latest?.status ?? session.latestStatus
  const live = isBusy(status)

  // Event-driven trigger key derived from stream updates pushed via HostAgentAdapter
  const eventRevision = useMemo(() => {
    const toolSig = latest?.tools.map(tool => `${tool.id}:${tool.status}`).join(',') ?? ''
    const nodeSig = latest?.nodes?.map(node => `${node.id}:${node.status}`).join(',') ?? ''
    const usageSig = latest?.usage
      ? `${latest.usage.input}:${latest.usage.output}:${latest.usage.cacheRead}:${latest.usage.cacheWrite}`
      : ''
    return [
      session.turns.length, latest?.id ?? '', status ?? '',
      latest?.verification?.verdict ?? '', toolSig, nodeSig, usageSig,
      latest?.response.length ? Math.floor(latest.response.length / 128) : 0,
    ].join('|')
  }, [session.turns.length, latest, status])

  const initialForSession = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!api || !ready) return
    let active = true
    let debounceTimer: ReturnType<typeof setTimeout> | undefined
    let safetyTimer: ReturnType<typeof setTimeout> | undefined

    async function pull() {
      setLoading(true)
      try {
        const result = await api!.conversationObservatory({ conversationId: session.id })
        if (active && result.conversationId === session.id) {
          setSnapshot(result)
          setError(undefined)
        }
      } catch (failure) {
        if (active) setError(managementError(failure))
      } finally {
        if (active) {
          setLoading(false)
          if (live) {
            safetyTimer = setTimeout(() => void pull(), 5000)
          }
        }
      }
    }

    const isInitial = initialForSession.current !== session.id
    if (isInitial) {
      initialForSession.current = session.id
      void pull()
    } else {
      debounceTimer = setTimeout(() => void pull(), 200)
    }

    return () => {
      active = false
      clearTimeout(debounceTimer)
      clearTimeout(safetyTimer)
    }
  }, [api, ready, session.id, eventRevision, live, manualTick])

  return {
    api, snapshot, loading,
    error: ready ? error : undefined,
    refresh: () => setManualTick(value => value + 1),
  }
}

export function ActivityPanel({ session, onClose, onManage }: {
  session: Session
  onClose(): void
  onManage(section: 'tasks' | 'diagnostics'): void
}) {
  const ready = useWorkspace(state => state.host.state === 'ready')
  const { api, snapshot, loading, error, refresh } = useConversationObservatory(session, ready)
  const [selected, setSelected] = useState<string>()
  const [view, setView] = useState<'run' | 'jev' | 'usage' | 'quality'>('run')
  const turn = session.turns.find(item => item.id === selected) ?? session.turns.at(-1)
  const turnMetric = turn ? snapshot?.turnMetrics?.find(item => item.taskId === turn.id) : undefined

  return (
    <aside className="activity-panel" id="conversation-observatory" aria-label="会话中台">
      <div className="activity-content">
        <header>
          <h2>会话中台</h2>
          <div className="observatory-header-actions">
            {api && ready && (
              <IconButton label="刷新中台数据" onClick={refresh}>
                <RefreshCw size={14} className={loading ? 'is-spinning' : undefined} />
              </IconButton>
            )}
            <IconButton label="关闭会话中台" onClick={onClose}><X size={16} /></IconButton>
          </div>
        </header>
        <nav className="activity-tabs" aria-label="中台视图">
          <button type="button" aria-pressed={view === 'run'} onClick={() => setView('run')}>运行</button>
          <button type="button" aria-pressed={view === 'jev'} onClick={() => setView('jev')}>判定</button>
          <button type="button" aria-pressed={view === 'usage'} onClick={() => setView('usage')}>趋势</button>
          <button type="button" aria-pressed={view === 'quality'} onClick={() => setView('quality')}>完成度</button>
        </nav>
        <div className="activity-body">
          <div className="observatory-context">
            <strong title={session.title}>{session.title}</strong>
            <span>{snapshot ? `${format.format(snapshot.turns)} 轮` : `${format.format(session.turns.length)} 轮`}</span>
          </div>
          {!api && <p className="management-note">完整用量与实时监测需要通过 Electron 连接 Host。</p>}
          {api && !ready && <p className="management-note" role="status">Host 未连接，数据更新已暂停。</p>}
          {error && (
            <div className="observatory-error">
              <p role="alert">{error}</p>
              <button type="button" className="button-neutral" onClick={refresh}>重试</button>
            </div>
          )}
          {api && ready && !snapshot && !error && <p className="management-note" role="status">正在读取会话指标…</p>}

          {view === 'run' && (
            <RunView
              session={session}
              snapshot={snapshot}
              turn={turn}
              turnMetric={turnMetric}
              selected={selected}
              onSelect={setSelected}
              api={Boolean(api)}
              onManage={onManage}
            />
          )}

          {view === 'jev' && (
            snapshot?.judgments
              ? <JevObservatoryView snapshot={snapshot} selectedTaskId={turn?.id} onSelectTask={(taskId) => { setSelected(taskId); setView('run') }} />
              : <div className="panel-empty"><strong>暂无 Jev 判定数据</strong><p>连接本地 Host 并启用判定点后，此处会展示每轮判定的对象、基线对比与实际运行影响。</p></div>
          )}

          {view === 'usage' && (
            snapshot
              ? <TrendsView snapshot={snapshot} selectedTaskId={turn?.id} onSelectTask={(taskId) => { setSelected(taskId); setView('run') }} />
              : <LocalFallbackUsage session={session} />
          )}

          {view === 'quality' && (
            snapshot
              ? <CompletionQualityView snapshot={snapshot} />
              : <div className="panel-empty"><strong>暂无完成度指标</strong><p>连接本地 Host 并完成运行后，将自动统计通过率、自愈率与验证强度分级。</p></div>
          )}
        </div>
      </div>
    </aside>
  )
}

function TokenMixBar({ usage }: { usage: ConversationObservatory['usage'] }) {
  const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite
  if (!total) return null
  const segments = [
    { key: 'input', label: '未缓存输入', value: usage.input, cls: 'viz-seg-input' },
    { key: 'cacheRead', label: '缓存读取', value: usage.cacheRead, cls: 'viz-seg-cache-read' },
    { key: 'cacheWrite', label: '缓存写入', value: usage.cacheWrite, cls: 'viz-seg-cache-write' },
    { key: 'output', label: '输出', value: usage.output, cls: 'viz-seg-output' },
  ].filter(item => item.value > 0)
  return (
    <div className="viz-stacked-track" role="img" aria-label={segments.map(s => `${s.label} ${format.format(s.value)}`).join('，')}>
      {segments.map(seg => (
        <span
          key={seg.key}
          className={`viz-stacked-seg ${seg.cls}`}
          style={{ width: `${(seg.value / total) * 100}%` }}
          title={`${seg.label}: ${format.format(seg.value)} (${decimalFmt.format((seg.value / total) * 100)}%)`}
        />
      ))}
    </div>
  )
}

function RunView({ session, snapshot, turn, turnMetric, selected, onSelect, api, onManage }: {
  session: Session
  snapshot?: ConversationObservatory
  turn?: Turn
  turnMetric?: ConversationTurnMetric
  selected?: string
  onSelect(id?: string): void
  api: boolean
  onManage(section: 'tasks' | 'diagnostics'): void
}) {
  const usage = snapshot?.usage ?? turn?.usage
  const totalTokens = usage ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite : 0
  const unknownUsage = snapshot ? snapshot.modelRequests > 0 && snapshot.usageReports === 0 : false
  const toolCount = snapshot
    ? snapshot.tools.reduce((sum, tool) => sum + tool.count, 0)
    : session.turns.reduce((sum, item) => sum + item.tools.length, 0)
  const failedToolCount = snapshot
    ? snapshot.tools.filter(item => item.status === 'failed').reduce((sum, item) => sum + item.count, 0)
    : 0
  const cnyCost = snapshot ? resolveCostCny(snapshot) : null
  const rate = snapshot?.usdToCnyRate ?? 7.2
  const cacheBase = usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0
  const cacheHitText = usage && cacheBase > 0 ? formatPct(usage.cacheRead, cacheBase) : '—'
  const completion = snapshot?.completion
  const verifiedRatio = completion?.ended ? `${completion.verified}/${completion.ended}` : '—'
  const latestTask = snapshot?.latestTask

  const latestBudgetTotal = latestTask ? latestTask.confirmed + latestTask.reserved + latestTask.uncertain : 0

  return (
    <>
      {snapshot && (
        <>
          <div className="observatory-overview">
            <div>
              <span>累计 Token</span>
              <strong data-observatory-tokens>{unknownUsage ? '—' : format.format(totalTokens)}</strong>
              <small>缓存命中 {cacheHitText}</small>
            </div>
            <div title={`${cnyRateNote(rate)}${snapshot.pricedReports ? ` · ${snapshot.pricedReports}/${snapshot.usageReports} 条有报价` : ''}`}>
              <span>预估价值 (人民币)</span>
              <strong>{cnyCost === null ? '—' : formatCny(cnyCost)}</strong>
              <small>汇率 1:{rate}</small>
            </div>
            <div>
              <span>确定性验收</span>
              <strong>{verifiedRatio}</strong>
              <small>Pass@1 {completion?.ended ? formatPct(completion.firstPassVerified, completion.ended) : '—'}</small>
            </div>
            <div>
              <span>工具调用</span>
              <strong data-observatory-tools>{format.format(toolCount)}</strong>
              <small>{failedToolCount ? `失败 ${failedToolCount} 次` : '全部正常'}</small>
            </div>
          </div>

          <section className="observatory-section">
            <h3>Token 用量</h3>
            {usage && <TokenMixBar usage={usage} />}
            <dl className="activity-usage" aria-label="Token 用量">
              {([
                ['未缓存输入', usage?.input ?? 0, 'var(--info)'],
                ['缓存读取', usage?.cacheRead ?? 0, 'var(--positive)'],
                ['缓存写入', usage?.cacheWrite ?? 0, 'var(--accent)'],
                ['输出', usage?.output ?? 0, 'var(--caution)'],
              ] as const).map(([label, value, color]) => (
                <div key={label}>
                  <dt><i className="viz-dot" style={{ background: color }} />{label}</dt>
                  <dd>{unknownUsage ? '—' : format.format(value)}</dd>
                </div>
              ))}
            </dl>
          </section>

          {latestTask && (
            <section className="observatory-section">
              <h3>最近任务用量</h3>
              <div className="observatory-budget">
                <span>已确认 Token</span>
                <strong>{format.format(latestTask.confirmed)}</strong>
              </div>
              {latestBudgetTotal > 0 && (
                <div className="viz-stacked-track" aria-hidden="true">
                  {latestTask.confirmed > 0 && <span className="viz-stacked-seg viz-seg-cache-read" style={{ width: `${(latestTask.confirmed / latestBudgetTotal) * 100}%` }} />}
                  {latestTask.reserved > 0 && <span className="viz-stacked-seg viz-seg-input" style={{ width: `${(latestTask.reserved / latestBudgetTotal) * 100}%` }} />}
                  {latestTask.uncertain > 0 && <span className="viz-stacked-seg viz-seg-danger" style={{ width: `${(latestTask.uncertain / latestBudgetTotal) * 100}%` }} />}
                </div>
              )}
              <p className="observatory-coverage">已预留 {format.format(latestTask.reserved)} · 未确认 {format.format(latestTask.uncertain)} · 请求 {format.format(latestTask.requests)} 次</p>
            </section>
          )}
        </>
      )}

      {turn ? (
        <section className="observatory-section run-details" aria-label="运行明细">
          <div className="activity-run">
            <h3>运行明细</h3>
            <RunBadge status={turn.status} label={turn.status === 'completed' ? '执行完成' : undefined} />
          </div>
          {session.turns.length > 1 && (
            <label className="field-label">
              查看运行
              <select value={selected ?? ''} onChange={event => onSelect(event.target.value || undefined)}>
                <option value="">最新一轮</option>
                {[...session.turns].reverse().map(item => (
                  <option key={item.id} value={item.id}>{item.prompt.slice(0, 48) || item.id}</option>
                ))}
              </select>
            </label>
          )}

          {turnMetric && (
            <>
              <div className="observatory-chip-row">
                <span className={`observatory-chip ${rigorLabels[turnMetric.rigorTier].tone}`}>
                  {rigorLabels[turnMetric.rigorTier].label}
                </span>
                {turnMetric.firstPassVerified && <span className="observatory-chip is-positive">首轮 Pass@1</span>}
                {turnMetric.selfRepaired && <span className="observatory-chip is-accent">自主修复通过</span>}
                {turnMetric.steered && <span className="observatory-chip is-caution">人工纠偏介入</span>}
                {turnMetric.attemptCount > 1 && <span className="observatory-chip">尝试 {turnMetric.attemptCount} 次</span>}
                {(turnMetric.judgmentCalls ?? 0) > 0 && (
                  <span className={`observatory-chip ${(turnMetric.judgmentInterventions ?? 0) > 0 ? 'is-accent' : ''}`}>
                    Jev {turnMetric.judgmentCalls} 次{(turnMetric.judgmentInterventions ?? 0) > 0 ? ` · 介入 ${turnMetric.judgmentInterventions}` : ''}
                  </span>
                )}
              </div>
              <div className="observatory-turn-pill">
                <span>本轮耗时 {formatDurationMs(turnMetric.durationMs)}</span>
                <span>{turnMetric.estimatedCostCny !== null ? formatCny(turnMetric.estimatedCostCny) : '成本未报价'}</span>
              </div>
            </>
          )}

          {snapshot?.judgments && (() => {
            const turnJudgments = snapshot.judgments.recent.filter(item => item.taskId === turn.id)
            if (!turnJudgments.length) return null
            return (
              <div className="observatory-jev-inline" aria-label="本轮 Jev 判定影响">
                <div className="observatory-chart-head">
                  <h4>本轮 Jev 判定影响</h4>
                  <span>{turnJudgments.length} 条记录</span>
                </div>
                <div className="observatory-jev-list">
                  {turnJudgments.slice(0, 4).map((item, idx) => (
                    <JevCausalCard key={`${item.taskId}:${item.point}:${idx}`} item={item} />
                  ))}
                </div>
              </div>
            )
          })()}

          {turn.verification && (
            <div>
              <p className="management-note">{verificationLabel(turn.verification)}</p>
              {verificationExplanation(turn.verification) && <p className="management-note">{verificationExplanation(turn.verification)}</p>}
            </div>
          )}

          {turn.nodes && turn.nodes.length > 0 && (
            <ul className="observatory-nodes" aria-label="协作进度">
              {turn.nodes.map(node => (
                <li className="activity-run" key={node.id}>
                  <span>{node.role === 'team' ? 'Team Agent' : '临时 Worker'}</span>
                  <RunBadge status={nodeStates[node.status]} />
                </li>
              ))}
            </ul>
          )}

          <div className="run-tool-list">
            {turn.tools.length ? turn.tools.map(tool => <ToolCard key={tool.id} tool={tool} />) : <p className="management-note">这轮没有工具调用。</p>}
          </div>

          {api && (
            <div className="observatory-links">
              {turn.status === 'reconciliation' && (
                <button type="button" className="page-back" onClick={() => onManage('diagnostics')}>核对异常操作<ChevronRight size={14} /></button>
              )}
              <button type="button" className="page-back" onClick={() => onManage('tasks')}>
                {turn.id === session.turns.at(-1)?.id ? '查看任务详情' : '打开任务历史'}<ChevronRight size={14} />
              </button>
            </div>
          )}
        </section>
      ) : (
        <div className="panel-empty">
          <strong>还没有运行记录</strong>
          <p>发送第一条消息后，这里会显示任务、工具与验收状态。</p>
        </div>
      )}
    </>
  )
}

function TrendsView({ snapshot, selectedTaskId, onSelectTask }: {
  snapshot: ConversationObservatory
  selectedTaskId?: string
  onSelectTask(taskId: string): void
}) {
  const series = (snapshot.turnMetrics ?? []).slice(-14)
  const maxTurnTokens = Math.max(1, ...series.map(item => item.input + item.cacheRead + item.cacheWrite + item.output))
  const totalCostCny = resolveCostCny(snapshot)
  const rate = snapshot.usdToCnyRate ?? 7.2
  const verified = snapshot.completion?.verified ?? 0
  const costPerVerified = totalCostCny !== null && verified > 0 ? totalCostCny / verified : null
  const cacheDenominator = snapshot.usage.input + snapshot.usage.cacheRead + snapshot.usage.cacheWrite
  const cacheHitPct = cacheDenominator > 0 ? (snapshot.usage.cacheRead / cacheDenominator) * 100 : 0

  const toolGroups = Object.entries(Object.groupBy(snapshot.tools, tool => tool.name))
    .map(([name, rows]) => {
      const total = rows!.reduce((sum, r) => sum + r.count, 0)
      const failed = rows!.filter(r => r.status === 'failed' || r.status === 'unknown_effect').reduce((sum, r) => sum + r.count, 0)
      return { name, total, failed, ok: total - failed }
    })
    .sort((a, b) => b.total - a.total)
  const maxToolCount = Math.max(1, ...toolGroups.map(item => item.total))

  const chartHeight = 90
  const barSlotWidth = series.length ? 260 / series.length : 20

  return (
    <div className="observatory-stack-list">
      <section className="observatory-chart-card">
        <div className="observatory-chart-head">
          <h3>每轮 Token 与成本趋势</h3>
          <span>{series.length ? `近 ${series.length} 轮峰值 ${format.format(maxTurnTokens)}` : '无数据'}</span>
        </div>
        {series.length > 0 ? (
          <>
            <svg viewBox="0 0 280 112" className="observatory-bar-svg" role="img" aria-label="各轮次 Token 消耗柱状图">
              <line x1="8" y1={chartHeight + 4} x2="272" y2={chartHeight + 4} stroke="var(--border-mid)" strokeWidth="1" />
              {series.map((item, idx) => {
                const total = item.input + item.cacheRead + item.cacheWrite + item.output
                const x = 10 + idx * barSlotWidth
                const barWidth = Math.max(4, Math.min(18, barSlotWidth - 4))
                const barX = x + (barSlotWidth - barWidth) / 2
                const hTotal = total ? Math.max(3, (total / maxTurnTokens) * (chartHeight - 8)) : 2
                const hOut = total ? (item.output / total) * hTotal : 0
                const hCache = total ? ((item.cacheRead + item.cacheWrite) / total) * hTotal : 0
                const hIn = Math.max(0, hTotal - hOut - hCache)
                const baseY = chartHeight + 4
                const costText = item.estimatedCostCny !== null ? ` · ${formatCny(item.estimatedCostCny)}` : ''
                return (
                  <g
                    key={item.taskId}
                    className="observatory-bar-col"
                    data-active={selectedTaskId === item.taskId}
                    onClick={() => onSelectTask(item.taskId)}
                  >
                    <title>{`第 ${idx + 1} 轮 (${item.label || item.taskId.slice(0, 6)}): ${format.format(total)} Token${costText}`}</title>
                    <rect className="bar-bg" x={x} y={4} width={barSlotWidth} height={chartHeight} rx={3} />
                    {total === 0 ? (
                      <rect x={barX} y={baseY - 2} width={barWidth} height={2} rx={1} fill="var(--border-mid)" />
                    ) : (
                      <>
                        {hIn > 0 && <rect x={barX} y={baseY - hIn} width={barWidth} height={hIn} fill="var(--info)" rx={1} />}
                        {hCache > 0 && <rect x={barX} y={baseY - hIn - hCache} width={barWidth} height={hCache} fill="var(--positive)" rx={1} />}
                        {hOut > 0 && <rect x={barX} y={baseY - hTotal} width={barWidth} height={hOut} fill="var(--caution)" rx={1} />}
                      </>
                    )}
                    {(series.length <= 10 || idx === 0 || idx === series.length - 1 || (idx + 1) % 3 === 0) && (
                      <text x={x + barSlotWidth / 2} y={108} textAnchor="middle" className="observatory-bar-axis">{idx + 1}</text>
                    )}
                  </g>
                )
              })}
            </svg>
            <div className="observatory-bar-legend">
              <span><i className="viz-dot" style={{ background: 'var(--info)' }} />输入</span>
              <span><i className="viz-dot" style={{ background: 'var(--positive)' }} />缓存</span>
              <span><i className="viz-dot" style={{ background: 'var(--caution)' }} />输出</span>
              <span>点击柱条切回明细</span>
            </div>
          </>
        ) : <p className="management-note">完成首轮对话后显示趋势图。</p>}
      </section>

      <section className="observatory-chart-card">
        <div className="observatory-chart-head">
          <h3>人民币价值与缓存效率</h3>
          <span>1 USD ≈ {rate} CNY</span>
        </div>
        <div className="observatory-hbars">
          <div className="observatory-hbar-row">
            <div className="observatory-hbar-head"><span>提示词缓存命中率</span><strong>{cacheDenominator ? `${decimalFmt.format(cacheHitPct)}%` : '—'}</strong></div>
            <div className="observatory-hbar-track"><span className="observatory-hbar-fill" style={{ width: `${cacheHitPct}%`, background: 'var(--positive)' }} /></div>
          </div>
          <div className="observatory-hbar-row">
            <div className="observatory-hbar-head"><span>有目录报价的请求占比</span><strong>{snapshot.usageReports ? formatPct(snapshot.pricedReports, snapshot.usageReports) : '—'}</strong></div>
            <div className="observatory-hbar-track"><span className="observatory-hbar-fill" style={{ width: `${snapshot.usageReports ? (snapshot.pricedReports / snapshot.usageReports) * 100 : 0}%`, background: 'var(--accent)' }} /></div>
          </div>
        </div>
        <div className="observatory-turn-pill">
          <span>会话预估总额</span>
          <strong>{totalCostCny !== null ? formatCny(totalCostCny) : '暂无报价'}</strong>
        </div>
        <div className="observatory-turn-pill">
          <span>单次验收达标均价</span>
          <strong>{costPerVerified !== null ? formatCny(costPerVerified) : '待产生验收通过任务'}</strong>
        </div>
      </section>

      <section className="observatory-chart-card">
        <div className="observatory-chart-head">
          <h3>工具调用分布与成败</h3>
          <span>{toolStates.succeeded} / {toolStates.failed}</span>
        </div>
        {toolGroups.length > 0 ? (
          <div className="observatory-hbars">
            {toolGroups.slice(0, 10).map(item => (
              <div className="observatory-hbar-row" key={item.name}>
                <div className="observatory-hbar-head">
                  <code>{item.name}</code>
                  <strong>{item.total} 次{item.failed ? ` (失败 ${item.failed})` : ''}</strong>
                </div>
                <div className="observatory-hbar-track">
                  {item.ok > 0 && <span className="viz-stacked-seg viz-seg-cache-read" style={{ width: `${(item.ok / maxToolCount) * 100}%` }} />}
                  {item.failed > 0 && <span className="viz-stacked-seg viz-seg-danger" style={{ width: `${(item.failed / maxToolCount) * 100}%` }} />}
                </div>
              </div>
            ))}
          </div>
        ) : <p className="management-note">暂无工具调用。</p>}
      </section>
    </div>
  )
}

function CompletionGauge({ label, subtitle, numerator, denominator, color }: {
  label: string
  subtitle: string
  numerator: number
  denominator: number
  color: string
}) {
  const valid = denominator > 0
  const pct = valid ? Math.max(0, Math.min(100, (numerator / denominator) * 100)) : 0
  const r = 22
  const circumference = 2 * Math.PI * r
  const dashoffset = circumference * (1 - pct / 100)
  return (
    <div className="observatory-ring-card">
      <svg viewBox="0 0 60 60" className="observatory-ring-svg" role="img" aria-label={`${label} ${valid ? decimalFmt.format(pct) + '%' : '未知'}`}>
        <circle cx="30" cy="30" r={r} className="observatory-ring-track" />
        <circle
          cx="30" cy="30" r={r}
          className="observatory-ring-fill"
          style={{ stroke: color }}
          strokeDasharray={circumference.toFixed(2)}
          strokeDashoffset={valid ? dashoffset.toFixed(2) : circumference.toFixed(2)}
        />
        <text x="30" y="34" textAnchor="middle" className="observatory-ring-num">{valid ? `${Math.round(pct)}%` : '—'}</text>
      </svg>
      <div className="observatory-ring-meta">
        <strong>{label}</strong>
        <span>{valid ? `${numerator}/${denominator} · ${subtitle}` : subtitle}</span>
      </div>
    </div>
  )
}

function CompletionQualityView({ snapshot }: { snapshot: ConversationObservatory }) {
  const completion = snapshot.completion
  if (!completion) {
    return <div className="panel-empty"><strong>暂无完成度指标</strong><p>等待 Host 聚合当前会话历史指标。</p></div>
  }
  const { ended, verified, unverified, failed, firstPassVerified, selfRepaired, steered, rigorTiers, nodeTotal, nodeSucceeded } = completion
  const totalTiers = rigorTiers.command + rigorTiers.visual + rigorTiers.path + rigorTiers.unverified + failed
  const strongVerified = rigorTiers.command + rigorTiers.visual

  return (
    <div className="observatory-stack-list">
      <div className="observatory-rings">
        <CompletionGauge label="确定性验收率" subtitle="通过检查" numerator={verified} denominator={ended} color="var(--positive)" />
        <CompletionGauge label="首轮 Pass@1" subtitle="无干预一次对" numerator={firstPassVerified} denominator={ended} color="var(--accent)" />
      </div>

      <section className="observatory-chart-card">
        <div className="observatory-chart-head">
          <h3>质量、自愈与干预指标</h3>
          <span>已结束 {ended} 轮</span>
        </div>
        <div className="observatory-hbars">
          <div className="observatory-hbar-row">
            <div className="observatory-hbar-head"><span>强证据验收率 (T3命令 + T2视觉)</span><strong>{formatPct(strongVerified, ended)}</strong></div>
            <div className="observatory-hbar-track"><span className="observatory-hbar-fill" style={{ width: `${ended ? (strongVerified / ended) * 100 : 0}%`, background: 'var(--positive)' }} /></div>
          </div>
          <div className="observatory-hbar-row">
            <div className="observatory-hbar-head"><span>自主修复通过数</span><strong>{selfRepaired} 轮</strong></div>
            <div className="observatory-hbar-track"><span className="observatory-hbar-fill" style={{ width: `${ended ? (selfRepaired / ended) * 100 : 0}%`, background: 'var(--info)' }} /></div>
          </div>
          <div className="observatory-hbar-row">
            <div className="observatory-hbar-head"><span>人工纠偏 / 恢复干预率</span><strong>{formatPct(steered, snapshot.turns)}</strong></div>
            <div className="observatory-hbar-track"><span className="observatory-hbar-fill" style={{ width: `${snapshot.turns ? (steered / snapshot.turns) * 100 : 0}%`, background: 'var(--caution)' }} /></div>
          </div>
          {nodeTotal > 0 && (
            <div className="observatory-hbar-row">
              <div className="observatory-hbar-head"><span>多 Agent 子目标达成率</span><strong>{nodeSucceeded}/{nodeTotal} ({formatPct(nodeSucceeded, nodeTotal)})</strong></div>
              <div className="observatory-hbar-track"><span className="observatory-hbar-fill" style={{ width: `${(nodeSucceeded / nodeTotal) * 100}%`, background: 'var(--accent)' }} /></div>
            </div>
          )}
        </div>
      </section>

      <section className="observatory-chart-card">
        <div className="observatory-chart-head">
          <h3>验证证据强度分级 (T0–T3)</h3>
          <span>防止弱验收注水</span>
        </div>
        {totalTiers > 0 ? (
          <div className="viz-stacked-track" role="img" aria-label="验收强度分级分布">
            {rigorTiers.command > 0 && <span className="viz-stacked-seg viz-seg-cache-read" style={{ width: `${(rigorTiers.command / totalTiers) * 100}%` }} title={`T3 命令验证: ${rigorTiers.command}`} />}
            {rigorTiers.visual > 0 && <span className="viz-stacked-seg viz-seg-input" style={{ width: `${(rigorTiers.visual / totalTiers) * 100}%` }} title={`T2 视觉闭环: ${rigorTiers.visual}`} />}
            {rigorTiers.path > 0 && <span className="viz-stacked-seg viz-seg-cache-write" style={{ width: `${(rigorTiers.path / totalTiers) * 100}%` }} title={`T1 路径检查: ${rigorTiers.path}`} />}
            {rigorTiers.unverified > 0 && <span className="viz-stacked-seg viz-seg-output" style={{ width: `${(rigorTiers.unverified / totalTiers) * 100}%` }} title={`T0 未自动验收: ${rigorTiers.unverified}`} />}
            {failed > 0 && <span className="viz-stacked-seg viz-seg-danger" style={{ width: `${(failed / totalTiers) * 100}%` }} title={`验收失败: ${failed}`} />}
          </div>
        ) : <p className="management-note">暂无已结束任务的验收分布。</p>}
        <div className="observatory-bar-legend">
          <span><i className="viz-dot" style={{ background: 'var(--positive)' }} />T3 命令 {rigorTiers.command}</span>
          <span><i className="viz-dot" style={{ background: 'var(--info)' }} />T2 视觉 {rigorTiers.visual}</span>
          <span><i className="viz-dot" style={{ background: 'var(--accent)' }} />T1 路径 {rigorTiers.path}</span>
          <span><i className="viz-dot" style={{ background: 'var(--caution)' }} />T0 未验 {unverified}</span>
          <span><i className="viz-dot" style={{ background: 'var(--danger)' }} />失败 {failed}</span>
        </div>
      </section>

      <div className="observatory-callout">
        <strong>跨会话深度看板 (Observatory Web)</strong>
        <span className="management-note">需要跨会话关键路径 Trace、Jev Shadow 分歧对比或独立 AI 评分时，可在终端启动完整运行中台：</span>
        <code>npm.cmd --prefix observatory start</code>
      </div>
    </div>
  )
}

const judgmentImpactLabels: Record<ConversationJudgmentItem['impactKind'], { label: string; tone: string }> = {
  intervened: { label: '已介入', tone: 'is-accent' },
  shadow_diff: { label: 'Shadow 分歧', tone: 'is-caution' },
  fallback: { label: '异常回退', tone: 'is-danger' },
  aligned: { label: '一致放行', tone: 'is-positive' },
  baseline_only: { label: '规则基线', tone: '' },
}

function JevCausalCard({ item, selected, onSelect }: {
  item: ConversationJudgmentItem
  selected?: boolean
  onSelect?: () => void
}) {
  const meta = judgmentImpactLabels[item.impactKind] ?? { label: item.impactKind, tone: '' }
  return (
    <div
      className={`observatory-jev-item${onSelect ? ' is-clickable' : ''}`}
      data-active={selected || undefined}
      onClick={onSelect}
    >
      <div className="observatory-jev-head">
        <code>{item.point}</code>
        <span className={`observatory-chip ${meta.tone}`}>{meta.label}</span>
      </div>
      <p className="observatory-jev-what">{item.whatSummary}</p>
      <p className="observatory-jev-impact">{item.impactSummary}</p>
      <div className="observatory-jev-meta">
        <span>{item.verdictSummary}</span>
        <span>{[item.judgeModel, typeof item.elapsedMs === 'number' ? `${item.elapsedMs} ms` : undefined].filter(Boolean).join(' · ') || item.mode}</span>
      </div>
    </div>
  )
}

function JevObservatoryView({ snapshot, selectedTaskId, onSelectTask }: {
  snapshot: ConversationObservatory
  selectedTaskId?: string
  onSelectTask(taskId: string): void
}) {
  const judgments = snapshot.judgments
  if (!judgments || judgments.total === 0) {
    return (
      <div className="panel-empty">
        <strong>本会话尚未产生 Jev 判定</strong>
        <p>在「模型与配置 → Jev 判定设置」启用核心 6 项（或切换到 Shadow 观察）后，这里会统计拦截注入、早停追问、噪音折叠与真实影响。</p>
      </div>
    )
  }
  const costCny = judgments.estimatedCostCny !== undefined
    ? judgments.estimatedCostCny
    : judgments.estimatedCostUsd === null ? null : usdToCny(judgments.estimatedCostUsd, snapshot.usdToCnyRate)
  const maxPointCalls = Math.max(1, ...judgments.byPoint.map(item => item.total))

  return (
    <div className="observatory-stack-list">
      <div className="observatory-overview">
        <div>
          <span>Jev 调用次数</span>
          <strong>{format.format(judgments.total)}</strong>
          <small>外部请求 {format.format(judgments.externalCalls)} 次</small>
        </div>
        <div>
          <span>生效介入</span>
          <strong>{format.format(judgments.activeInterventions)}</strong>
          <small>Shadow 分歧 {format.format(judgments.shadowDisagreements)}</small>
        </div>
        <div>
          <span>异常回退率</span>
          <strong>{formatPct(judgments.fallbacks, judgments.total)}</strong>
          <small>回退 {format.format(judgments.fallbacks)} 次</small>
        </div>
        <div>
          <span>Jev 预估成本</span>
          <strong>{costCny === null ? '—' : formatCny(costCny)}</strong>
          <small>独立于主模型统计</small>
        </div>
      </div>

      <section className="observatory-chart-card">
        <div className="observatory-chart-head">
          <h3>Active 核心保护成效</h3>
          <span>基于真实下游影响统计</span>
        </div>
        <div className="observatory-chip-row">
          <span className={`observatory-chip ${judgments.injectionBlocks > 0 ? 'is-danger' : ''}`}>注入拦截 {judgments.injectionBlocks}</span>
          <span className={`observatory-chip ${judgments.completionFollowUps > 0 ? 'is-accent' : ''}`}>早停追问 {judgments.completionFollowUps}</span>
          <span className={`observatory-chip ${judgments.admissionOmissions > 0 ? 'is-positive' : ''}`}>噪音折叠 {judgments.admissionOmissions}</span>
          <span className={`observatory-chip ${judgments.patchFlags > 0 ? 'is-caution' : ''}`}>补丁复核 {judgments.patchFlags}</span>
          <span className={`observatory-chip ${judgments.memoryFiltered > 0 ? 'is-accent' : ''}`}>记忆去噪 {judgments.memoryFiltered}</span>
        </div>
      </section>

      <section className="observatory-chart-card">
        <div className="observatory-chart-head">
          <h3>各判定点调用与介入分布</h3>
          <span>{judgments.byPoint.length} 个活跃点</span>
        </div>
        <div className="observatory-hbars">
          {judgments.byPoint.map(item => (
            <div className="observatory-hbar-row" key={item.point}>
              <div className="observatory-hbar-head">
                <code>{item.point}</code>
                <strong>{item.total} 次{item.activeInterventions ? ` · 介入 ${item.activeInterventions}` : ''}</strong>
              </div>
              <div className="observatory-hbar-track">
                <span className="viz-stacked-seg viz-seg-input" style={{ width: `${(item.total / maxPointCalls) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="observatory-chart-card">
        <div className="observatory-chart-head">
          <h3>近期判定因果明细</h3>
          <span>点击可跳回对应运行轮次</span>
        </div>
        <div className="observatory-jev-list">
          {judgments.recent.map((item, index) => (
            <JevCausalCard
              key={`${item.taskId}:${item.point}:${index}`}
              item={item}
              selected={selectedTaskId === item.taskId}
              onSelect={() => onSelectTask(item.taskId)}
            />
          ))}
        </div>
      </section>
    </div>
  )
}

function LocalFallbackUsage({ session }: { session: Session }) {
  const turns = session.turns
  const tokens = turns.reduce((acc, item) => ({
    input: acc.input + (item.usage?.input ?? 0),
    output: acc.output + (item.usage?.output ?? 0),
    cacheRead: acc.cacheRead + (item.usage?.cacheRead ?? 0),
    cacheWrite: acc.cacheWrite + (item.usage?.cacheWrite ?? 0),
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  const total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
  return total > 0 ? (
    <section className="observatory-section">
      <h3>本地会话累计用量</h3>
      <TokenMixBar usage={tokens} />
      <p className="observatory-coverage">总计 {format.format(total)} Token（完整人民币估值与趋势需连接 Host）</p>
    </section>
  ) : (
    <div className="panel-empty">
      <strong>暂无用量数据</strong>
      <p>Host 返回用量后，这里会显示每轮 Token 趋势、人民币预估价值与工具统计。</p>
    </div>
  )
}
