const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })
const currencyFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 8 })
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' })

export const viewTitles = {
  overview: '运行总览', traces: '任务与追踪', models: '模型与资源', tools: '工具与可靠性',
  memory: '记忆与上下文', judgment: 'Judgment', evaluation: '独立评估',
}
const domainNames = {
  task: '任务执行与验收', dag: '任务 DAG', agents: 'Agent 协作', models: '模型与资源',
  tools: '工具调用', context: '上下文', memory: '记忆', judgment: 'Judgment',
  reliability: '停止与恢复', security: '权限与安全',
}
const statuses = {
  ready: ['就绪'], running: ['执行中', 'active'], verifying: ['验收中', 'active'],
  succeeded: ['执行完成', 'good'], failed: ['失败', 'bad'], blocked: ['阻塞', 'warning'],
  stop_requested: ['已请求停止', 'warning'], stopping: ['正在停止', 'warning'], stopped: ['已停止', 'warning'],
  needs_reconciliation: ['待核对', 'warning'], unknown_effect: ['副作用未知', 'warning'],
  interrupted: ['已中断', 'warning'], cancelled: ['已取消'], completed: ['已完成', 'good'],
  queued: ['排队中'], timed_out: ['超时', 'bad'], budget_exhausted: ['预算耗尽', 'warning'],
  verified: ['验收通过', 'good'], unverified: ['未验收'], not_applicable: ['不适用'],
  pass: ['通过', 'good'], fail: ['未通过', 'bad'], uncertain: ['不确定', 'warning'],
  denied: ['已拒绝', 'bad'], approved: ['已同意', 'good'], active: ['活动中', 'active'],
  settled: ['已结算'], open: ['未结算', 'warning'], released: ['已释放'], idle: ['空闲'],
}
const qualities = { measured: '实测', estimated: '估算', unknown: '未知', not_applicable: '不适用' }
const units = { count: '', tokens: 'Token', percent: '%', bytes: 'B' }
const metricLabels = {
  'task.runs': '任务运行数', 'task.execution_rate': '执行完成率', 'task.failure_rate': '任务失败率',
  'task.verified_rate': '确定性验收通过率', 'task.wall_clock': '平均任务墙钟耗时',
  'task.unverified': '未验收任务', 'task.verification_failed': '验收失败', 'task.root_retries': '根任务重试',
  'dag.nodes': '委派节点', 'dag.dependencies': '节点依赖', 'dag.replanned': '节点重规划', 'dag.retries': '节点重试',
  'dag.critical_path': '平均依赖关键路径', 'dag.pre_start_wait': '平均启动等待',
  'dag.dependency_wait': '平均依赖等待', 'dag.queue_wait': '平均排队等待',
  'agents.runs': 'Agent 运行数', 'agents.peak': 'Agent 并发峰值', 'agents.delegations': '委派尝试',
  'agents.deliveries': '已交付节点', 'agents.collaboration_time': '平均委派耗时',
  'agents.active_wall': 'Agent 生命周期墙钟', 'agents.work': 'Agent 生命周期总时长', 'agents.pure_compute': 'Agent 计算时间',
  'model.requests': '模型请求', 'model.tokens': 'Provider 总 Token', 'model.input': '未缓存输入',
  'model.output': '输出 Token', 'model.cache_read': '缓存读取', 'model.cache_write': '缓存写入',
  'model.cost': '模型成本（估算）', 'model.mean_latency': '平均请求延迟', 'model.p95_latency': 'P95 请求延迟',
  'model.mean_reservation': '平均预留耗时', 'model.request_work': '请求时长合计', 'model.request_wall': '请求墙钟占用',
  'model.budget_reserved': '预留 Token（估算）', 'model.output_budget': '平均单次输出上限', 'model.task_token_limit': '任务 Token 上限峰值',
  'model.budget_open': '未结算预留 Token', 'model.budget_uncertain': '结算未知的预留 Token',
  'model.uncertain_requests': '用量未知的请求', 'model.unpaired_usage': '未关联用量记录', 'model.quota': 'Provider 剩余额度',
  'tool.calls': '工具调用', 'tool.failure_rate': '工具失败率', 'tool.failed': '工具失败回执',
  'tool.mean_latency': '平均工具结算耗时', 'tool.p95_latency': 'P95 工具结算耗时',
  'tool.repeat_name': '同名工具重复调用', 'tool.unknown_effect': '未知副作用', 'tool.interrupted': '工具中断',
  'context.compactions': '上下文压缩', 'context.before': '压缩前平均 Token', 'context.after': '压缩后平均 Token',
  'context.size': '平均上下文体积', 'context.budget': '平均上下文预算',
  'context.model_input_estimate': '请求上下文（估算）', 'context.compaction_cost': '压缩成本（估算）',
  'memory.capture_events': '记忆提取事件', 'memory.captured': '写入记忆条目', 'memory.recall_events': '记忆召回事件',
  'memory.injected': '注入记忆条目', 'memory.capture_latency': '平均记忆提取耗时',
  'memory.recall_latency': '平均记忆召回耗时', 'memory.cost': '记忆模型成本',
  'judgment.decisions': 'Judgment 调用', 'judgment.shadow_disagreement': 'Shadow 分歧率',
  'judgment.active_changes': 'Active 决策变化', 'judgment.mean_latency': '平均判断耗时',
  'judgment.cost': '判断成本（估算）', 'judgment.tokens': '判断 Token',
  'reliability.stop_requested': '停止请求', 'reliability.stopped': '已停止任务', 'reliability.resumed': '任务恢复',
  'reliability.output_recoveries': '模型输出续接', 'reliability.incomplete_streams': '未完整采集的任务',
  'reliability.missing_events': '缺失事件', 'reliability.unpaired': '未配对事件',
  'security.permissions_changed': '权限变更', 'security.approvals_granted': '审批同意', 'security.approvals_denied': '审批拒绝',
  'security.write_tools': '写操作工具调用', 'security.reconciliations': '待核对副作用', 'security.policy_denials': '策略拒绝',
}

export function el(tag, { className, text, attrs } = {}, ...children) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = String(text)
  if (attrs) for (const [name, value] of Object.entries(attrs)) if (value != null) node.setAttribute(name, String(value))
  for (const child of children.flat()) if (child != null && typeof child !== 'boolean') node.append(child)
  return node
}

export function routeHash(view, values = {}) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (typeof value === 'string' && value) query.set(key, value)
  const suffix = query.toString()
  return '#' + view + (suffix ? '?' + suffix : '')
}
export function link(text, view, values, className) {
  return el('a', { text, className, attrs: { href: routeHash(view, values) } })
}
export function badge(status, label) {
  const [text, tone] = Object.hasOwn(statuses, status) ? statuses[status] : [status ?? '未知']
  return el('span', { className: 'badge', text: label ?? text, attrs: { 'data-tone': tone } })
}
export function formatNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? numberFormat.format(value) : '—'
}
export function formatCurrency(value) {
  return typeof value === 'number' && Number.isFinite(value) ? currencyFormat.format(value) : '—'
}
export function formatTime(value) {
  return value && Number.isFinite(Date.parse(value)) ? dateFormat.format(new Date(value)) : '—'
}
export function formatDuration(value) {
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 1000) return formatNumber(value) + ' ms'
  if (value < 60000) return formatNumber(value / 1000) + ' s'
  if (value < 3600000) return formatNumber(value / 60000) + ' min'
  return formatNumber(value / 3600000) + ' h'
}
export function shortId(value) { return typeof value === 'string' ? value.slice(0, 8) : '—' }
export function routeLabel(route) {
  return route && (route.provider || route.model) ? [route.provider, route.model].filter(Boolean).join(' / ') : '未知'
}
export function roleLabel(role) {
  return ({ root: 'Root', team: 'Team', worker: 'Worker' })[role] ?? role ?? '未知角色'
}
export function empty(message) { return el('p', { className: 'empty', text: message }) }
export function panel(title, content, right) {
  return el('section', { className: 'panel glass' },
    el('header', { className: 'panel-header' }, el('h2', { text: title }), right), content)
}
export function facts(entries) {
  return el('dl', { className: 'facts' }, entries.map(([name, value]) =>
    el('div', {}, el('dt', { text: name }), el('dd', {}, value == null ? '—' : String(value)))))
}
export function jsonDetails(value) {
  if (!value || !Object.keys(value).length) return null
  return el('pre', { text: JSON.stringify(value, null, 2) })
}
export function table(headers, rows, message = '当前范围没有记录。') {
  if (!rows.length) return empty(message)
  return el('div', { className: 'table-scroll' }, el('table', {},
    el('thead', {}, el('tr', {}, headers.map(name => el('th', { text: name, attrs: { scope: 'col' } })))),
    el('tbody', {}, rows.map(row => el('tr', {}, row.map(cell => el('td', {}, cell == null ? '—' : cell)))))))
}

function metricValue(metric) {
  if (metric.value == null) return ['—', '']
  if (metric.unit === 'ms') {
    const formatted = formatDuration(metric.value)
    const offset = formatted.lastIndexOf(' ')
    return [formatted.slice(0, offset), formatted.slice(offset + 1)]
  }
  if (metric.unit === 'USD' || metric.unit === 'usd') return [formatCurrency(metric.value), 'USD']
  return [formatNumber(metric.value), units[metric.unit] ?? metric.unit ?? '']
}
export function metricGrid(metrics, compact = false) {
  if (!metrics?.length) return empty('当前范围没有可用指标。')
  return el('div', { className: 'metric-grid' + (compact ? ' compact' : '') }, metrics.map(metric => {
    const [value, unit] = metricValue(metric)
    const label = metricLabels[metric.id] ?? metric.label
    const coverage = Number.isFinite(metric.population) && Number.isFinite(metric.samples) && metric.samples < metric.population && metric.unit !== 'percent'
      ? ' · ' + formatNumber(metric.samples) + '/' + formatNumber(metric.population) + ' 样本' : ''
    return el('dl', { className: 'metric', attrs: {
      'data-quality': metric.quality, 'aria-label': label + '。' + (metric.description ?? ''),
      title: metric.description, tabindex: metric.description ? 0 : undefined,
    } }, el('dt', { text: label }),
    el('dd', {}, el('strong', { text: value }), unit && el('span', { className: 'unit', text: unit })),
    el('dd', { className: 'quality', text: (qualities[metric.quality] ?? metric.quality ?? '未知') + coverage }))
  }))
}

export function taskTable(tasks, includeEvaluation = false) {
  const headings = ['任务 / Run', '运行状态', '确定性验收', '模型', '尝试']
  if (includeEvaluation) headings.push('评估')
  return table(headings, tasks.map(task => {
    const row = [
      el('div', {}, link(shortId(task.id), 'traces', { task: task.id }), el('span', { className: 'mono secondary', text: task.taskRunId })),
      badge(task.status), badge(task.verification?.verdict ?? 'unverified'),
      el('span', { className: 'mono', text: routeLabel(task.route) }), formatNumber(task.attemptCount),
    ]
    if (includeEvaluation) row.push(link('评估', 'evaluation', { task: task.id }))
    return row
  }), '没有符合筛选条件的任务。')
}

export function overviewView(data) {
  const core = data.metrics?.overview ?? []
  return el('div', { className: 'stack' },
    panel('核心指标', metricGrid(core), el('span', { className: 'helper', text: '执行、验收与 AI 评估各自记录' })),
    panel('最近任务', taskTable(data.tasks.slice(0, 8)), link('查看任务', 'traces')))
}

const detailDomains = {
  models: ['models'],
  tools: ['tools', 'reliability', 'security'],
  memory: ['memory', 'context'],
  judgment: ['judgment'],
}
const groupLabels = { models: '按 Provider、模型和 Agent 角色', tools: '按工具', judgment: '按决策点、模式与特征版本' }
function grouping(rows, type) {
  if (!rows?.length) return empty('当前范围没有可分组的事件。')
  return rows.map(row => {
    const summary = el('summary', {}, row.label ?? row.key)
    if (row.role) summary.append(' · ' + roleLabel(row.role))
    if (row.mode && !String(row.label).includes(row.mode)) summary.append(' · ' + row.mode)
    const references = Array.isArray(row.references) ? row.references.slice(0, 25) : []
    return el('details', { className: 'group', attrs: { 'data-detail': type + ':' + row.key } }, summary,
      el('div', { className: 'details-body' }, metricGrid(row.metrics, true),
        references.length ? el('div', { className: 'links' }, references.map(ref =>
          link('事件 ' + shortId(ref.eventId), 'traces', { task: ref.taskId, event: ref.eventId }))) : null))
  })
}
export function domainView(view, data) {
  const metrics = data.metrics ?? {}
  const grouped = { models: metrics.models, tools: metrics.tools, judgment: metrics.judgments }[view]
  return el('div', { className: 'stack' },
    detailDomains[view].map(domain => panel(domainNames[domain], metricGrid(metrics.domains?.[domain], true))),
    groupLabels[view] && panel(groupLabels[view], grouping(grouped, view)))
}

export function traceList(data) {
  return el('div', { className: 'stack' }, panel('任务历史', taskTable(data.tasks, true)),
    el('div', { className: 'two-up' }, ['task', 'dag', 'agents'].map(domain =>
      panel(domainNames[domain], metricGrid(data.metrics?.domains?.[domain], true)))))
}
