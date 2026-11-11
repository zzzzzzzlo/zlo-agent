import { createHash } from 'node:crypto'
import type { ModelRoute } from '../../shared/contracts/domain.ts'
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

function judgmentLinks(events: TelemetryEvent[]) {
  const plans = new Map<string, TelemetryEvent>()
  const receipts = new Map<string, TelemetryEvent>()
  const settlements = new Map<string, TelemetryEvent>()
  const related = new Map<string, TelemetryEvent[]>()
  for (const event of events) {
    if (event.type === 'task.plan_changed' && event.correlationId) plans.set(event.correlationId, event)
    if (event.type === 'tool.finished' && typeof event.payload.id === 'string') {
      const id = event.payload.id
      const receiptKey = /^sha256:[0-9a-f]{64}$/u.test(id) ? id : `sha256:${createHash('sha256').update(id).digest('hex')}`
      receipts.set(receiptKey, event)
    }
    if ((event.type === 'task.node_settled' || event.type === 'task.worker_settled') && event.taskNodeId && event.taskAttemptId) {
      settlements.set(`${event.taskNodeId}:${event.taskAttemptId}`, event)
    }
    const source = event.type === 'judgment.evaluated' ? text(event.payload.id) : event.type
    if (event.agentRunId && source && ['agent.started', 'model.reserved', 'memory.recalled', 'model.task_fit'].includes(source)) {
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
    if (point === 'handoff.sufficiency' && node && attempt) candidates.push(settlements.get(`${node}:${attempt}`))
    if (agent && point === 'model.task_fit') {
      const nextDecision = related.get(`${agent}:model.task_fit`)?.find(candidate => candidate.seq > event.seq)
      const withinDecision = (candidate: TelemetryEvent) => !nextDecision || candidate.seq < nextDecision.seq
      candidates.push(...(related.get(`${agent}:agent.started`) ?? []).filter(withinDecision),
        ...(related.get(`${agent}:model.reserved`) ?? []).filter(withinDecision))
    }
    if (agent && point === 'context.relevance') candidates.push((related.get(`${agent}:memory.recalled`) ?? [])
      .find(candidate => candidate.seq > event.seq))
    const linkedEventIds = [...new Set(candidates.filter((item): item is TelemetryEvent => Boolean(item &&
      item.taskRunId === event.taskRunId && item.seq > event.seq)).map(item => item.id))]
    return { eventId: event.id, point, linkedEventIds }
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
  return {
    task, events, spans, agents, nodes, judgments: judgmentLinks(events),
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
