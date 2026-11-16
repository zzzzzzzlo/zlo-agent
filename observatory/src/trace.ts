import { createHash } from 'node:crypto'
import type { ModelRoute } from '../../shared/contracts/domain.ts'
import { coreJudgmentPoints } from '../../shared/contracts/jev.ts'
import { isCompletionFollowUp } from '../../shared/contracts/observatory.ts'
import type { TelemetryEvent, TelemetryNode, TelemetryTask } from '../../shared/contracts/observatory.ts'

export interface TraceSpan {
  id: string
  kind: 'agent' | 'model' | 'tool' | 'delegation'
  name: string
  start: string
  end?: string
  durationMs: number | null
  status?: string
  taskAttemptId?: string
  correlationId?: string
  agentId?: string
  agentRunId?: string
  taskNodeId?: string
  parentAgentRunId?: string
  model?: ModelRoute
  eventIds: string[]
  detail: Record<string, unknown>
}

interface TraceNode extends TelemetryNode {
  plannedAt?: string
  firstStartedAt?: string
  waitMs: number | null
  latestDurationMs: number | null
}

type Interval = [number, number]
const terminal = new Set(['succeeded', 'failed', 'stopped', 'blocked', 'needs_reconciliation'])

export function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function text(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }

export function quantity(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function modelRoute(value: unknown): ModelRoute | undefined {
  const route = object(value)
  const provider = text(route?.provider)
  const model = text(route?.model)
  return provider && model ? { provider, model } : undefined
}

function interval(start: string | undefined, end: string | undefined): Interval | undefined {
  if (!start || !end) return
  const from = Date.parse(start)
  const to = Date.parse(end)
  if (Number.isFinite(from) && Number.isFinite(to) && from <= to) return [from, to]
}

function duration(range: Interval | undefined): number | null { return range ? range[1] - range[0] : null }

export function unionDuration(intervals: Interval[]): number | null {
  if (!intervals.length) return null
  const sorted = [...intervals].sort((left, right) => left[0] - right[0])
  let total = 0
  let [from, to] = sorted[0]
  for (const [start, end] of sorted.slice(1)) {
    if (start > to) {
      total += to - from
      from = start
    }
    to = Math.max(to, end)
  }
  return total + to - from
}

function makeSpan(event: TelemetryEvent, id: string, kind: TraceSpan['kind'], name: string): TraceSpan {
  return { id, kind, name, start: event.occurredAt, durationMs: null, agentRunId: event.agentRunId,
    agentId: event.agentId, taskNodeId: event.taskNodeId, taskAttemptId: event.taskAttemptId,
    correlationId: event.correlationId, parentAgentRunId: event.parentAgentRunId, eventIds: [event.id], detail: {} }
}

function finishSpan(span: TraceSpan, event: TelemetryEvent, measure = true): void {
  span.end = event.occurredAt
  span.durationMs = measure ? duration(interval(span.start, span.end)) : null
  span.status = text(event.payload.status)
  span.eventIds.push(event.id)
}

const tokenKeys = ['input', 'output', 'cacheRead', 'cacheWrite'] as const

export function providerUsage(payload: Record<string, unknown>): Record<typeof tokenKeys[number], number> | undefined {
  const [input, output, cacheRead, cacheWrite] = tokenKeys.map(key => quantity(payload[key]))
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return
  if (![input, output, cacheRead, cacheWrite].every(Number.isSafeInteger)) return
  return { input, output, cacheRead, cacheWrite }
}

function projectSpans(events: TelemetryEvent[]) {
  const agents = new Map<string, TraceSpan>()
  const tools = new Map<string, TraceSpan>()
  const models = new Map<string, TraceSpan>()
  const delegation = new Map<string, TraceSpan>()
  const pending = new Map<string, Set<string>>()
  const routeByRun = new Map<string, ModelRoute>()
  let completedReservation: { event: TelemetryEvent; span: TraceSpan } | undefined
  let unpairedEvents = 0
  let activeAgents = 0
  let peakAgents = 0
  for (const event of events) {
    const { agentRunId, taskAttemptId, correlationId, payload, type } = event
    const receipt = text(payload.id)
    const route = modelRoute(payload.route)
    if (type === 'agent.started' && agentRunId && !agents.has(agentRunId)) {
      const role = text(payload.role)
      const span = makeSpan(event, agentRunId, 'agent', role ?? 'Agent')
      span.model = route
      span.detail = { role, agentId: event.agentId, lifecycle: payload.lifecycle }
      agents.set(agentRunId, span)
      if (route) routeByRun.set(agentRunId, route)
      peakAgents = Math.max(peakAgents, ++activeAgents)
    } else if (type === 'agent.finished') {
      const span = agentRunId ? agents.get(agentRunId) : undefined
      if (!span || span.end) { unpairedEvents++; continue }
      finishSpan(span, event, payload.reason !== 'process_interrupted')
      span.detail = { ...span.detail, lifecycle: payload.lifecycle, reason: payload.reason, evidenceCount: payload.evidenceCount }
      activeAgents--
    } else if (type === 'model.route_changed' && agentRunId && route) {
      routeByRun.set(agentRunId, route)
    } else if (type === 'tool.started' && receipt && !tools.has(receipt)) {
      const span = makeSpan(event, receipt, 'tool', text(payload.tool) ?? 'Tool')
      span.detail = { effect: payload.effect, managed: payload.managed }
      tools.set(receipt, span)
    } else if (type === 'tool.finished') {
      const span = receipt ? tools.get(receipt) : undefined
      if (!span || span.end) { unpairedEvents++; continue }
      finishSpan(span, event)
      if (payload.reason !== undefined) span.detail.reason = payload.reason
      if (Array.isArray(payload.targetDigests)) span.detail.targetDigests = payload.targetDigests
    } else if (type === 'task.node_started' && taskAttemptId && !delegation.has(taskAttemptId)) {
      const span = makeSpan(event, taskAttemptId, 'delegation', text(payload.role) ?? 'Delegation')
      span.detail = { role: payload.role, parentNodeId: payload.parentNodeId }
      delegation.set(taskAttemptId, span)
    } else if (type === 'task.node_settled' || type === 'task.worker_settled') {
      const span = taskAttemptId ? delegation.get(taskAttemptId) : undefined
      if (!span || span.end) { unpairedEvents++; continue }
      finishSpan(span, event)
      span.detail = { ...span.detail, attemptStatus: payload.attemptStatus, executionStatus: payload.executionStatus,
        verification: payload.verification, evidenceRefs: payload.evidenceRefs }
    } else if (type === 'model.reserved' && correlationId && !models.has(correlationId)) {
      const span = makeSpan(event, correlationId, 'model', text(payload.kind) ?? 'Model request')
      span.model = route
      span.detail = { kind: payload.kind, estimatedTokens: quantity(payload.estimatedTokens),
        estimatedInputTokens: quantity(payload.estimatedInputTokens), maxOutputTokens: quantity(payload.maxOutputTokens),
        taskTokenLimit: quantity(payload.taskTokenLimit),
        role: agentRunId ? agents.get(agentRunId)?.detail.role : undefined, reservedAt: event.occurredAt }
      models.set(correlationId, span)
      if (agentRunId) {
        const reservations = pending.get(agentRunId) ?? new Set<string>()
        reservations.add(correlationId)
        pending.set(agentRunId, reservations)
      }
    } else if (type === 'model.request_started') {
      const reservations = agentRunId ? pending.get(agentRunId) : undefined
      const reservation = reservations?.size === 1 ? reservations.values().next().value : undefined
      const span = reservation ? models.get(reservation) : undefined
      if (!span || span.detail.requestStarted) { unpairedEvents++; continue }
      span.start = event.occurredAt
      span.detail.requestStarted = true
      span.eventIds.push(event.id)
    } else if (type === 'model.reservation_settled') {
      const span = correlationId ? models.get(correlationId) : undefined
      if (!span || span.end) { unpairedEvents++; continue }
      const settled = payload.status === 'settled'
      finishSpan(span, event, settled && span.detail.requestStarted === true)
      if (settled) span.detail.reservationDurationMs = quantity(payload.durationMs)
      span.detail.actualTokens = quantity(payload.actualTokens)
      span.detail.estimatedCostUsd = quantity(payload.estimatedCostUsd) ?? span.detail.estimatedCostUsd
      if (agentRunId && correlationId) pending.get(agentRunId)?.delete(correlationId)
      completedReservation = { event, span }
    } else if (type === 'model.usage') {
      const previous = completedReservation
      const usage = providerUsage(payload)
      const exact = correlationId ? models.get(correlationId) : undefined
      const immediate = previous && previous.event.seq + 1 === event.seq && previous.event.taskAttemptId === taskAttemptId
        ? previous.span : undefined
      const span = exact ?? immediate
      const total = usage && Object.values(usage).reduce((sum, value) => sum + value, 0)
      if (span && agentRunId && span.agentRunId === agentRunId && usage && span.detail.input === undefined &&
        span.taskAttemptId === taskAttemptId &&
        (span.detail.actualTokens === total || (span === exact && !span.end && span.detail.actualTokens === undefined))) {
        Object.assign(span.detail, usage)
        span.detail.estimatedCostUsd ??= quantity(payload.estimatedCostUsd)
        span.eventIds.push(event.id)
        if (exact && correlationId) pending.get(agentRunId)?.delete(correlationId)
      } else {
        unpairedEvents++
        const span = makeSpan(event, event.id, 'model', 'Unpaired model usage')
        span.end = event.occurredAt
        span.status = 'unpaired'
        // Historical usage without a reservation may lack a trustworthy route after a switch.
        span.detail = { ...usage, observedRoute: agentRunId ? routeByRun.get(agentRunId) : undefined,
          role: agentRunId ? agents.get(agentRunId)?.detail.role : undefined,
          estimatedCostUsd: quantity(payload.estimatedCostUsd) }
        models.set(event.id, span)
      }
    }
  }
  const reservations = [...models.values()].filter(span => span.status !== 'unpaired')
  const reservedByRun = new Set(reservations.map(span => span.agentRunId))
  for (const span of models.values()) {
    if (span.status === 'unpaired') span.detail.possibleReservation = span.agentRunId
      ? reservedByRun.has(span.agentRunId) : reservations.length > 0
  }
  const eventOrder = new Map(events.map(event => [event.id, event.seq]))
  const spans = [...agents.values(), ...models.values(), ...tools.values(), ...delegation.values()]
    .sort((left, right) => left.start.localeCompare(right.start) || eventOrder.get(left.eventIds[0])! - eventOrder.get(right.eventIds[0])!)
  return { spans, agents: spans.filter(span => span.kind === 'agent'), unpairedEvents, peakAgents }
}

export function peakConfirmedAgents(agents: TraceSpan[]): number {
  // Intervals are half-open. Separate task streams cannot order starts and finishes in the same millisecond.
  const points = agents.flatMap(span => {
    const range = span.durationMs === null ? undefined : interval(span.start, span.end)
    return range && range[1] > range[0] ? [[range[0], 1], [range[1], -1]] : []
  }).sort(([left, leftSign], [right, rightSign]) => left - right || leftSign - rightSign)
  let active = 0
  let peak = agents.length ? 1 : 0
  for (const [, sign] of points) {
    active += sign
    peak = Math.max(peak, active)
  }
  return peak
}

function projectNodes(task: TelemetryTask, events: TelemetryEvent[]) {
  const planned = new Map<string, string>()
  for (const event of events) {
    if (event.type !== 'task.plan_changed') continue
    const legacy = text(event.payload.workerNodeId)
    const proposed = Array.isArray(event.payload.nodes) ? event.payload.nodes : []
    for (const id of [legacy, ...proposed.map(node => text(object(node)?.id))]) {
      if (id && !planned.has(id)) planned.set(id, event.occurredAt)
    }
  }
  const attempts = new Map<string, TelemetryTask['attempts']>()
  for (const attempt of task.attempts) {
    const existing = attempts.get(attempt.nodeId) ?? []
    existing.push(attempt)
    attempts.set(attempt.nodeId, existing)
  }
  for (const records of attempts.values()) records.sort((left, right) => left.startedAt.localeCompare(right.startedAt))
  const latest = new Map(task.nodes.flatMap(node => {
    const records = attempts.get(node.id)
    const newest = node.attemptId ? records?.find(attempt => attempt.id === node.attemptId) : records?.at(-1)
    return newest ? [[node.id, newest] as const] : []
  }))
  const wait: Interval[] = []
  const queueWait: Interval[] = []
  const nodes = task.nodes.map((node): TraceNode => {
    const plannedAt = planned.get(node.id)
    const firstStartedAt = attempts.get(node.id)?.[0].startedAt
    const newest = latest.get(node.id)
    const observedWait = interval(plannedAt, firstStartedAt)
    if (observedWait) {
      const dependencies = node.dependencies.map(id => attempts.get(id)?.find(attempt => attempt.status === 'succeeded' &&
        attempt.finishedAt && Date.parse(attempt.finishedAt) <= observedWait[1])?.finishedAt)
      // A replan can change historical dependency readiness. Keep its pre-start wait without attributing a cause.
      if (!node.replans && dependencies.every((end): end is string => end !== undefined && Number.isFinite(Date.parse(end)))) {
        const readyAt = Math.max(observedWait[0], ...dependencies.map(Date.parse))
        wait.push([observedWait[0], readyAt])
        queueWait.push([readyAt, observedWait[1]])
      }
    }
    return { ...node, plannedAt, firstStartedAt, waitMs: duration(observedWait),
      latestDurationMs: newest?.recoveries ? null : duration(interval(newest?.startedAt, newest?.finishedAt)) }
  })
  const critical = dependencyPath(nodes, latest)
  return { nodes, critical, dependencyWaitMs: unionDuration(wait), queueWaitMs: unionDuration(queueWait) }
}

function dependencyPath(nodes: TraceNode[], latest: Map<string, TelemetryTask['attempts'][number]>) {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const paths = new Map<string, { durationMs: number; ids: string[] }>()
  const visiting = new Set<string>()
  const path = (id: string): { durationMs: number; ids: string[] } | undefined => {
    const cached = paths.get(id)
    if (cached) return cached
    const node = byId.get(id)
    const attempt = latest.get(id)
    if (!node || node.latestDurationMs === null || visiting.has(id) || !attempt || attempt.recoveries || attempt.status !== node.status ||
      (node.status !== 'succeeded' && node.status !== 'failed')) return
    visiting.add(id)
    let before = { durationMs: 0, ids: [] as string[] }
    for (const dependency of node.dependencies) {
      const upstream = path(dependency)
      if (!upstream || latest.get(dependency)?.status !== 'succeeded' ||
        !interval(latest.get(dependency)?.finishedAt, attempt.startedAt)) return
      if (!before.ids.length || upstream.durationMs > before.durationMs) before = upstream
    }
    visiting.delete(id)
    const result = { durationMs: node.latestDurationMs + before.durationMs, ids: [...before.ids, id] }
    paths.set(id, result)
    return result
  }
  let longest: ReturnType<typeof path>
  for (const node of nodes) {
    const current = path(node.id)
    if (!current) return { ms: null, ids: [] }
    if (!longest || current.durationMs > longest.durationMs) longest = current
  }
  return { ms: longest?.durationMs ?? null, ids: longest?.ids ?? [] }
}

export interface JudgmentCausalDetail {
  eventId: string
  point: string
  isCore: boolean
  mode: string
  judgeStatus?: string
  judgeModel?: string
  elapsedMs?: number
  fallbackReason?: string
  disagreement?: boolean
  linkedEventIds: string[]
  whatSummary: string
  verdictSummary: string
  impactKind: 'intervened' | 'shadow_diff' | 'fallback' | 'aligned' | 'baseline_only' | 'unconfirmed'
  impactSummary: string
}

const corePointIds = new Set<string>(coreJudgmentPoints.map(({ id }) => id))
const slotLabelNames: Record<string, string> = {
  'page title': '页面标题', 'page content': '页面正文', 'element label': '交互控件',
  'search title': '搜索标题', 'search snippet': '搜索摘要',
  stdout: '标准输出', stderr: '错误输出', fact: '事实', experience: '经验', file: '文件', skill: '技能',
}

function receiptDigest(id: string): string {
  return /^sha256:[0-9a-f]{64}$/u.test(id) ? id : `sha256:${createHash('sha256').update(id).digest('hex')}`
}

function judgmentLinks(task: TelemetryTask, events: TelemetryEvent[]) {
  const plans = new Map<string, TelemetryEvent>()
  const receipts = new Map<string, TelemetryEvent>()
  const replays = new Map<string, TelemetryEvent[]>()
  const settlements = new Map<string, TelemetryEvent>()
  const related = new Map<string, TelemetryEvent[]>()
  const followUps = new Map<string, TelemetryEvent>()
  const verifications: TelemetryEvent[] = []
  const stateChanges: TelemetryEvent[] = []
  for (const event of events) {
    if (event.type === 'task.plan_changed' && event.correlationId) plans.set(event.correlationId, event)
    if (event.type === 'turn.followup_triggered' && event.correlationId) followUps.set(event.correlationId, event)
    if (event.type === 'tool.finished' && typeof event.payload.id === 'string') {
      receipts.set(receiptDigest(event.payload.id), event)
    }
    if (event.type === 'tool.evidence_replayed' && typeof event.payload.id === 'string') {
      const key = receiptDigest(event.payload.id)
      const list = replays.get(key) ?? []
      list.push(event)
      replays.set(key, list)
    }
    if ((event.type === 'task.node_settled' || event.type === 'task.worker_settled') && event.taskNodeId && event.taskAttemptId) {
      settlements.set(`${event.taskNodeId}:${event.taskAttemptId}`, event)
    }
    if (event.type === 'verification.finished') verifications.push(event)
    if (event.type === 'task.state_changed') stateChanges.push(event)
    const source = event.type === 'judgment.evaluated' ? text(event.payload.id) : event.type
    if (event.agentRunId && source && ['agent.started', 'model.reserved', 'memory.recalled', 'memory.captured', 'model.task_fit'].includes(source)) {
      const key = `${event.agentRunId}:${source}`
      const group = related.get(key) ?? []
      group.push(event)
      related.set(key, group)
    }
  }
  return events.filter(event => event.type === 'judgment.evaluated').map(event => {
    const link = object(event.payload.resultLink)
    const point = text(event.payload.id)
    const plan = text(link?.planRequestId)
    const receipt = text(link?.delegationReceiptKey)
    const agent = text(link?.agentRunId) ?? event.agentRunId
    const node = text(link?.taskNodeId) ?? event.taskNodeId
    const attempt = text(link?.taskAttemptId) ?? event.taskAttemptId
    const candidates = [plan ? plans.get(plan) : undefined, receipt ? receipts.get(receipt) : undefined]
    if ((point === 'handoff.sufficiency' || point === 'turn.completion' || point === 'swarm.patch') && node && attempt) {
      candidates.push(settlements.get(`${node}:${attempt}`))
    }
    if (point === 'turn.completion' && node === task.rootNodeId) {
      candidates.push(verifications.find(candidate => candidate.seq > event.seq && (!attempt || candidate.taskAttemptId === attempt)))
      candidates.push(stateChanges.find(candidate => candidate.seq > event.seq && (!attempt || candidate.taskAttemptId === attempt)))
    }
    if (point === 'turn.completion' && event.correlationId) {
      const followUp = followUps.get(event.correlationId)
      if (isCompletionFollowUp(event, followUp)) candidates.push(followUp)
    }
    if (agent && point === 'memory.capture') {
      candidates.push((related.get(`${agent}:memory.captured`) ?? []).find(candidate => candidate.seq > event.seq))
    }
    const toolDecision = ['tool.admission', 'tool.injection', 'files.locate'].includes(point ?? '')
    if (toolDecision && Array.isArray(event.payload.evidenceRefs)) {
      for (const key of event.payload.evidenceRefs) {
        if (typeof key !== 'string') continue
        candidates.push(receipts.get(key))
        candidates.push(...(replays.get(key) ?? []))
      }
    }
    if (agent && point === 'model.task_fit') {
      const nextDecision = related.get(`${agent}:model.task_fit`)?.find(candidate => candidate.seq > event.seq)
      const withinDecision = (candidate: TelemetryEvent) => !nextDecision || candidate.seq < nextDecision.seq
      candidates.push(...(related.get(`${agent}:agent.started`) ?? []).filter(withinDecision),
        ...(related.get(`${agent}:model.reserved`) ?? []).filter(withinDecision))
    }
    if (agent && point === 'context.relevance') candidates.push((related.get(`${agent}:memory.recalled`) ?? [])
      .find(candidate => candidate.seq > event.seq))
    const linkedEventIds = [...new Set(candidates.filter((item): item is TelemetryEvent => Boolean(item &&
      item.taskRunId === event.taskRunId && (toolDecision
        ? ((item.seq < event.seq || item.type === 'tool.evidence_replayed') && item.agentRunId === agent)
        : item.seq > event.seq))).map(item => item.id))]
    return { eventId: event.id, point, linkedEventIds }
  })
}

function summarizeBatchSlots(batch: Record<string, unknown> | undefined): string {
  if (!batch || !Array.isArray(batch.labels)) return ''
  const labels = [...new Set(batch.labels.map(item => typeof item === 'string' ? slotLabelNames[item] ?? item : undefined)
    .filter((item): item is string => Boolean(item)))]
  return labels.length ? ` · ${labels.slice(0, 3).join('、')}` : ''
}

function judgmentCausalDetails(events: TelemetryEvent[], links: ReturnType<typeof judgmentLinks>): JudgmentCausalDetail[] {
  const byId = new Map(events.map(event => [event.id, event]))
  return links.map(link => {
    const event = byId.get(link.eventId)!
    const payload = event.payload
    const point = link.point ?? text(payload.id) ?? 'unknown'
    const mode = text(payload.mode) ?? 'off'
    const judgeStatus = text(payload.judgeStatus)
    const judgeModel = text(payload.judgeModel)
    const elapsedMs = quantity(payload.elapsedMs)
    const fallbackReason = text(payload.fallbackReason)
    const features = object(payload.features) ?? {}
    const batch = object(payload.batch)
    const baseArr = Array.isArray(batch?.baseline) ? batch.baseline.map(v => v === true) : undefined
    const outArr = Array.isArray(batch?.output) ? batch.output.map(v => v === true) : undefined
    const judgeArr = Array.isArray(batch?.judgeOutput) ? batch.judgeOutput : undefined
    const disagree = payload.disagreement === true ||
      (baseArr && outArr ? baseArr.some((val, idx) => val !== outArr[idx]) : payload.output !== payload.baseline)
    const linked = link.linkedEventIds.map(id => byId.get(id)).filter((item): item is TelemetryEvent => Boolean(item))

    let impactKind: JudgmentCausalDetail['impactKind']
    if (mode === 'off' || judgeStatus === 'baseline') impactKind = 'baseline_only'
    else if (judgeStatus && judgeStatus !== 'valid') impactKind = 'fallback'
    else if (mode === 'active' && disagree) impactKind = 'intervened'
    else if (mode === 'shadow' && disagree) impactKind = 'shadow_diff'
    else impactKind = 'aligned'

    const slots = summarizeBatchSlots(batch)
    const bytes = quantity(features.bytes)
    const byteNote = bytes !== undefined ? ` (${bytes} B${slots})` : slots
    const batchLen = outArr?.length ?? baseArr?.length ?? quantity(features.candidateCount) ?? 0
    let whatSummary = `评估 ${point}`
    let verdictSummary = ''
    let impactSummary = ''

    if (point === 'tool.injection') {
      const toolName = text(features.tool) ?? '工具输出'
      whatSummary = `扫描 ${toolName} 文本安全 · ${batchLen} 段${byteNote}`
      const baseBlocks = baseArr?.filter(Boolean).length ?? 0
      const outBlocks = outArr?.filter(Boolean).length ?? 0
      const judgeBlocks = judgeArr?.filter(v => v === true).length ?? 0
      verdictSummary = `基线拦 ${baseBlocks}/${batchLen} → 实际拦 ${outBlocks}/${batchLen}${judgeArr ? ` (Jev 判 ${judgeBlocks})` : ''}`
      if (mode === 'active' && outBlocks > baseBlocks) impactSummary = `已额外隔离 ${outBlocks - baseBlocks} 段可疑指令注入（禁止模型直读，需经审核或保留隔离）`
      else if (outBlocks > 0) impactSummary = `规则基线已隔离 ${outBlocks} 段已知注入文本`
      else if (impactKind === 'shadow_diff') impactSummary = `Shadow 检出 ${judgeBlocks} 段疑似注入（当前仅观察未拦截）`
      else if (impactKind === 'fallback') impactSummary = `回退规则基线放行（原因: ${fallbackReason ?? judgeStatus}）`
      else impactSummary = '未发现注入威胁，原文放行进入上下文'
    } else if (point === 'tool.admission') {
      const toolName = text(features.tool) ?? '外部工具'
      whatSummary = `筛选 ${toolName} 长输出片段 · ${batchLen} 段${byteNote}`
      const outKeep = outArr?.filter(Boolean).length ?? 0
      const omitted = batchLen - outKeep
      const judgeOmit = judgeArr?.filter(v => v === false).length ?? 0
      const replayed = linked.some(item => item.type === 'tool.evidence_replayed')
      verdictSummary = `保留 ${outKeep}/${batchLen} 段 · 折叠 ${omitted} 段${judgeArr ? ` (Jev 建议折叠 ${judgeOmit})` : ''}`
      if (mode === 'active' && omitted > 0) impactSummary = `已折叠 ${omitted} 段低相关片段并归档原文${replayed ? '；模型随后调用 read_tool_evidence 按需回放了完整证据' : '（节省首轮上下文空间）'}`
      else if (impactKind === 'shadow_diff') impactSummary = `Shadow 认为可折叠 ${judgeOmit} 段（未生效）`
      else if (impactKind === 'fallback') impactSummary = `回退基线全量保留（原因: ${fallbackReason ?? judgeStatus}）`
      else impactSummary = '保留全部片段进入模型上下文'
    } else if (point === 'turn.completion') {
      const role = text(features.role) ?? 'root'
      const writeCount = quantity(features.writeCount) ?? 0
      const evidenceCount = quantity(features.evidenceCount) ?? 0
      whatSummary = `审查 ${role} 回合交付完整性（写入 ${writeCount} 次 · 验后证据 ${evidenceCount}）`
      const out = payload.output === true
      const base = payload.baseline === true
      const judge = payload.judgeOutput === true || payload.shadow === true
      verdictSummary = `基线=${base ? '不足' : '放行'} → 实际=${out ? '要求补做' : '放行'}${payload.judgeOutput !== undefined || payload.shadow !== undefined ? ` (Jev=${judge ? '不足' : '放行'})` : ''}`
      const followUpTriggered = linked.some(item => item.type === 'turn.followup_triggered')
      if (followUpTriggered) {
        impactKind = 'intervened'
        impactSummary = '判定未收尾，已拦截结束并触发补充自检轮次'
      } else if (mode === 'active' && out && impactKind !== 'fallback') {
        impactKind = 'unconfirmed'
        impactSummary = '建议补充自检，未记录到由此判定触发的续跑'
      }
      else if (impactKind === 'shadow_diff') impactSummary = 'Shadow 认为证据尚不充分（仅记录未拦截）'
      else if (impactKind === 'fallback') impactSummary = `回退规则基线放行（原因: ${fallbackReason ?? judgeStatus}）`
      else impactSummary = '允许当前回合正常收尾'
    } else if (point === 'swarm.patch') {
      const writeCount = quantity(features.writeCount) ?? 0
      const targetCount = quantity(features.targetCount) ?? 0
      whatSummary = `审查子 Agent 补丁范围（写入 ${writeCount} 次 · 涉及 ${targetCount} 处路径）`
      const out = payload.output === true
      const judge = payload.judgeOutput === true || payload.shadow === true
      verdictSummary = `实际=${out ? '标记越界复核' : '范围合规'}${payload.judgeOutput !== undefined || payload.shadow !== undefined ? ` (Jev=${judge ? '越界' : '合规'})` : ''}`
      if (mode === 'active' && out) impactSummary = '已标注 patch_scope_review 风险并在子 Agent 摘要附上待复核路径提示'
      else if (impactKind === 'shadow_diff') impactSummary = 'Shadow 怀疑存在范围外改动（未标记）'
      else impactSummary = '变更范围符合委派约束，直接交付'
    } else if (point === 'model.task_fit') {
      const candidates = Array.isArray(features.candidates) ? features.candidates.length : 0
      whatSummary = `对比 ${candidates} 个候选模型与当前任务适配度`
      verdictSummary = `基线 #${String(payload.baseline ?? 0)} → 实际 #${String(payload.output ?? 0)}${payload.judgeOutput !== undefined ? ` (Jev #${String(payload.judgeOutput)})` : ''}`
      const chosenRoute = linked.map(item => modelRoute(item.payload.route)).find(Boolean)
      if (mode === 'active' && disagree) impactSummary = chosenRoute ? `已切换更适配路由 ${chosenRoute.provider}/${chosenRoute.model}` : `已切换至候选模型 #${String(payload.output)}`
      else if (impactKind === 'shadow_diff') impactSummary = `Shadow 倾向候选 #${String(payload.shadow ?? payload.judgeOutput)}（未切换）`
      else impactSummary = chosenRoute ? `沿用基线模型 ${chosenRoute.provider}/${chosenRoute.model}` : '沿用规则基线选型'
    } else if (point === 'memory.capture') {
      const facts = quantity(features.factCount)
      const exps = quantity(features.experienceCount)
      const countNote = facts !== undefined || exps !== undefined ? `（事实 ${facts ?? 0} / 经验 ${exps ?? 0}）` : ''
      whatSummary = `筛选长期记忆候选 · ${batchLen} 条${countNote}`
      const outKeep = outArr?.filter(Boolean).length ?? 0
      const dropped = batchLen - outKeep
      const capturedEvent = linked.find(item => item.type === 'memory.captured')
      const persisted = capturedEvent ? quantity(capturedEvent.payload.count) : undefined
      verdictSummary = `保留 ${outKeep}/${batchLen} 条（过滤 ${dropped} 条）`
      if (mode === 'active' && dropped > 0) impactSummary = `已拦截 ${dropped} 条低价值记忆，实际落库 ${persisted ?? outKeep} 条`
      else if (impactKind === 'shadow_diff') impactSummary = `Shadow 建议丢弃 ${judgeArr?.filter(v => v === false).length ?? 0} 条（当前全留）`
      else impactSummary = `全部保留，实际落库 ${persisted ?? outKeep} 条`
    } else {
      verdictSummary = batch ? `基线 ${baseArr?.filter(Boolean).length ?? 0}/${batchLen} → 实际 ${outArr?.filter(Boolean).length ?? 0}/${batchLen}`
        : `基线 ${String(payload.baseline ?? '—')} → 实际 ${String(payload.output ?? '—')}`
      impactSummary = impactKind === 'intervened' ? 'Active 模式改写了规则基线决策'
        : impactKind === 'shadow_diff' ? 'Shadow 与规则基线存在分歧（未改写）'
          : impactKind === 'fallback' ? `Judge 异常回退至基线（${fallbackReason ?? judgeStatus}）`
            : '与规则基线决策一致'
    }

    return {
      eventId: event.id,
      point,
      isCore: corePointIds.has(point),
      mode,
      judgeStatus,
      judgeModel,
      elapsedMs,
      fallbackReason,
      disagreement: disagree,
      linkedEventIds: link.linkedEventIds,
      whatSummary,
      verdictSummary,
      impactKind,
      impactSummary,
    }
  })
}

export function buildTrace(task: TelemetryTask, input: TelemetryEvent[], asOf = Date.now()) {
  const ids = new Map<string, number>()
  const sequences = new Map<number, string>()
  let contiguousCursor = 0
  let sequenceConflicts = 0
  const events = input.filter(event => event.taskId === task.id && (!event.taskRunId || event.taskRunId === task.taskRunId) &&
    Number.isSafeInteger(event.seq) && event.seq > 0).sort((left, right) => left.seq - right.seq).filter(event => {
    if (ids.has(event.id) || sequences.has(event.seq)) {
      if (ids.get(event.id) !== event.seq || sequences.get(event.seq) !== event.id) sequenceConflicts++
      return false
    }
    ids.set(event.id, event.seq)
    sequences.set(event.seq, event.id)
    if (event.seq === contiguousCursor + 1) contiguousCursor++
    return true
  })
  const cursor = Math.max(task.cursor, events.at(-1)?.seq ?? 0)
  const complete = contiguousCursor === cursor && sequenceConflicts === 0
  const { spans, agents, unpairedEvents, peakAgents } = projectSpans(events)
  const { nodes, critical, dependencyWaitMs, queueWaitMs } = projectNodes(task, events)
  const nodeRoles = new Map<string, string | undefined>(nodes.map(node => [node.id, node.role]))
  nodeRoles.set(task.rootNodeId, 'root')
  for (const span of spans) if (span.taskNodeId) span.detail.role ??= nodeRoles.get(span.taskNodeId)
  const createdAt = events.find(event => event.type === 'task.created')?.occurredAt
  const terminalAt = terminal.has(task.status) ? events.findLast(event =>
    (event.type === 'task.state_changed' || event.type === 'task.stopped') && event.payload.status === task.status)?.occurredAt : undefined
  const measured = (kind: TraceSpan['kind']) => spans.filter(span => span.kind === kind && span.durationMs !== null &&
    (kind !== 'model' || span.detail.requestStarted === true))
    .flatMap(span => {
      const range = interval(span.start, span.end)
      return range ? [range] : []
    })
  const modelIntervals = measured('model')
  const agentIntervals = measured('agent')
  const sum = (kind: TraceSpan['kind']) => {
    const durations = spans.filter(span => span.kind === kind && span.durationMs !== null).map(span => span.durationMs!)
    return durations.length ? durations.reduce((total, duration) => total + duration, 0) : null
  }
  const judgments = judgmentLinks(task, events)
  const judgmentDetails = judgmentCausalDetails(events, judgments)
  return {
    task, events, spans, agents, nodes, judgments, judgmentDetails,
    timing: {
      wallClockMs: duration(interval(createdAt, terminalAt)),
      liveWallClockMs: terminal.has(task.status) || !createdAt ? null : Math.max(0, asOf - Date.parse(createdAt)),
      modelRequestMs: sum('model'), modelWallMs: unionDuration(modelIntervals),
      agentActivityMs: unionDuration(agentIntervals), agentRunMs: sum('agent'), dependencyWaitMs, queueWaitMs,
      criticalPathMs: critical.ms, criticalPath: critical.ids, peakAgents: complete ? peakAgents : peakConfirmedAgents(agents),
    },
    coverage: {
      eventCount: events.length, cursor, contiguousCursor, missingEvents: cursor - events.length,
      complete, sequenceConflicts,
      openSpans: spans.filter(span => !span.end).length, unpairedEvents,
    },
  }
}

export type TaskTrace = ReturnType<typeof buildTrace>
