import {
  badge, el, empty, facts, formatDuration, formatNumber, formatTime, jsonDetails, link, panel, roleLabel, routeLabel, shortId, table,
} from './components.js'

const spanLabels = { agent: 'Agent', model: '模型', tool: '工具', delegation: '委派' }
const eventLabels = {
  'task.created': '创建任务', 'task.state_changed': '任务状态变化', 'task.plan_changed': '更新 DAG',
  'task.node_started': '启动节点', 'task.node_settled': '结算节点', 'task.worker_settled': '结算 Worker',
  'task.stop_requested': '请求停止', 'task.stopped': '停止任务', 'task.resumed': '恢复任务',
  'agent.started': '启动 Agent', 'agent.finished': '结束 Agent',
  'model.request_started': '开始模型请求', 'model.reserved': '预留模型预算', 'model.reservation_settled': '结算模型预算',
  'model.usage': '模型用量', 'model.route_changed': '切换模型', 'model.output_recovery': '恢复模型输出',
  'tool.started': '启动工具', 'tool.finished': '工具回执', 'tool.approval_resolved': '工具审批',
  'operation.reconciliation_required': '等待核对副作用', 'context.compacted': '压缩上下文',
  'memory.captured': '记录记忆', 'memory.recalled': '召回记忆', 'judgment.evaluated': '策略判断',
  'verification.finished': '确定性验收',
}

function traceFacts(task, timing, coverage) {
  const health = coverage.complete ? badge('verified', '事件连续') : badge('uncertain', '事件覆盖不完整')
  return panel('Task Run', el('div', { className: 'task-run-header stack' },
    el('div', { className: 'detail-toolbar' }, badge(task.status),
      badge(task.verification?.verdict ?? 'unverified'), health),
    facts([
      ['任务 ID', task.id], ['Run ID', task.taskRunId], ['模型', routeLabel(task.route)],
      ['停止或失败原因', task.reason], ['回放位置', formatNumber(coverage.contiguousCursor) + ' / ' + formatNumber(coverage.cursor)],
      ['缺失 / 未配对事件', formatNumber(coverage.missingEvents) + ' / ' + formatNumber(coverage.unpairedEvents)],
    ]),
    facts([
      [timing.wallClockMs == null && timing.liveWallClockMs != null ? '运行至今墙钟耗时' : '任务墙钟耗时',
        formatDuration(timing.wallClockMs ?? timing.liveWallClockMs)],
      ['模型请求时长合计', formatDuration(timing.modelRequestMs)],
      ['模型占用墙钟（并集）', formatDuration(timing.modelWallMs)],
      ['Agent 生命周期（并集）', formatDuration(timing.agentActivityMs)],
      ['Agent 运行时长合计', formatDuration(timing.agentRunMs)],
      ['依赖等待（节点合计）', formatDuration(timing.dependencyWaitMs)],
      ['就绪排队（节点合计）', formatDuration(timing.queueWaitMs)],
      ['关键路径（估算）', formatDuration(timing.criticalPathMs)],
      ['Agent 并发峰值', formatNumber(timing.peakAgents)],
    ]),
  ), el('div', { className: 'inline-actions' },
    link('返回任务列表', 'traces'), link('评估此任务', 'evaluation', { task: task.id }, 'button')))
}

function nodeList(trace) {
  const { task, nodes, timing } = trace
  if (!nodes?.length) return empty('此任务没有记录可展示的 DAG 节点。')
  const critical = new Set(timing.criticalPath ?? [])
  return el('ol', { className: 'node-list' }, nodes.map(node => {
    const dependencies = node.dependencies ?? []
    const nodeEvent = trace.events.find(event => event.taskNodeId === node.id)
    const label = node.id === task.rootNodeId ? 'Root' : roleLabel(node.role)
    const title = label + ' ' + shortId(node.id)
    return el('li', { attrs: { id: 'node-' + node.id } },
      el('div', { className: 'node-line' },
        nodeEvent ? link(title, 'traces', { task: task.id, event: nodeEvent.id }) : el('strong', { text: title }),
        badge(node.status), critical.has(node.id) && badge('active', '关键路径'),
        node.verification && badge(node.verification.verdict),
        node.id !== task.rootNodeId && link('评估交付', 'evaluation', { task: task.id, node: node.id })),
      el('p', { className: 'secondary', text: '依赖 ' + (dependencies.length ? dependencies.map(shortId).join('、') : '无') +
        ' · 等待 ' + formatDuration(node.waitMs) + ' · 最近耗时 ' + formatDuration(node.latestDurationMs) }),
      el('p', { className: 'mono secondary', text: node.id }))
  }))
}

function agentTree(taskId, agents) {
  if (!agents?.length) return empty('此任务没有 Agent 运行记录。')
  const map = new Map(agents.map(agent => [agent.agentRunId ?? agent.id, agent]))
  const children = new Map()
  for (const agent of agents) {
    const parent = agent.parentAgentRunId && map.has(agent.parentAgentRunId) ? agent.parentAgentRunId : null
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(agent)
  }
  const seen = new Set()
  const branch = (list, root = false) => el('ul', { className: root ? 'agent-tree' : undefined }, list.flatMap(agent => {
    const id = agent.agentRunId ?? agent.id
    if (seen.has(id)) return []
    seen.add(id)
    const nested = children.get(id)
    return [el('li', {},
      el('div', { className: 'node-line' }, link(roleLabel(agent.detail?.role) + ' ' + shortId(id), 'traces', { task: taskId, agent: id }),
        badge(agent.status ?? 'active'), el('small', { className: 'secondary', text: formatDuration(agent.durationMs) })),
      el('p', { className: 'secondary', text: routeLabel(agent.model) }),
      nested && branch(nested))]
  }))
  const tree = branch(children.get(null) ?? [], true)
  const remaining = agents.filter(agent => !seen.has(agent.agentRunId ?? agent.id))
  if (remaining.length) tree.append(...branch(remaining).children)
  return tree
}

function timelineDomain(trace, spans) {
  const times = []
  for (const event of trace.events) {
    const time = Date.parse(event.occurredAt)
    if (Number.isFinite(time)) times.push(time)
  }
  for (const span of spans) {
    const start = Date.parse(span.start)
    const end = Date.parse(span.end)
    if (Number.isFinite(start)) times.push(start)
    if (Number.isFinite(end)) times.push(end)
  }
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  for (const time of times) { start = Math.min(start, time); end = Math.max(end, time) }
  return Number.isFinite(start) ? { start, duration: Math.max(1, end - start) } : { start: 0, duration: 1 }
}

function spanDetail(span, taskId) {
  return el('div', { className: 'details-body' },
    facts([
      ['开始', formatTime(span.start)], ['结束', formatTime(span.end)], ['状态', badge(span.status ?? 'open').textContent],
      ['Agent Run', span.agentRunId], ['Task Node', span.taskNodeId], ['Provider / 模型', span.model && routeLabel(span.model)],
    ]),
    jsonDetails(span.detail),
    span.eventIds?.length ? el('div', { className: 'links' },
      span.eventIds.map(event => link('事件 ' + shortId(event), 'traces', { task: taskId, event }))) : null)
}

function traceTimeline(trace, route) {
  if (!trace.spans?.length) return empty('此任务没有已关联的 Agent、模型、工具或委派活动。')
  const { start, duration } = timelineDomain(trace, trace.spans)
  const selected = route.agent ? trace.spans.findIndex(span => span.kind === 'agent' && span.agentRunId === route.agent) : -1
  const spanSize = 60
  const spanPages = Math.ceil(trace.spans.length / spanSize)
  const offset = selected >= 0 && !route.spanPage ? Math.floor(selected / spanSize)
    : Math.max(0, Math.min((Number(route.spanPage) || 1) - 1, spanPages - 1))
  return el('div', {},
    el('div', { className: 'timeline-scroll' }, el('div', { className: 'timeline' },
      el('div', { className: 'timeline-axis', attrs: { 'aria-hidden': 'true' } }, el('span', { text: '活动' }),
        el('div', { className: 'ticks' }, [0, .25, .5, .75, 1].map(fraction => el('span', { text: formatDuration(duration * fraction) }))),
        el('span', { text: '耗时', className: 'duration' })),
      trace.spans.slice(offset * spanSize, (offset + 1) * spanSize).map(span => {
        const begin = Math.max(0, Math.min(100, ((Date.parse(span.start) - start) / duration) * 100))
        const spanWidth = Math.max(0, Math.min(100 - begin, ((Date.parse(span.end) - Date.parse(span.start)) / duration) * 100))
        const bar = el('i', { attrs: { 'data-kind': span.kind, 'data-open': !span.end } })
        bar.style.left = (Number.isFinite(begin) ? begin : 0) + '%'
        bar.style.width = (Number.isFinite(spanWidth) ? spanWidth : 0) + '%'
        const id = span.kind === 'agent' && span.agentRunId ? 'agent-' + span.agentRunId : 'span-' + span.id
        return el('details', { className: 'timeline-row', attrs: { id, 'data-detail': id } },
          el('summary', {}, el('span', { className: 'timeline-name', attrs: { title: span.name } },
            el('small', { className: 'secondary', text: spanLabels[span.kind] ?? span.kind }), el('strong', { text: span.name })),
          el('span', { className: 'track', attrs: { 'aria-hidden': 'true' } }, bar),
          el('span', { className: 'duration', text: formatDuration(span.durationMs) })),
          spanDetail(span, trace.task.id))
      }))),
    spanPages > 1 && pagination(trace.task.id, 'spanPage', offset, spanPages))
}

function pagination(taskId, key, offset, total) {
  return el('div', { className: 'detail-toolbar' },
    offset > 0 && link('上一页', 'traces', { task: taskId, [key]: String(offset) }, 'button'),
    el('span', { className: 'secondary', text: '第 ' + (offset + 1) + ' / ' + total + ' 页' }),
    offset + 1 < total && link('下一页', 'traces', { task: taskId, [key]: String(offset + 2) }, 'button'))
}

function eventList(trace, route) {
  const events = trace.events
  if (!events?.length) return empty('没有可回放的事件。')
  const size = 45
  const selected = route.event ? events.findIndex(event => event.id === route.event) : -1
  const pageCount = Math.ceil(events.length / size)
  const offset = selected >= 0 ? Math.floor(selected / size) : Math.max(0, Math.min((Number(route.page) || 1) - 1, pageCount - 1))
  return el('div', {},
    (route.event || route.receipt) && selected < 0 && empty('当前回放范围内未找到链接指向的事件。'),
    events.slice(offset * size, (offset + 1) * size).map(event => {
      const id = 'event-' + event.id
      return el('details', { className: 'event' + (event.id === route.event ? ' flash' : ''), attrs: { id, 'data-detail': id } },
        el('summary', {}, el('span', { className: 'mono secondary', text: '#' + event.seq + ' · ' }), eventLabels[event.type] ?? event.type,
          el('span', { className: 'secondary', text: ' · ' + formatTime(event.occurredAt) })),
        el('div', { className: 'details-body' }, facts([
          ['事件 ID', event.id], ['事件类型', event.type], ['Task Run', event.taskRunId], ['Node', event.taskNodeId],
          ['Attempt', event.taskAttemptId], ['Agent Run', event.agentRunId], ['父 Agent Run', event.parentAgentRunId],
          ['Correlation ID', event.correlationId], ['Causation ID', event.causationId],
        ]), jsonDetails(event.payload),
        event.agentRunId && el('div', { className: 'links' }, link('查看 Agent 时间段', 'traces', { task: trace.task.id, agent: event.agentRunId }))))
    }), pageCount > 1 && pagination(trace.task.id, 'page', offset, pageCount))
}

function attempts(trace) {
  const rows = (trace.task.attempts ?? []).map(attempt => [
    el('code', { text: attempt.id }), el('code', { text: attempt.nodeId }), badge(attempt.status),
    formatTime(attempt.startedAt), formatTime(attempt.finishedAt), attempt.reason, formatNumber(attempt.recoveries),
  ])
  return table(['Attempt', '节点', '状态', '开始', '结束', '原因', '恢复次数'], rows, '没有已记录的执行尝试。')
}

function judgmentTrail(trace) {
  const events = new Map(trace.events.map(event => [event.id, event]))
  return table(['决策点', '模式', '规则基线', '实际选择', 'Shadow', '关联结果'], (trace.judgments ?? []).map(item => {
    const payload = events.get(item.eventId)?.payload ?? {}
    return [link(item.point ?? '未知决策点', 'traces', { task: trace.task.id, event: item.eventId }),
      payload.mode, payload.baseline == null ? null : JSON.stringify(payload.baseline),
      payload.output == null ? null : JSON.stringify(payload.output), payload.shadow == null ? null : JSON.stringify(payload.shadow),
      el('div', { className: 'inline-actions' }, (item.linkedEventIds ?? []).map(id =>
        link(eventLabels[events.get(id)?.type] ?? shortId(id), 'traces', { task: trace.task.id, event: id }))),
    ]
  }), '此任务没有已记录的判断事件。')
}

export function traceView(trace, route) {
  return el('div', { className: 'stack' },
    traceFacts(trace.task, trace.timing ?? {}, trace.coverage ?? {}),
    el('div', { className: 'two-up' }, panel('任务 DAG', nodeList(trace)), panel('Agent Tree', agentTree(trace.task.id, trace.agents))),
    panel('执行时间线', traceTimeline(trace, route), el('span', { className: 'helper', text: '点开活动查看回执、请求用量和事件。' })),
    panel('执行尝试', attempts(trace)),
    panel('Judgment 决策', judgmentTrail(trace)),
    panel('运行事件', eventList(trace, route), el('span', { className: 'helper', text: formatNumber(trace.events.length) + ' 条已采集' })))
}
