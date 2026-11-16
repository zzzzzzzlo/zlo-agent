import { resolveUsdToCnyRate, usdToCny } from '../../shared/contracts/currency.ts'
import type { ModelRoute } from '../../shared/contracts/domain.ts'
import type { TelemetryEvent, TelemetryTask } from '../../shared/contracts/observatory.ts'
import { coreJudgmentPoints } from '../../shared/contracts/jev.ts'
import type { EvaluationJob } from './database.ts'
import type { EvaluationResult } from './evaluation.ts'
import { buildTrace, object, peakConfirmedAgents, providerUsage, quantity, text, unionDuration } from './trace.ts'
import type { TaskTrace, TraceSpan } from './trace.ts'

export interface Metric {
  id: string
  label: string
  value: number | null
  unit: 'count' | 'ms' | 'tokens' | 'CNY' | 'USD' | 'percent' | 'bytes' | 'ratio' | 'score'
  quality: 'measured' | 'estimated' | 'unknown' | 'not_applicable'
  description: string
  samples?: number
  population?: number
}

export interface MetricOptions {
  usdToCnyRate?: number
  evaluations?: EvaluationJob[]
}

interface MetricGroup {
  key: string
  label: string
  metrics: Metric[]
  provider?: string
  model?: string
  role?: string
  point?: string
  mode?: string
  featureSchemaVersion?: number
  references: { taskId: string; eventId: string }[]
}

export interface MetricFilters {
  from?: number
  to?: number
  taskId?: string
  role?: string
  provider?: string
  model?: string
  status?: string
}

type Unit = Metric['unit']
type NumericSample = number | null | undefined

function metric(id: string, label: string, unit: Unit, description: string, value: number | null,
  quality: Metric['quality'], samples?: number, population?: number): Metric {
  return { id, label, value, unit, quality, description, samples, population }
}

function count(id: string, label: string, value: number, description: string, complete = true): Metric {
  const known = complete || value > 0
  return metric(id, label, 'count', description, known ? value : null, known ? 'measured' : 'unknown')
}

function values(id: string, label: string, unit: Unit, inputs: NumericSample[], description: string, {
  aggregate = 'sum', estimated = false, complete = true,
}: { aggregate?: 'sum' | 'mean' | 'max' | 'p95'; estimated?: boolean; complete?: boolean } = {}): Metric {
  const observed = inputs.filter((value): value is number => value != null && Number.isFinite(value))
  if (!observed.length) return metric(id, label, unit, description, null,
    inputs.length || !complete ? 'unknown' : 'not_applicable', 0, inputs.length)
  const total = observed.reduce((sum, value) => sum + value, 0)
  const value = aggregate === 'mean' ? total / observed.length : aggregate === 'max' ? observed.reduce((max, value) => Math.max(max, value))
    : aggregate === 'p95' ? observed.sort((left, right) => left - right)[Math.ceil(observed.length * 0.95) - 1] : total
  return metric(id, label, unit, description, value, estimated ? 'estimated' : 'measured', observed.length, inputs.length)
}

function rate(id: string, label: string, numerator: number, denominator: number, description: string,
  options: boolean | { known?: boolean; estimated?: boolean } = true): Metric {
  const known = typeof options === 'boolean' ? options : (options.known ?? true)
  const estimated = typeof options === 'boolean' ? false : (options.estimated ?? false)
  const quality = !known ? 'unknown' : denominator ? (estimated ? 'estimated' : 'measured') : 'not_applicable'
  return metric(id, label, 'percent', description,
    quality === 'measured' || quality === 'estimated' ? 100 * numerator / denominator : null,
    quality, numerator, denominator)
}

function cnyValues(id: string, label: string, usdInputs: NumericSample[], description: string, rateValue: number,
  options: { complete?: boolean } = {}): Metric {
  const converted = usdInputs.map(sample => sample == null || !Number.isFinite(sample) ? sample : usdToCny(sample, rateValue))
  return values(id, label, 'CNY', converted, description, { complete: options.complete, estimated: true })
}

function absent(id: string, label: string, unit: Unit, description: string): Metric {
  return metric(id, label, unit, description, null, 'unknown')
}

function occurrences(events: TelemetryEvent[], type: string): TelemetryEvent[] { return events.filter(event => event.type === type) }

function matchesAttribution(filters: MetricFilters, role: unknown, route: ModelRoute | undefined): boolean {
  return (!filters.role || role === filters.role) && (!filters.provider || route?.provider === filters.provider) &&
    (!filters.model || route?.model === filters.model)
}

function within(value: string, filters: MetricFilters): boolean {
  if (filters.from === undefined && filters.to === undefined) return true
  const time = Date.parse(value)
  return (filters.from === undefined || time >= filters.from) && (filters.to === undefined || time <= filters.to)
}

interface Selection { trace: TaskTrace; events: TelemetryEvent[]; spans: TraceSpan[] }

function select(trace: TaskTrace, filters: MetricFilters): Selection | undefined {
  const agentRoles = new Map(trace.agents.map(agent => [agent.agentRunId, agent.detail.role]))
  const nodes = new Map(trace.nodes.map(node => [node.id, node]))
  const models = new Map<string, TraceSpan>()
  for (const span of trace.spans) {
    if (span.kind !== 'model') continue
    for (const id of span.eventIds) models.set(id, span)
  }
  const startRoutes = new Map<string, ModelRoute>()
  const routeByEvent = new Map<string, ModelRoute>()
  const events = trace.events.filter(event => {
    const role = (event.agentRunId ? agentRoles.get(event.agentRunId) : undefined) ??
      (event.taskNodeId === trace.task.rootNodeId ? 'root' : event.taskNodeId ? nodes.get(event.taskNodeId)?.role : undefined)
    const model = models.get(event.id)
    const route = object(event.payload.route)
    if (event.agentRunId && (event.type === 'agent.started' || event.type === 'model.route_changed') &&
      typeof route?.provider === 'string' && typeof route.model === 'string') {
      startRoutes.set(event.agentRunId, { provider: route.provider, model: route.model })
    }
    const attributedRoute = model ? model.model : event.agentRunId ? startRoutes.get(event.agentRunId) : undefined
    if (attributedRoute) routeByEvent.set(event.id, attributedRoute)
    return within(event.occurredAt, filters) && matchesAttribution(filters, role, attributedRoute)
  })
  const spans = trace.spans.filter(span => {
    const role = span.detail.role ?? (span.agentRunId ? agentRoles.get(span.agentRunId) : undefined)
    const route = span.model ?? (span.kind === 'model' ? undefined : routeByEvent.get(span.eventIds[0]))
    return within(span.start, filters) && matchesAttribution(filters, role, route)
  })
  const filtered = filters.from !== undefined || filters.to !== undefined || filters.role || filters.provider || filters.model
  if (filtered && !events.length && !spans.length) return
  return { trace, events, spans }
}

function canonicalModels(spans: TraceSpan[]) {
  const requested = spans.filter(span => span.status !== 'unpaired')
  const historical = spans.filter(span => span.status === 'unpaired' && span.detail.possibleReservation === false)
  return { requested, usage: [...requested, ...historical] }
}

function wallTime(spans: TraceSpan[]): number | null {
  return unionDuration(spans.flatMap(span => {
    if (span.durationMs === null || !span.end || (span.kind === 'model' && span.detail.requestStarted !== true)) return []
    const start = Date.parse(span.start)
    const end = Date.parse(span.end)
    return Number.isFinite(start) && Number.isFinite(end) && start <= end ? [[start, end]] : []
  }))
}

function modelMetrics(spans: TraceSpan[], complete: boolean, usdToCnyRate: number, verifiedTasks?: number): Metric[] {
  const { requested, usage } = canonicalModels(spans)
  const token = (id: string, label: string, key: string) => values(id, label, 'tokens',
    usage.map(span => quantity(span.detail[key])), 'Provider-reported usage for requests with this breakdown.', { complete })
  const inputSum = usage.reduce((sum, span) => sum + (quantity(span.detail.input) ?? 0), 0)
  const cacheReadSum = usage.reduce((sum, span) => sum + (quantity(span.detail.cacheRead) ?? 0), 0)
  const cacheWriteSum = usage.reduce((sum, span) => sum + (quantity(span.detail.cacheWrite) ?? 0), 0)
  const cacheDenominator = inputSum + cacheReadSum + cacheWriteSum
  const pricedCny = usage.flatMap(span => {
    const usd = quantity(span.detail.estimatedCostUsd)
    return usd !== undefined ? [usdToCny(usd, usdToCnyRate)] : []
  })
  const costPerVerified = verifiedTasks === undefined
    ? undefined
    : verifiedTasks === 0
      ? metric('model.cost_per_verified_task', 'Cost per verified task', 'CNY',
        'Estimated CNY spend divided by deterministically verified tasks.', null, complete ? 'not_applicable' : 'unknown', 0, 0)
      : !pricedCny.length
        ? metric('model.cost_per_verified_task', 'Cost per verified task', 'CNY',
          'Estimated CNY spend divided by deterministically verified tasks.', null, 'unknown', 0, requested.length)
        : metric('model.cost_per_verified_task', 'Cost per verified task', 'CNY',
          'Estimated CNY spend divided by deterministically verified tasks; partial pricing coverage retains sample denominator.',
          Number((pricedCny.reduce((sum, v) => sum + v, 0) / verifiedTasks).toFixed(10)), 'estimated', pricedCny.length, requested.length)
  return [
    count('model.requests', 'Model requests', requested.length, 'Recorded budget reservations. Historical unpaired usage is excluded.',
      complete && !spans.some(span => span.status === 'unpaired')),
    values('model.tokens', 'Provider tokens', 'tokens', usage.map(span => {
      const actual = quantity(span.detail.actualTokens)
      const historical = providerUsage(span.detail)
      return actual ?? (historical ? Object.values(historical).reduce((sum, value) => sum + value, 0) : undefined)
    }), 'Settled provider total, or historical usage where no competing settlement exists. Four token components are counted once.', { complete }),
    token('model.input', 'Uncached input', 'input'), token('model.output', 'Output tokens', 'output'),
    token('model.cache_read', 'Cache read tokens', 'cacheRead'), token('model.cache_write', 'Cache write tokens', 'cacheWrite'),
    rate('model.cache_hit_rate', 'Prompt cache hit rate', cacheReadSum, cacheDenominator,
      'Cache read tokens divided by total prompt input tokens (uncached input + cache read + cache write).', complete),
    cnyValues('model.cost', 'Estimated model cost (CNY)', usage.map(span => quantity(span.detail.estimatedCostUsd)),
      `Known catalog estimates converted to CNY at 1 USD ≈ ${usdToCnyRate} CNY. Actual provider billing is unavailable.`,
      usdToCnyRate, { complete }),
    ...(costPerVerified ? [costPerVerified] : []),
    values('model.mean_latency', 'Mean request latency', 'ms', requested.map(span => span.durationMs),
      'Mean elapsed time from model.request_started to confirmed settlement. Unknown settlements are excluded.', { complete, aggregate: 'mean' }),
    values('model.p95_latency', 'P95 request latency', 'ms', requested.map(span => span.durationMs),
      'Nearest-rank P95 of measured request durations.', { complete, aggregate: 'p95' }),
    values('model.mean_reservation', 'Mean reservation elapsed', 'ms', requested.map(span => quantity(span.detail.reservationDurationMs)),
      'Monotonic elapsed time from Host reservation to settlement when instrumented, including dispatch overhead.', { complete, aggregate: 'mean' }),
    values('model.request_work', 'Model request time (sum)', 'ms', requested.map(span => span.durationMs),
      'Sum of measured request durations, including work that ran in parallel.', { complete }),
    values('model.request_wall', 'Model request wall coverage', 'ms', requested.length ? [wallTime(requested)] : [],
      'Union of measured model request intervals. Overlapping requests contribute their shared time once.', { complete }),
    values('model.budget_reserved', 'Reserved token estimates', 'tokens', requested.map(span => quantity(span.detail.estimatedTokens)),
      'Cumulative input-plus-output reservation estimates, including settled requests.', { complete, estimated: true }),
    values('model.output_budget', 'Mean per-request output cap', 'tokens', requested.map(span => quantity(span.detail.maxOutputTokens)),
      'Mean configured max output tokens for requests where Host recorded that cap.', { complete, aggregate: 'mean' }),
    values('model.task_token_limit', 'Historical task Token limit', 'tokens', requested.map(span => quantity(span.detail.taskTokenLimit)),
      'Maximum legacy Host task Token limit recorded in the selected reservations. Current Host tasks have no cumulative Token limit.',
      { complete, aggregate: 'max' }),
    values('model.budget_open', 'Open token estimates', 'tokens', requested.filter(span => !span.end).map(span => quantity(span.detail.estimatedTokens)),
      'Estimated tokens reserved by requests without a settlement.', { complete, estimated: true }),
    values('model.budget_uncertain', 'Uncertain token estimates', 'tokens', requested.filter(span => span.status === 'uncertain')
      .map(span => quantity(span.detail.estimatedTokens)), 'Estimated reservation amounts whose actual usage was unavailable.', { complete, estimated: true }),
    count('model.uncertain_requests', 'Uncertain requests', requested.filter(span => span.status === 'uncertain').length,
      'Reservations closed without confirmed provider usage.', complete),
    count('model.unpaired_usage', 'Unpaired usage records', spans.filter(span => span.status === 'unpaired').length,
      'Provider usage records without a reliable reservation link. Records that might overlap known requests are excluded from token and cost totals.', complete),
    absent('model.quota', 'Provider quota', 'tokens', 'Provider billing and remaining account quota are unavailable.'),
  ]
}

const fileWriteTools = new Set(['create_text_file', 'edit_text_file', 'delete_file', 'apply_patch'])

function cleanPreview(event: TelemetryEvent): boolean | undefined {
  if (event.payload.rendered === false) return false
  const errors = quantity(event.payload.runtimeErrors)
  return event.payload.rendered === true && errors !== undefined ? errors === 0 : undefined
}

function toolMetrics(spans: TraceSpan[], complete: boolean, includeVisual = false, events: TelemetryEvent[] = []): Metric[] {
  const finished = spans.filter(span => span.end)
  const failed = finished.filter(span => span.status === 'failed')
  const unique = new Set<string>()
  let repeats = 0
  for (const span of spans) {
    if (!span.agentRunId) continue
    const key = JSON.stringify([span.agentRunId, span.name])
    if (unique.has(key)) repeats++
    unique.add(key)
  }
  const fileWrites = finished.filter(span => span.status === 'succeeded' && fileWriteTools.has(span.name))
  const allHaveDigests = fileWrites.length > 0 && fileWrites.every(span => Array.isArray(span.detail.targetDigests) && span.detail.targetDigests.length > 0)
  const distinctTargets = allHaveDigests ? new Set(fileWrites.flatMap(span => span.detail.targetDigests as string[])).size : 0
  const editChurn = !fileWrites.length
    ? metric('tool.edit_churn_ratio', 'File edit churn ratio', 'ratio',
      'Succeeded file-write tool calls divided by distinct modified file digests.', null, complete ? 'not_applicable' : 'unknown', 0, 0)
    : !complete || !allHaveDigests || distinctTargets === 0
      ? metric('tool.edit_churn_ratio', 'File edit churn ratio', 'ratio',
        'Target path digests are unavailable for legacy or incomplete streams.', null, 'unknown', 0, fileWrites.length)
      : metric('tool.edit_churn_ratio', 'File edit churn ratio', 'ratio',
        'Succeeded file-write tool calls divided by distinct modified file digests.', Number((fileWrites.length / distinctTargets).toFixed(2)),
        'measured', fileWrites.length, distinctTargets)

  const visualMetrics: Metric[] = []
  if (includeVisual) {
    const byTask = new Map<string, TelemetryEvent[]>()
    for (const event of events) {
      if (event.type !== 'visual.preview_finished') continue
      const list = byTask.get(event.taskId) ?? []
      list.push(event)
      byTask.set(event.taskId, list)
    }
    const firstPreviews = [...byTask.values()].map(list => cleanPreview(list.reduce((first, event) => event.seq < first.seq ? event : first)))
    visualMetrics.push(
      rate('tool.visual_clean_rate', 'Visual first-render clean rate', firstPreviews.filter(value => value === true).length, byTask.size,
        'Visual runs whose first selected preview rendered with a recorded zero runtime errors.', complete && firstPreviews.every(value => value !== undefined)),
      values('tool.visual_mean_rounds', 'Mean visual iterations', 'count', [...byTask.values()].map(list => list.length),
        'Average preview-feedback rounds per visual run.', { complete, aggregate: 'mean' }),
    )
  }

  return [
    count('tool.calls', 'Tool calls', spans.length, 'Started tool receipts, including open managed operations.', complete),
    count('tool.failed', 'Failed tool receipts', failed.length, 'Receipts explicitly settled as failed.', complete),
    rate('tool.failure_rate', 'Tool failure rate', failed.length, finished.length,
      'Failed receipts divided by settled receipts. Interrupted and unknown-effect receipts are visible separately.', complete),
    editChurn,
    ...visualMetrics,
    values('tool.mean_latency', 'Mean tool settlement time', 'ms', spans.map(span => span.durationMs),
      'From receipt start to settlement, including managed processes. May include reporting delay after interruption.', { complete, aggregate: 'mean' }),
    values('tool.p95_latency', 'P95 tool settlement time', 'ms', spans.map(span => span.durationMs),
      'Nearest-rank P95 of observed receipt settlement durations.', { complete, aggregate: 'p95' }),
    count('tool.repeat_name', 'Same-tool re-invocations', repeats,
      'Additional calls to the same tool in an AgentRun. Arguments are excluded, so identical side effects cannot be inferred.', complete),
    count('tool.unknown_effect', 'Unknown tool effects', finished.filter(span => span.status === 'unknown_effect').length,
      'Receipts settled without confirmation of an external side effect.', complete),
    count('tool.interrupted', 'Interrupted tools', finished.filter(span => span.status === 'interrupted').length,
      'Receipts explicitly settled as interrupted.', complete),
    ...[['tool_result_failed', 'Tool-reported failure'], ['tool_exception', 'Tool exception'],
      ['nonzero_exit', 'Nonzero process exit'], ['tool_cancelled', 'Cancellation during a tool call']].map(([reason, label]) =>
      finished.some(span => span.detail.reason !== undefined)
        ? count(`tool.reason.${reason}`, label, finished.filter(span => span.detail.reason === reason).length,
          'Recorded cause. Legacy and unclassified receipts may be missing a cause.', complete)
        : absent(`tool.reason.${reason}`, label, 'count', 'No receipts report a failure category.')),
  ]
}

function judgmentMetrics(events: TelemetryEvent[], complete: boolean, usdToCnyRate: number): Metric[] {
  const shadow = events.filter(({ payload }) => {
    const outcomes = object(payload.batch)?.judgeOutput
    return payload.mode === 'shadow' && (payload.shadow !== undefined ||
      (Array.isArray(outcomes) && outcomes.some(item => typeof item === 'boolean')))
  })
  const shadowDifferent = shadow.filter(({ payload }) => payload.disagreement ?? payload.shadow !== payload.baseline).length
  const fallbacks = events.filter(event => event.payload.mode !== 'off' && event.payload.judgeStatus && event.payload.judgeStatus !== 'baseline' && event.payload.judgeStatus !== 'valid' && event.payload.fallbackReason !== 'no_choice').length
  const activeJudgeAttempts = events.filter(event => event.payload.mode !== 'off' && event.payload.judgeStatus && event.payload.judgeStatus !== 'baseline' && event.payload.fallbackReason !== 'no_choice').length
  const external = events.filter(event => event.payload.requestSent ??
    (event.payload.mode !== 'off' && event.payload.judgeStatus !== 'baseline'))
  const activeEvents = events.filter(event => event.payload.mode === 'active')
  const injectionBlocks = activeEvents.filter(event => event.payload.id === 'tool.injection')
    .reduce((sum, event) => {
      const output = object(event.payload.batch)?.output
      return sum + (Array.isArray(output) ? output.filter(v => v === true).length : 0)
    }, 0)
  const completionFollowUps = activeEvents.filter(event => event.payload.id === 'turn.completion' && event.payload.output === true).length
  const admissionOmissions = activeEvents.filter(event => event.payload.id === 'tool.admission')
    .reduce((sum, event) => {
      const output = object(event.payload.batch)?.output
      return sum + (Array.isArray(output) ? output.filter(v => v === false).length : 0)
    }, 0)
  const memoryFiltered = activeEvents.filter(event => event.payload.id === 'memory.capture')
    .reduce((sum, event) => {
      const output = object(event.payload.batch)?.output
      return sum + (Array.isArray(output) ? output.filter(v => v === false).length : 0)
    }, 0)
  return [
    count('judgment.decisions', 'Judgment decisions', events.length, 'Recorded evaluations across all registered judgment points.', complete),
    rate('judgment.shadow_disagreement', 'Shadow disagreement', shadowDifferent, shadow.length,
      'Shadow results different from the rule baseline, divided by evaluations with a recorded shadow result.', complete),
    rate('judgment.fallback_rate', 'Judge fallback rate', fallbacks, activeJudgeAttempts,
      'Non-baseline Jev evaluations that timed out, failed, returned invalid output, or were throttled.', complete),
    count('judgment.active_changes', 'Active selection changes', events.filter(event => event.payload.mode === 'active' &&
      (event.payload.disagreement ?? event.payload.output !== event.payload.baseline)).length, 'Active selections different from the rule baseline.', complete),
    count('judgment.injection_blocks', 'Prompt injection blocks', injectionBlocks, 'Segments isolated under Active tool.injection policy.', complete),
    count('judgment.completion_followups', 'Premature completion intercepts', completionFollowUps, 'Turns intercepted by Active turn.completion for supplementary work.', complete),
    count('judgment.admission_omissions', 'Low-signal excerpts omitted', admissionOmissions, 'External output segments collapsed under Active tool.admission (retained for replay).', complete),
    count('judgment.memory_filtered', 'Low-value memories filtered', memoryFiltered, 'Memory candidates withheld by Active memory.capture.', complete),
    values('judgment.mean_latency', 'Mean judgment latency', 'ms', events.map(event => quantity(event.payload.elapsedMs)),
      'Mean elapsed time recorded by the Judgment Kernel, including local rules.', { complete, aggregate: 'mean' }),
    cnyValues('judgment.cost', 'Estimated judgment cost (CNY)', external.map(event => quantity(object(event.payload.usage)?.estimatedCostUsd)),
      `Estimated Judge cost converted to CNY at 1 USD ≈ ${usdToCnyRate} CNY. Excludes task and evaluation requests.`,
      usdToCnyRate, { complete }),
    values('judgment.tokens', 'Judgment tokens', 'tokens', external.map(event => {
      const usage = object(event.payload.usage)
      const input = quantity(usage?.input)
      const output = quantity(usage?.output)
      return input === undefined || output === undefined ? undefined : input + output
    }), 'Input and output usage reported by a configured Judge.', { complete }),
  ]
}

function groups<T>(items: T[], keyFor: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const item of items) {
    const key = keyFor(item)
    const group = grouped.get(key) ?? []
    group.push(item)
    grouped.set(key, group)
  }
  return grouped
}

function eventReferences(events: TelemetryEvent[]) {
  return [...events].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt)).slice(0, 8)
    .map(event => ({ taskId: event.taskId, eventId: event.id }))
}

function peakAgents(spans: TraceSpan[], traces: TaskTrace[]): number {
  if (traces.length === 1 && spans.length === traces[0].agents.length) return traces[0].timing.peakAgents
  return peakConfirmedAgents(spans)
}

const terminalStatuses = new Set(['succeeded', 'failed', 'stopped', 'blocked', 'needs_reconciliation'])
const accessLevels: Record<string, number> = { read: 0, write: 1, trusted: 2 }
const overviewIds = [
  'task.runs', 'task.execution_rate', 'task.verified_rate', 'task.first_pass_verified_rate', 'task.self_repair_rate',
  'task.strong_verified_rate', 'task.failure_rate', 'task.steering_rate', 'task.rework_token_share', 'task.wall_clock',
  'dag.nodes', 'dag.node_completion_rate', 'dag.critical_path', 'agents.runs', 'agents.peak', 'agents.parallel_speedup',
  'model.requests', 'model.tokens', 'model.cache_hit_rate', 'model.cost', 'model.cost_per_verified_task', 'model.mean_latency',
  'tool.calls', 'tool.failure_rate', 'tool.edit_churn_ratio', 'tool.unknown_effect',
  'judgment.decisions', 'judgment.shadow_disagreement', 'eval.pass_rate',
]

export function buildMetrics(tasks: TelemetryTask[], input: TelemetryEvent[], asOf = Date.now(), filters: MetricFilters = {},
  options: MetricOptions = {}) {
  const usdToCnyRate = options.usdToCnyRate && options.usdToCnyRate > 0 ? options.usdToCnyRate : resolveUsdToCnyRate()
  const inputByTask = groups(input, event => event.taskId)
  const selections = tasks.filter(task => (!filters.taskId || filters.taskId === task.id) && (!filters.status || filters.status === task.status))
    .flatMap(task => {
      const selected = select(buildTrace(task, inputByTask.get(task.id) ?? [], asOf), filters)
      return selected ? [selected] : []
    })
  const traces = selections.map(selection => selection.trace)
  const events = selections.flatMap(selection => selection.events)
  const spans = selections.flatMap(selection => selection.spans)
  const modelSpans = spans.filter(span => span.kind === 'model')
  const toolSpans = spans.filter(span => span.kind === 'tool')
  const agentSpans = spans.filter(span => span.kind === 'agent')
  const delegationSpans = spans.filter(span => span.kind === 'delegation')
  const complete = traces.every(trace => trace.coverage.complete)
  const taskRuns = traces.map(trace => trace.task)
  const ended = traces.filter(trace => terminalStatuses.has(trace.task.status))
  const verifying = ended.map(trace => {
    const terminalAttemptId = trace.events.findLast(event => (event.type === 'task.state_changed' || event.type === 'task.stopped') &&
      event.payload.status === trace.task.status)?.taskAttemptId
    const latest = trace.task.attempts.filter(attempt => attempt.nodeId === trace.task.rootNodeId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt)).at(-1)
    const attemptId = terminalAttemptId ?? latest?.id
    const verification = trace.events.findLast(event => event.type === 'verification.finished' &&
      (!attemptId || attemptId === event.taskAttemptId))
    if (verification?.payload.executionStatus === 'completed') return true
    if (trace.task.status === 'succeeded' || trace.task.reason === 'verification_failed' || !trace.coverage.complete) return undefined
    return false
  })
  const verified = ended.filter(({ task }) => task.verification?.verdict === 'verified' && task.verification.passed === true).length
  let firstPassVerified = 0
  let challengedRuns = 0
  let selfRepairedRuns = 0
  let rigorCommand = 0
  let rigorVisual = 0
  let rigorPath = 0
  const supersededAttemptsByTask = new Map<string, Set<string>>()
  for (const trace of ended) {
    const passed = trace.task.verification?.verdict === 'verified' && trace.task.verification.passed === true
    const hasSteerOrResume = trace.events.some(event =>
      event.type === 'task.instruction_added' || event.type === 'instruction.applied' || event.type === 'task.resumed')
    const hasStopIntent = trace.events.some(event => event.type === 'task.stop_requested')
    const hasReplans = trace.nodes.some(node => (node.replans ?? 0) > 0)
    const hadToolFailure = trace.spans.some(span => span.kind === 'tool' && span.status === 'failed')
    const hadOutputRecovery = trace.events.some(event => event.type === 'model.output_recovery')
    const hadInternalRetry = trace.task.attemptCount > 1 && !trace.events.some(event => event.type === 'task.resumed')
    if (passed && trace.task.attemptCount === 1 && !hasReplans && !hasSteerOrResume && !hasStopIntent) firstPassVerified++
    if ((hadToolFailure || hadOutputRecovery || hadInternalRetry || hasReplans) && !hasSteerOrResume) {
      challengedRuns++
      if (passed) selfRepairedRuns++
    }
    if (passed) {
      const hasCleanVisual = trace.events.some(event => event.type === 'visual.preview_finished' && cleanPreview(event) === true)
      if (trace.task.verification?.basis === 'project_command') rigorCommand++
      else if (hasCleanVisual) rigorVisual++
      else rigorPath++
    }
  }
  for (const trace of traces) {
    const winners = new Set<string>()
    const losers = new Set<string>()
    const rootLatest = trace.task.attempts.filter(attempt => attempt.nodeId === trace.task.rootNodeId)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt)).at(-1)
    if (trace.task.status === 'succeeded' && rootLatest?.status === 'succeeded') winners.add(rootLatest.id)
    for (const node of trace.task.nodes) {
      if (node.status === 'succeeded' && node.attemptId) winners.add(node.attemptId)
    }
    for (const attempt of trace.task.attempts) {
      if (!winners.has(attempt.id) && attempt.status !== 'running' &&
        (attempt.status === 'failed' || attempt.status === 'interrupted' || attempt.status === 'unknown_effect' || terminalStatuses.has(trace.task.status))) {
        losers.add(attempt.id)
      }
    }
    supersededAttemptsByTask.set(trace.task.id, losers)
  }
  const steeredRuns = traces.filter(trace => trace.events.some(event =>
    event.type === 'task.instruction_added' || event.type === 'instruction.applied' ||
    event.type === 'task.resumed' || event.type === 'task.stop_requested')).length
  const canonicalUsageSpans = canonicalModels(modelSpans).usage
  let attributedTokens = 0
  let reworkTokens = 0
  let reworkKnown = complete
  const eventTaskById = new Map(input.map(event => [event.id, event.taskId]))
  for (const span of canonicalUsageSpans) {
    const actual = quantity(span.detail.actualTokens)
    const historical = providerUsage(span.detail)
    const total = actual ?? (historical ? Object.values(historical).reduce((sum, value) => sum + value, 0) : undefined)
    if (total === undefined) continue
    const taskIdForSpan = span.eventIds.length ? eventTaskById.get(span.eventIds[0]) : undefined
    if (!span.taskAttemptId || !taskIdForSpan) { reworkKnown = false; continue }
    attributedTokens += total
    if (supersededAttemptsByTask.get(taskIdForSpan)?.has(span.taskAttemptId)) reworkTokens += total
  }
  const observed = (id: string, label: string, type: string, description: string) =>
    count(id, label, occurrences(events, type).length, description, complete)
  const durations = (id: string, label: string, input: NumericSample[], description: string) =>
    values(id, label, 'ms', input, description, { complete, aggregate: 'mean' })
  const counts = (id: string, label: string, input: NumericSample[], description: string) =>
    values(id, label, 'count', input, description, { complete })
  const nodes = traces.flatMap(trace => trace.nodes)
  const succeededNodes = nodes.filter(node => node.status === 'succeeded').length
  const totalAgentWorkMs = agentSpans.reduce((sum, span) => sum + (span.durationMs ?? 0), 0)
  const totalAgentWallMs = selections.reduce((sum, selection) => sum + (wallTime(selection.spans.filter(span => span.kind === 'agent')) ?? 0), 0)
  const agentSpeedupKnown = complete && !agentSpans.some(span => !span.end || span.durationMs === null)
  const parallelSpeedup = !agentSpans.length
    ? metric('agents.parallel_speedup', 'Agent lifecycle overlap ratio', 'ratio',
      'Sum of agent lifecycle durations divided by union wall-clock coverage across runs.', null,
      complete ? 'not_applicable' : 'unknown', 0, 0)
    : !agentSpeedupKnown || totalAgentWallMs <= 0
      ? metric('agents.parallel_speedup', 'Agent lifecycle overlap ratio', 'ratio',
        'Sum of agent lifecycle durations divided by union wall-clock coverage across runs.', null, 'unknown', 0, agentSpans.length)
      : metric('agents.parallel_speedup', 'Agent lifecycle overlap ratio', 'ratio',
        'Summed lifecycle durations divided by their union, including time agents spend waiting.',
        Number((totalAgentWorkMs / totalAgentWallMs).toFixed(2)), 'measured', agentSpans.length, selections.length)

  const selectedTaskRuns = new Map(taskRuns.map(task => [task.id, task.taskRunId]))
  const completedEvaluations = (options.evaluations ?? [])
    .filter(job => job.status === 'completed' && job.result && selectedTaskRuns.get(job.taskId) === job.taskRunId &&
      within(job.createdAt, filters))
  const evalResults = completedEvaluations.map(job => job.result as EvaluationResult)
  const evalUsesModel = evalResults.some(item => item.method === 'model')
  const scoreAxis = (axis: 'completion' | 'correctness' | 'quality', id: string, label: string) =>
    values(id, label, 'score', evalResults.map(item => quantity(item.scores?.[axis]?.score)),
      'Mean 0-5 independent evaluation rubric score (null scores excluded).',
      { complete: true, estimated: true, aggregate: 'mean' })

  const judgment = occurrences(events, 'judgment.evaluated')
  const compactions = occurrences(events, 'context.compacted')
  const contextBuilds = occurrences(events, 'context.built')
  const recalls = occurrences(events, 'memory.recalled')
  const captures = occurrences(events, 'memory.captured')
  const approvals = occurrences(events, 'tool.approval_resolved')
  const permissions = occurrences(events, 'task.permissions_changed')
  const accessChanges = permissions.flatMap(event => {
    const before = text(event.payload.previousAccess)
    const after = text(event.payload.access)
    return before && after && Object.hasOwn(accessLevels, before) && Object.hasOwn(accessLevels, after)
      ? [accessLevels[after] - accessLevels[before]] : []
  })
  const approvedReceipts = new Set(traces.flatMap(trace => occurrences(trace.events, 'tool.approval_resolved'))
    .filter(event => event.payload.approved === true).map(event => text(event.payload.id)))
  const toolDenials = occurrences(events, 'tool.denied')
  const compactionRequests = modelSpans.filter(span => span.detail.kind === 'compaction')
  const operationsWithUnknownEffects = occurrences(events, 'operation.reconciliation_required')
  const failed = ended.filter(trace => trace.task.status === 'failed').length
  const securityApprovalsGranted = approvals.filter(event => event.payload.approved === true).length
  const taskRetries = traces.reduce((sum, trace) => sum + Math.max(0, trace.task.attemptCount - 1), 0)
  const domains: Record<string, Metric[]> = {
    task: [
      count('task.runs', 'Task runs', traces.length, 'Distinct selected TaskRuns from Host snapshots.'),
      rate('task.execution_rate', 'Execution completion rate', verifying.filter(value => value === true).length, ended.length,
        'Runs whose current attempt reached Host verification divided by all runs in an end state. This measures execution, including failed checks.',
        verifying.every(value => value !== undefined)),
      rate('task.failure_rate', 'Task failure rate', failed, ended.length, 'Runs in failed state divided by succeeded, failed, stopped, blocked or reconciliation runs.'),
      rate('task.verified_rate', 'Deterministic verification rate', verified, ended.length,
        'Runs with verified verdict and a passed deterministic check divided by all runs in an end state.'),
      rate('task.first_pass_verified_rate', 'First-pass verified rate', firstPassVerified, ended.length,
        'Ended runs verified deterministically on the initial attempt without replans or user intervention (Pass@1).', complete),
      rate('task.self_repair_rate', 'Autonomous self-repair rate', selfRepairedRuns, challengedRuns,
        'Runs facing tool failures, replans, output recovery, or automatic retries without user steering/resume that recovered to verified.', complete),
      rate('task.steering_rate', 'User intervention rate', steeredRuns, traces.length,
        'Runs receiving user steering instructions, stop intents, or resumes divided by selected runs.', complete),
      rate('task.strong_verified_rate', 'Strong-evidence verified rate', rigorCommand + rigorVisual, ended.length,
        'Verified runs backed by project command execution (T3) or clean visual preview checks (T2).', complete),
      count('task.rigor_command', 'Command-verified runs (T3)', rigorCommand, 'Runs verified by an authorized project command exit code 0.', complete),
      count('task.rigor_visual', 'Visual-verified runs (T2)', rigorVisual, 'Verified runs with clean zero-error browser preview checks.', complete),
      count('task.rigor_path', 'Path-verified runs (T1)', rigorPath, 'Verified runs checked via static file existence/text inspection.', complete),
      count('task.unverified', 'Unverified task runs', ended.filter(({ task }) => task.verification?.verdict === 'unverified').length,
        'Host explicitly recorded unverified. Independent AI evaluations are excluded.'),
      count('task.verification_failed', 'Failed deterministic checks', ended.filter(({ task }) => task.verification?.verdict === 'failed').length,
        'Runs with a failed Host verification verdict.'),
      rate('task.rework_token_share', 'Rework & retry token share', reworkTokens, attributedTokens,
        'Provider tokens spent on failed, interrupted, or superseded attempts divided by total attempt-attributed tokens.', reworkKnown),
      durations('task.wall_clock', 'Mean task wall time', ended.map(trace => trace.timing.wallClockMs),
        'Mean elapsed time from task creation to latest end state, including waits, pauses and retries.'),
      count('task.root_retries', 'Root retries', taskRetries, 'Root attempt count minus the first attempt, per run.'),
      ...['ready', 'running', 'verifying', 'succeeded', 'failed', 'blocked', 'stop_requested', 'stopping', 'stopped', 'needs_reconciliation']
        .map(status => count(`task.status.${status}`, status, taskRuns.filter(task => task.status === status).length, 'Current Host status.')),
    ],
    dag: [
      count('dag.nodes', 'Delegated DAG nodes', nodes.length, 'Nodes in current Task DAG snapshots, excluding the root.'),
      rate('dag.node_completion_rate', 'DAG subgoal completion rate', succeededNodes, nodes.length,
        'Succeeded delegated nodes divided by all planned nodes across selected runs.'),
      count('dag.dependencies', 'DAG dependencies', nodes.reduce((sum, node) => sum + node.dependencies.length, 0),
        'Explicit dependency edges in current DAG snapshots.'),
      count('dag.replanned', 'Node replans', nodes.reduce((sum, node) => sum + (node.replans ?? 0), 0), 'Recorded per-node replan counts.'),
      count('dag.retries', 'Node retries', traces.reduce((sum, trace) => sum + trace.nodes.reduce((nodeSum, node) => nodeSum +
        Math.max(0, trace.task.attempts.filter(attempt => attempt.nodeId === node.id).length - 1), 0), 0), 'Recorded node attempts after the first.'),
      durations('dag.pre_start_wait', 'Mean node pre-start wait', nodes.map(node => node.waitMs), 'Plan announcement to first attempt start.'),
      durations('dag.dependency_wait', 'Mean dependency wait coverage', traces.filter(trace => trace.nodes.length).map(trace => trace.timing.dependencyWaitMs),
        'Mean of each run’s union of observed dependency-blocked intervals, excluding replanned nodes and missing predecessor evidence.'),
      durations('dag.queue_wait', 'Mean post-dependency wait coverage', traces.filter(trace => trace.nodes.length).map(trace => trace.timing.queueWaitMs),
        'Mean of each run’s union from dependency readiness to start. The cause of scheduler delay is unavailable.'),
      durations('dag.critical_path', 'Mean dependency critical path', traces.filter(trace => trace.nodes.length).map(trace => trace.timing.criticalPathMs),
        'Longest explicit dependency chain by the latest settled node attempts. Parallel siblings and the root envelope are excluded.'),
    ],
    agents: [
      count('agents.runs', 'Agent runs', agentSpans.length, 'Started Root, Team and Worker runs.', complete),
      count('agents.peak', 'Peak observed agents', peakAgents(agentSpans, traces),
        'Complete TaskRun streams use lifecycle event order. Across tasks or through gaps only confirmed overlaps count.', complete),
      parallelSpeedup,
      count('agents.delegations', 'Delegated attempts', delegationSpans.length, 'Recorded node starts including retries.', complete),
      count('agents.deliveries', 'Completed deliveries', delegationSpans.filter(span => span.status === 'succeeded').length,
        'Node attempts with a succeeded handoff. Deterministic verification is counted separately.', complete),
      durations('agents.collaboration_time', 'Mean delegation elapsed', delegationSpans.map(span => span.durationMs),
        'Node start to settlement, including any nested work and waiting.'),
      durations('agents.active_wall', 'Mean agent lifecycle coverage', selections.map(selection =>
        wallTime(selection.spans.filter(span => span.kind === 'agent'))),
        'Mean per-run wall time covered by the union of measured agent lifecycles. Includes waits within those lifecycles.'),
      values('agents.work', 'Agent lifecycle time (sum)', 'ms', agentSpans.map(span => span.durationMs),
        'Sum of completed agent lifecycle intervals, including concurrent lifecycles.', { complete }),
      absent('agents.pure_compute', 'Agent compute time', 'ms', 'Host does not instrument CPU or idle time inside an AgentRun.'),
    ],
    models: modelMetrics(modelSpans, complete, usdToCnyRate, verified),
    tools: toolMetrics(toolSpans, complete, true, events),
    context: [
      count('context.compactions', 'Context compactions', compactions.length, 'Completed compactions reported by the runtime.', complete),
      values('context.before', 'Mean tokens before compaction', 'tokens', compactions.map(event => quantity(event.payload.tokensBefore)),
        'Token estimates reported before compaction.', { complete, aggregate: 'mean', estimated: true }),
      values('context.after', 'Mean tokens after compaction', 'tokens', compactions.map(event => quantity(event.payload.estimatedTokensAfter)),
        'Token estimates reported after compaction.', { complete, aggregate: 'mean', estimated: true }),
      values('context.size', 'Mean scoped context size', 'bytes', (contextBuilds.length ? contextBuilds : recalls).map(event =>
        quantity(event.payload.contextBytes)), 'UTF-8 bytes when captured for scoped context builds.', { complete, aggregate: 'mean' }),
      values('context.budget', 'Mean scoped context budget', 'bytes', (contextBuilds.length ? contextBuilds : recalls).map(event =>
        quantity(event.payload.budgetBytes)), 'Byte budget for each observed scoped context build.', { complete, aggregate: 'mean' }),
      values('context.model_input_estimate', 'Mean request context estimate', 'tokens', modelSpans.filter(span => span.status !== 'unpaired')
        .map(span => quantity(span.detail.estimatedInputTokens)), 'Host’s conservative estimate of input size before a model request.',
      { complete, aggregate: 'mean', estimated: true }),
      cnyValues('context.compaction_cost', 'Estimated compaction cost (CNY)', compactionRequests.map(span => quantity(span.detail.estimatedCostUsd)),
        `Subtotal of priced compaction calls converted at 1 USD ≈ ${usdToCnyRate} CNY.`, usdToCnyRate, { complete }),
    ],
    memory: [
      count('memory.capture_events', 'Memory capture events', captures.length, 'Observed durable memory captures.', complete),
      counts('memory.captured', 'Memory entries captured', captures.map(event => quantity(event.payload.count)),
        'Sum of entries captured or updated. This is an activity count, not distinct stored entries.'),
      count('memory.recall_events', 'Memory recall events', recalls.length, 'Scoped context builds with a recorded recall.', complete),
      counts('memory.injected', 'Memory entries injected', recalls.map(event => quantity(event.payload.count)),
        'Entries selected and included by ScopedContext; this cannot establish whether the model relied on them.'),
      durations('memory.capture_latency', 'Mean memory capture latency', captures.map(event => quantity(event.payload.elapsedMs)),
        'Elapsed time reported for memory capture when instrumented.'),
      durations('memory.recall_latency', 'Mean memory recall latency', recalls.map(event => quantity(event.payload.elapsedMs)),
        'Elapsed time for scoped recall, relevance judgment and selection when instrumented.'),
      absent('memory.cost', 'Memory model cost (CNY)', 'CNY', 'Host does not separately price memory retrieval or attribute inference spend to injected memory.'),
    ],
    judgment: judgmentMetrics(judgment, complete, usdToCnyRate),
    reliability: [
      observed('reliability.stop_requested', 'Stop requests', 'task.stop_requested', 'Accepted stop intents.'),
      observed('reliability.stopped', 'Stopped transitions', 'task.stopped', 'Observed Task stop transitions.'),
      observed('reliability.resumed', 'Resumes', 'task.resumed', 'Observed accepted resume transitions.'),
      observed('reliability.output_recoveries', 'Output recovery', 'model.output_recovery', 'Model continuation triggered by the output cap.'),
      count('reliability.tool_retry_blocks', 'Unchanged tool retries blocked',
        toolDenials.filter(event => event.payload.reason === 'repeated_failure').length,
        'Tool calls rejected before execution after repeating failed arguments.', complete),
      count('reliability.incomplete_streams', 'Incomplete streams', traces.filter(trace => !trace.coverage.complete).length,
        'Task streams with cursor gaps or conflicting sequences.'),
      count('reliability.missing_events', 'Missing events', traces.reduce((sum, trace) => sum + trace.coverage.missingEvents, 0),
        'Difference between expected sequence slots and distinct collected events.'),
      count('reliability.unpaired', 'Unpaired span events', traces.reduce((sum, trace) => sum + trace.coverage.unpairedEvents, 0),
        'Unmatched span endpoints, ambiguous request starts or usage records without a safely matched reservation.'),
      ...['runtime_error', 'process_interrupted', 'model_interrupted', 'checkpoint_error', 'user_stop', 'host_shutdown', 'stop_timeout',
        'model_error', 'model_output_limit', 'budget_exhausted', 'tool_retry_loop', 'unknown_effect', 'verification_failed'].map(reason =>
        count(`reliability.reason.${reason}`, reason, ended.filter(trace => trace.task.reason === reason).length, 'Current Host end reason.')),
    ],
    security: [
      observed('security.permissions_changed', 'Permission changes', 'task.permissions_changed', 'Recorded workspace access changes.'),
      values('security.access_grants', 'Workspace access increases', 'count', accessChanges.map(change => change > 0 ? 1 : 0),
        'Permission changes that increased access, for events that report both policies.', { complete: false }),
      values('security.access_reductions', 'Workspace access reductions', 'count', accessChanges.map(change => change < 0 ? 1 : 0),
        'Permission changes that reduced access, for events that report both policies.', { complete: false }),
      count('security.approvals_granted', 'Granted approvals', securityApprovalsGranted, 'Resolved explicit tool approvals marked granted.', complete),
      count('security.approvals_denied', 'Denied approvals', approvals.filter(event => event.payload.approved === false).length,
        'Resolved explicit tool approvals marked denied.', complete),
      count('security.approval_gated_tools', 'Approval-gated tool calls', toolSpans.filter(span => approvedReceipts.has(span.id)).length,
        'Selected tool receipts linked to an explicit approval in the TaskRun.', complete),
      count('security.write_tools', 'Write-class tool calls', toolSpans.filter(span => span.detail.effect === 'write').length,
        'Started receipts classified as write effects. Risk severity cannot be inferred from write access alone.', complete),
      count('security.reconciliations', 'Reconciliation required', operationsWithUnknownEffects.length,
        'Events that mark reconciliation required after an unknown effect or lost checkpoint.', complete),
      toolDenials.length ? count('security.policy_denials', 'Policy denials', toolDenials.filter(event => event.payload.reason === 'policy').length,
        'Recorded tool requests rejected by the authorization policy.', complete)
        : absent('security.policy_denials', 'Policy denials', 'count', 'Host does not guarantee telemetry for all policy denials.'),
      toolDenials.length ? count('security.approval_safety_blocks', 'Approval safety blocks',
        toolDenials.filter(event => event.payload.reason === 'approval_safety').length, 'Tool requests that could not be safely shown for approval.', complete)
        : absent('security.approval_safety_blocks', 'Approval safety blocks', 'count', 'No recorded tool denials with reason coverage.'),
    ],
    evaluation: [
      count('eval.runs', 'Completed evaluations', evalResults.length, 'Completed deterministic or independent AI evaluation jobs in selection.'),
      rate('eval.pass_rate', 'Evaluation pass rate', evalResults.filter(item => item.verdict === 'pass').length, evalResults.length,
        'Independent evaluations concluding pass divided by completed evaluations.', { known: true, estimated: evalUsesModel }),
      scoreAxis('completion', 'eval.completion_score', 'Mean completion score (0-5)'),
      scoreAxis('correctness', 'eval.correctness_score', 'Mean correctness score (0-5)'),
      scoreAxis('quality', 'eval.quality_score', 'Mean quality score (0-5)'),
    ],
  }
  const all = new Map(Object.values(domains).flat().map(item => [item.id, item]))
  const eventsById = new Map(traces.flatMap(trace => trace.events.map(event => [event.id, event] as const)))
  const spanReferences = (spans: TraceSpan[]) => eventReferences(spans.flatMap(span => {
    const event = eventsById.get(span.eventIds[0])
    return event ? [event] : []
  }))
  const { usage } = canonicalModels(modelSpans)
  const models: MetricGroup[] = [...groups(usage, span => JSON.stringify([span.model?.provider, span.model?.model, span.detail.role]))]
    .map(([key, group]) => {
      const { model: route } = group[0]
      const role = text(group[0].detail.role)
      return { key, label: route ? `${route.provider} / ${route.model}` : 'Unattributed model usage',
        provider: route?.provider, model: route?.model, role, metrics: modelMetrics(group, complete, usdToCnyRate), references: spanReferences(group) }
    })
  const tools: MetricGroup[] = [...groups(toolSpans, span => span.name)]
    .map(([name, group]) => ({ key: name, label: name, metrics: toolMetrics(group, complete), references: spanReferences(group) }))
  const judgments: MetricGroup[] = [...groups(judgment, event =>
    JSON.stringify([event.payload.id, event.payload.mode, event.payload.featureSchemaVersion]))].map(([key, group]) => {
    const point = text(group[0].payload.id)
    const mode = text(group[0].payload.mode)
    return { key, label: point ?? 'Unknown decision point', point, mode,
      featureSchemaVersion: quantity(group[0].payload.featureSchemaVersion), metrics: judgmentMetrics(group, complete, usdToCnyRate), references: eventReferences(group) }
  })
  for (const { id: point } of coreJudgmentPoints) {
    if (!judgments.some(group => group.point === point)) {
      judgments.push({ key: point, label: point, point, metrics: judgmentMetrics([], complete, usdToCnyRate), references: [] })
    }
  }
  return { taskIds: taskRuns.map(task => task.id), overview: overviewIds.map(id => all.get(id)!), domains, models, tools, judgments, usdToCnyRate }
}
