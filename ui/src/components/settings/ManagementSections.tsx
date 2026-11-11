import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentPreferences, DesktopManagementApi, ManagedDiagnostic, ManagementSnapshot } from '../../../../shared/contracts/management.ts'
import { workspaceAccessLabels } from '../../features/sessions/model'
import { activeSession, useWorkspace } from '../../stores/workspace'
import { managementError, useManagementSnapshot } from './managementData'
import { ModelManagement } from './ModelManagement'
import type { PerformManagement } from './ModelManagement'
import { approvalRows, OperationReview, TaskManagement } from './TaskManagement'

export type ManagementSection = 'models' | 'permissions' | 'tasks' | 'tools' | 'memory' | 'diagnostics'
export const managementLabels: Record<ManagementSection, string> = {
  models: '模型与账号',
  permissions: '权限与安全',
  tasks: 'Agent 与任务',
  tools: '工具与插件',
  memory: '记忆与上下文',
  diagnostics: '用量与诊断',
}

const scopedSections = new Set<ManagementSection>(['permissions', 'tasks', 'memory', 'diagnostics'])

export function ManagementSections({ section }: { section: ManagementSection }) {
  const active = useWorkspace(activeSession)
  const conversations = useWorkspace((state) => state.sessions)
  const ready = useWorkspace((state) => state.host.state === 'ready')
  const [selected, setSelected] = useState<string>()
  const [feedback, setFeedback] = useState<{ success?: string; error?: string }>({})
  const [busy, setBusy] = useState(false)
  const acting = useRef(false)
  const scoped = scopedSections.has(section)
  const conversation = scoped ? conversations.find((entry) => entry.id === selected) ?? active : undefined
  const live = conversation?.latestStatus === 'queued' || conversation?.latestStatus === 'running' ||
    conversation?.latestStatus === 'verifying' || conversation?.latestStatus === 'stopping'
  const revision = conversation ? [conversation.turns.at(-1)?.id, conversation.latestStatus].join('/') : undefined
  const { api, snapshot, error, refresh } = useManagementSnapshot(ready, conversation?.id, live, revision)
  const reload = useRef(refresh)
  useLayoutEffect(() => { reload.current = refresh }, [refresh])

  function perform(operation: () => Promise<unknown>, success?: string) {
    if (acting.current) return
    acting.current = true
    setBusy(true)
    setFeedback({})
    void (async () => {
      try {
        await operation()
        setFeedback({ success })
      } catch (error) {
        setFeedback({ error: managementError(error) })
      } finally {
        await reload.current()
        acting.current = false
        setBusy(false)
      }
    })()
  }

  function save(patch: Partial<AgentPreferences>) {
    if (api && snapshot) perform(() => api.savePreferences({ ...snapshot.preferences, ...patch }), '设置已保存。')
  }

  return (
    <section className="settings-content management-content" aria-labelledby="management-title">
      <div className="management-heading">
        <h3 id="management-title">{managementLabels[section]}</h3>
        {api && ready && <button className="button-neutral" type="button" disabled={busy} onClick={() => void refresh()}>刷新</button>}
      </div>
      {scoped && conversations.length > 0 && (
        <label className="field-label management-scope">
          会话
          <select value={conversation?.id ?? ''} disabled={busy} onChange={(event) => {
            setSelected(event.target.value)
            setFeedback({})
          }}>
            {!conversation && <option value="" disabled>选择会话</option>}
            {conversations.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}
          </select>
        </label>
      )}
      {feedback.error && <p className="dialog-error management-feedback" role="alert">{feedback.error}</p>}
      {feedback.success && <p className="management-feedback" role="status">{feedback.success}</p>}
      {busy && <p className="management-feedback" role="status">正在处理…</p>}
      {!api ? <p className="management-note">当前环境没有桌面管理接口。</p>
        : !ready ? <>
          <p className="management-note" role="status">等待 Agent Host 连接。</p>
          {section === 'diagnostics' && <OfflineDiagnostics api={api} />}
        </>
          : error ? <p className="dialog-error" role="alert">{error}</p>
            : !snapshot ? <p className="management-note" role="status">正在加载管理数据…</p>
              : <>
                {section === 'models' && <ModelManagement snapshot={snapshot} api={api} busy={busy} perform={perform} save={save} />}
                {section === 'permissions' && <Permissions snapshot={snapshot} api={api} busy={busy} perform={perform} save={save} />}
                {section === 'tasks' && <TaskManagement key={conversation?.id} snapshot={snapshot} busy={busy} perform={perform} />}
                {section === 'tools' && <Tools snapshot={snapshot} busy={busy} save={save} />}
                {section === 'memory' && <Memory key={conversation?.id} snapshot={snapshot} api={api} busy={busy} perform={perform} />}
                {section === 'diagnostics' && <Diagnostics key={conversation?.id} snapshot={snapshot} api={api} busy={busy} perform={perform} />}
              </>}
    </section>
  )
}

interface SnapshotProps {
  snapshot: ManagementSnapshot
  busy: boolean
}
interface ActionProps extends SnapshotProps {
  api: DesktopManagementApi
  perform: PerformManagement
}
interface PreferencesProps extends SnapshotProps {
  save(patch: Partial<AgentPreferences>): void
}

function Permissions({ snapshot, api, busy, perform, save }: ActionProps & PreferencesProps) {
  const conversation = snapshot.conversation
  const approvals = approvalRows(snapshot.tasks)
  const latest = snapshot.tasks.find((task) => task.taskId === conversation?.latestTaskId)
  return (
    <div className="management-stack">
      <section className="management-group">
        <h4>默认策略</h4>
        <label className="field-label">
          新工作区
          <select disabled={busy} value={snapshot.preferences.workspaceAccess} onChange={(event) =>
            save({ workspaceAccess: event.target.value as AgentPreferences['workspaceAccess'] })}>
            {Object.entries(workspaceAccessLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <p className="management-note">受信任执行需要逐个工作区通过系统授权。</p>
      </section>
      <section className="management-group">
        <h4>会话工作区</h4>
        {!conversation ? <p className="management-note">请选择一个会话。</p> : (
          <>
            <p className="management-path">{conversation.workspace}</p>
            <label className="field-label">
              当前会话权限
              <select disabled={busy} value={conversation.workspaceAccess ?? 'read'} onChange={(event) => {
                const access = event.target.value as AgentPreferences['workspaceAccess']
                perform(() => api.setWorkspaceAccess({ conversationId: conversation.id, access }))
              }}>
                {Object.entries(workspaceAccessLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <p className="management-note">收紧权限会收敛正在运行的任务。提升权限需要系统确认。</p>
          </>
        )}
        {latest?.nodes.map((node) => (
          <div className="management-row" key={node.id}>
            <div><strong>{node.role === 'root' ? 'Root' : node.role === 'team' ? 'Team' : 'Worker'}</strong>
              {node.scopePath && <small>{node.scopePath}</small>}</div>
            <span>{workspaceAccessLabels[node.access]}</span>
          </div>
        ))}
      </section>
      <section className="management-group">
        <h4>工具审批记录</h4>
        {!approvals.length && <p className="management-note">此会话暂无审批记录。</p>}
        {approvals.map((record) => (
          <div className="management-row" key={record.taskId + '/' + record.id}>
            <div><strong>{record.tool}</strong>{record.target && <small>{record.target}</small>}</div>
            <span>{record.approval === 'approved' ? '已批准' : record.approval === 'denied' ? '已拒绝' : record.approval}</span>
          </div>
        ))}
      </section>
    </div>
  )
}

function Tools({ snapshot, busy, save }: PreferencesProps) {
  const [query, setQuery] = useState('')
  const term = query.trim().toLowerCase()
  const tools = snapshot.tools.filter((tool) => tool.name.toLowerCase().includes(term) || tool.plugin.toLowerCase().includes(term))
  return (
    <div className="management-stack">
      <section className="management-group">
        <h4>搜索 Provider</h4>
        <label className="field-label">
          搜索来源
          <select disabled={busy} value={snapshot.preferences.searchProvider} onChange={(event) =>
            save({ searchProvider: event.target.value as AgentPreferences['searchProvider'] })}>
            <option value="hacker_news">Hacker News</option>
            <option value="brave" disabled={!snapshot.braveConfigured}>Brave Search{snapshot.braveConfigured ? '' : '（未配置）'}</option>
            <option value="disabled">禁用</option>
          </select>
        </label>
        {!snapshot.braveConfigured && <p className="management-note">Brave Search 使用启动环境中的 ZLO_AGENT_BRAVE_SEARCH_API_KEY。</p>}
      </section>
      <section className="management-group">
        <h4>已安装的工具</h4>
        {snapshot.tools.length > 0 && (
          <label className="field-label">
            筛选工具
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
        )}
        {!tools.length && <p className="management-note">{term ? '没有匹配的工具。' : '当前 Host 未注册工具。'}</p>}
        {tools.map((tool) => (
          <label className="management-row" key={tool.name}>
            <div>
              <strong>{tool.name}</strong>
              <small>{tool.plugin} · {tool.effect === 'write' ? '可能修改状态' : '只读'}{tool.approval && ' · 需要审批'}</small>
              <small>{[tool.root && 'Root', tool.team && 'Team', tool.worker && 'Worker'].filter(Boolean).join(' / ') || '当前角色不可用'}</small>
            </div>
            <input type="checkbox" checked={tool.enabled} disabled={busy} aria-label={tool.name + ' 已启用'} onChange={(event) => {
              const disabledTools = snapshot.preferences.disabledTools.filter((name) => name !== tool.name)
              if (!event.target.checked) disabledTools.push(tool.name)
              save({ disabledTools })
            }} />
          </label>
        ))}
      </section>
    </div>
  )
}

function Memory({ snapshot, api, busy, perform }: ActionProps) {
  const id = snapshot.conversation?.id
  if (!id) return <p className="management-note">请选择一个会话。</p>
  if (!snapshot.memory) return <p className="management-note">此会话暂无记忆与检索记录。</p>
  const { entries, recalls } = snapshot.memory
  function remove(ids: string[]) {
    if (!id) return
    perform(() => api.deleteMemory({ conversationId: id, ids }), '所选记忆已处理。')
  }
  return (
    <div className="management-stack">
      <section className="management-group">
        <h4>记忆</h4>
        <p className="management-note">作用域 · 当前会话</p>
        <p className="management-path">{snapshot.conversation?.workspace}</p>
        {!entries.length && <p className="management-note">当前作用域暂无记忆。</p>}
        {entries.length > 0 && (
          <div className="management-actions">
            <button type="button" className="button-neutral" disabled={busy} onClick={() => remove(entries.map((entry) => entry.id))}>删除已列出的记忆</button>
          </div>
        )}
        {entries.map((entry) => (
          <div className="management-row" key={entry.id}>
            <div>
              <strong>{entry.kind === 'fact' ? '事实' : '经验'}</strong>
              <p>{entry.text}</p>
              <small>版本 {entry.version} · {dateLabel(entry.updatedAt)}</small>
            </div>
            <button type="button" className="button-neutral" disabled={busy} onClick={() => remove([entry.id])}>删除</button>
          </div>
        ))}
      </section>
      <section className="management-group">
        <h4>检索记录</h4>
        {!recalls.length && <p className="management-note">当前作用域暂无检索记录。</p>}
        {recalls.map((recall, index) => (
          <div className="management-row" key={recall.taskId + '/' + recall.timestamp + '/' + index}>
            <div><strong>召回 {recall.count} 条记忆</strong><small>{dateLabel(recall.timestamp)}</small></div>
            <span className="mono" title={recall.taskId}>{recall.taskId.slice(0, 8)}</span>
          </div>
        ))}
      </section>
    </div>
  )
}

const number = new Intl.NumberFormat('zh-CN')
const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 })
function dateLabel(value: number | string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString()
}

function DiagnosticEntries({ entries }: { entries: ManagedDiagnostic[] }) {
  return <section className="management-group">
    <h4>近期诊断</h4>
    {!entries.length && <p className="management-note">当前没有诊断记录。</p>}
    {entries.map((entry, index) => (
      <div className="management-row" key={entry.timestamp + '/' + index}>
        <div>
          <strong>{entry.module} · {entry.code}</strong>
          <small>{entry.level} · {entry.category} · {entry.summary}</small>
          <small className="mono">{entry.correlationId}</small>
        </div>
        <span>{dateLabel(entry.timestamp)}</span>
      </div>
    ))}
  </section>
}

function OfflineDiagnostics({ api }: { api: DesktopManagementApi }) {
  const [entries, setEntries] = useState<ManagedDiagnostic[]>([])
  useEffect(() => {
    let active = true
    void api.recentDiagnostics().then(value => { if (active) setEntries(value) }).catch(() => {})
    return () => { active = false }
  }, [api])
  return <DiagnosticEntries entries={entries} />
}

function Diagnostics(props: ActionProps) {
  const { snapshot } = props
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  let incompleteCost = false
  for (const { usage } of snapshot.tasks) {
    totals.input += usage.input
    totals.output += usage.output
    totals.cacheRead += usage.cacheRead
    totals.cacheWrite += usage.cacheWrite
    if (usage.estimatedCostUsd !== undefined) totals.cost += usage.estimatedCostUsd
    else if (usage.input || usage.output || usage.cacheRead || usage.cacheWrite) incompleteCost = true
  }
  const latest = snapshot.tasks.find((task) => task.taskId === snapshot.conversation?.latestTaskId)
  const budget = latest?.budget
  return (
    <div className="management-stack">
      <section className="management-group">
        <h4>会话用量</h4>
        {snapshot.conversation ? (
          <>
            <dl className="management-metadata">
              <div><dt>输入 Token</dt><dd>{number.format(totals.input)}</dd></div>
              <div><dt>输出 Token</dt><dd>{number.format(totals.output)}</dd></div>
              <div><dt>缓存读取</dt><dd>{number.format(totals.cacheRead)}</dd></div>
              <div><dt>缓存写入</dt><dd>{number.format(totals.cacheWrite)}</dd></div>
              <div><dt>估算成本</dt><dd>{incompleteCost ? (totals.cost ? '已知部分 ' + dollars.format(totals.cost) : '暂无报价') : dollars.format(totals.cost)}</dd></div>
            </dl>
            <p className="management-note">最近 {snapshot.tasks.length} 个任务的用量。</p>
            <h4>最近任务预算</h4>
            <dl className="management-metadata">
              <div><dt>Token 上限</dt><dd>{budget?.tokenLimit === undefined ? '未配置' : number.format(budget.tokenLimit)}</dd></div>
              {budget?.confirmed !== undefined && <div><dt>确认消耗</dt><dd>{number.format(budget.confirmed)}</dd></div>}
              {budget?.reserved !== undefined && <div><dt>已预留</dt><dd>{number.format(budget.reserved)}</dd></div>}
              {budget?.uncertain !== undefined && <div><dt>中断待核算</dt><dd>{number.format(budget.uncertain)}</dd></div>}
              <div><dt>成本上限</dt><dd>{budget?.costLimitUsd === undefined ? '未配置' : dollars.format(budget.costLimitUsd)}</dd></div>
            </dl>
          </>
        ) : <p className="management-note">请选择一个会话。</p>}
      </section>
      <OperationReview {...props} />
      <DiagnosticEntries entries={snapshot.diagnostics} />
    </div>
  )
}
