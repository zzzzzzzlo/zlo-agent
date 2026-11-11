import assert from 'node:assert/strict'
import test from 'node:test'
import type { TelemetryEvent, TelemetryTask } from '../../shared/contracts/observatory.ts'
import { buildMetrics } from '../src/metrics.ts'
import { buildTrace } from '../src/trace.ts'

const now = Date.parse('2026-01-01T00:00:00Z')
const iso = (ms: number) => new Date(now + ms).toISOString()
const route = { provider: 'deepseek', model: 'flash' }
const alternate = { provider: 'deepseek', model: 'pro' }

function scenario() {
  const task: TelemetryTask = {
    id: 'task', taskRunId: 'run', rootNodeId: 'root', status: 'succeeded', attemptCount: 1, planVersion: 1,
    cursor: 0, route, verification: { verdict: 'unverified', passed: false }, nodes: [
      { id: 'a', parentNodeId: 'root', dependencies: [], status: 'succeeded', role: 'worker', attemptId: 'a1' },
      { id: 'b', parentNodeId: 'root', dependencies: [], status: 'succeeded', role: 'team', attemptId: 'b1' },
      { id: 'c', parentNodeId: 'b', dependencies: ['a', 'b'], status: 'succeeded', role: 'worker', attemptId: 'c1' },
    ], attempts: [
      { id: 'r1', nodeId: 'root', startedAt: iso(2), finishedAt: iso(240), status: 'succeeded' },
      { id: 'a1', nodeId: 'a', startedAt: iso(20), finishedAt: iso(150), status: 'succeeded' },
      { id: 'b1', nodeId: 'b', startedAt: iso(25), finishedAt: iso(140), status: 'succeeded' },
      { id: 'c1', nodeId: 'c', startedAt: iso(160), finishedAt: iso(220), status: 'succeeded' },
    ],
  }
  const events: TelemetryEvent[] = []
  const run = (node: string) => ({ taskNodeId: node, taskAttemptId: node === 'root' ? 'r1' : `${node}1`,
    agentRunId: `agent-${node}`, ...(node !== 'root' ? { parentAgentRunId: node === 'c' ? 'agent-b' : 'agent-root' } : {}) })
  const emit = (time: number, type: string, payload: TelemetryEvent['payload'] = {}, link: Partial<TelemetryEvent> = {}) => {
    const seq = events.length + 1
    const event = { schemaVersion: 1 as const, id: `event-${seq}`, seq, occurredAt: iso(time),
      taskId: task.id, taskRunId: task.taskRunId, type, payload, ...link }
    events.push(event)
    task.cursor = seq
    return event
  }
  emit(0, 'task.created', { status: 'ready' })
  emit(2, 'task.state_changed', { previous: 'ready', status: 'running' }, run('root'))
  emit(5, 'agent.started', { role: 'root', route }, run('root'))
  emit(10, 'task.plan_changed', { version: 1, nodes: task.nodes.map(({ id, parentNodeId, dependencies }) => ({ id, parentNodeId, dependencies })) })
  emit(20, 'task.node_started', { role: 'worker', parentNodeId: 'root' }, { taskNodeId: 'a', taskAttemptId: 'a1' })
  emit(25, 'task.node_started', { role: 'team', parentNodeId: 'root' }, { taskNodeId: 'b', taskAttemptId: 'b1' })
  emit(30, 'agent.started', { role: 'worker', route }, run('a'))
  emit(35, 'agent.started', { role: 'team', route }, run('b'))
  emit(40, 'model.reserved', { route, kind: 'prompt', estimatedTokens: 100 }, { ...run('root'), correlationId: 'reservation-root' })
  emit(45, 'model.request_started', {}, run('root'))
  emit(50, 'model.reserved', { route, kind: 'prompt', estimatedTokens: 120 }, { ...run('a'), correlationId: 'reservation-worker' })
  emit(55, 'model.request_started', {}, run('a'))
  emit(60, 'tool.started', { id: 'receipt-a', tool: 'git_status', effect: 'read' }, run('a'))
  emit(100, 'model.reservation_settled', { status: 'settled', actualTokens: 13, estimatedCostUsd: 0.01 },
    { ...run('root'), correlationId: 'reservation-root' })
  emit(100, 'model.usage', { input: 5, output: 4, cacheRead: 3, cacheWrite: 1, estimatedCostUsd: 0.01 }, run('root'))
  emit(115, 'model.reservation_settled', { status: 'settled', actualTokens: 40 }, { ...run('a'), correlationId: 'reservation-worker' })
  emit(115, 'model.usage', { input: 20, output: 15, cacheRead: 4, cacheWrite: 1 }, run('a'))
  emit(130, 'tool.finished', { id: 'receipt-a', tool: 'git_status', status: 'failed' }, run('a'))
  emit(135, 'agent.finished', { role: 'team', status: 'completed' }, run('b'))
  emit(140, 'task.node_settled', { status: 'succeeded' }, { taskNodeId: 'b', taskAttemptId: 'b1' })
  emit(145, 'agent.finished', { role: 'worker', status: 'completed' }, run('a'))
  emit(150, 'task.node_settled', { status: 'succeeded' }, { taskNodeId: 'a', taskAttemptId: 'a1' })
  emit(160, 'task.node_started', { role: 'worker', parentNodeId: 'b' }, { taskNodeId: 'c', taskAttemptId: 'c1' })
  emit(165, 'agent.started', { role: 'worker', route }, run('c'))
  const judgment = emit(167, 'judgment.evaluated', { id: 'context.relevance', mode: 'shadow', featureSchemaVersion: 1,
    baseline: 0, output: 0, shadow: 1, elapsedMs: 2, judgeStatus: 'valid', usage: { input: 2, output: 3, estimatedCostUsd: 0.005 } }, run('c'))
  const recall = emit(170, 'memory.recalled', { count: 2, contextBytes: 4096, budgetBytes: 65536 }, run('c'))
  emit(174, 'tool.approval_resolved', { id: 'receipt-denied', tool: 'git_commit', approved: false }, run('root'))
  emit(175, 'model.route_changed', { route: alternate }, run('root'))
  emit(180, 'model.reserved', { route: alternate, kind: 'compaction', estimatedTokens: 200 }, { ...run('root'), correlationId: 'uncertain' })
  emit(185, 'model.request_started', {}, run('root'))
  emit(205, 'model.reservation_settled', { status: 'uncertain', estimatedTokens: 200 }, { ...run('root'), correlationId: 'uncertain' })
  emit(210, 'agent.finished', { role: 'worker', status: 'completed' }, run('c'))
  emit(220, 'task.node_settled', { status: 'succeeded' }, { taskNodeId: 'c', taskAttemptId: 'c1' })
  emit(230, 'agent.finished', { role: 'root', status: 'completed' }, run('root'))
  emit(235, 'verification.finished', { ...task.verification, executionStatus: 'completed' }, run('root'))
  emit(240, 'task.state_changed', { previous: 'verifying', status: 'succeeded' }, run('root'))
  return { task, events, judgment, recall, emit, run }
}

test('trace relates DAG, parent agents, operations, context and Judgment without accumulating concurrent wall time', () => {
  const { task, events, judgment, recall } = scenario()
  const trace = buildTrace(task, [...events].reverse().concat(events[0]))
  assert.equal(trace.coverage.complete, true)
  assert.equal(trace.coverage.eventCount, task.cursor)
  assert.equal(trace.coverage.unpairedEvents, 0)
  assert.equal(trace.timing.wallClockMs, 240)
  assert.equal(trace.timing.modelRequestMs, 115)
  assert.equal(trace.timing.modelWallMs, 70)
  assert.equal(trace.timing.agentRunMs, 485)
  assert.equal(trace.timing.agentActivityMs, 225)
  assert.equal(trace.timing.peakAgents, 3)
  assert.equal(trace.timing.criticalPathMs, 190)
  assert.deepEqual(trace.timing.criticalPath, ['a', 'c'])
  assert.equal(trace.timing.dependencyWaitMs, 140)
  assert.equal(trace.timing.queueWaitMs, 25)
  assert.equal(trace.nodes.find(node => node.id === 'c')?.waitMs, 150)
  assert.equal(trace.agents.find(agent => agent.id === 'agent-c')?.parentAgentRunId, 'agent-b')
  assert.equal(trace.spans.find(span => span.id === 'receipt-a')?.durationMs, 70)
  assert.equal(trace.spans.find(span => span.id === 'uncertain')?.durationMs, null)
  assert.deepEqual(trace.judgments, [{ eventId: judgment.id, point: 'context.relevance', linkedEventIds: [recall.id] }])
})

test('metrics count provider usage and costs once, preserve coverage, and separate verification from execution', () => {
  const { task, events } = scenario()
  const metrics = buildMetrics([task], events)
  const byId = new Map(Object.values(metrics.domains).flat().map(metric => [metric.id, metric]))
  assert.equal(metrics.overview.length, 24)
  assert.equal(Object.keys(metrics.domains).length, 10)
  assert.equal(byId.get('task.execution_rate')?.value, 100)
  assert.equal(byId.get('task.verified_rate')?.value, 0)
  assert.equal(byId.get('task.unverified')?.value, 1)
  assert.equal(byId.get('model.requests')?.value, 3)
  assert.equal(byId.get('model.tokens')?.value, 53)
  assert.equal(byId.get('model.cache_read')?.value, 7)
  assert.equal(byId.get('model.cost')?.value, 0.01)
  assert.equal(byId.get('model.cost')?.quality, 'estimated')
  assert.equal(byId.get('model.cost')?.samples, 1)
  assert.equal(byId.get('model.cost')?.population, 3)
  assert.equal(byId.get('model.mean_latency')?.value, 57.5)
  assert.equal(byId.get('model.budget_uncertain')?.value, 200)
  assert.equal(byId.get('tool.failure_rate')?.value, 100)
  assert.equal(byId.get('context.size')?.value, 4096)
  assert.equal(byId.get('context.budget')?.value, 65536)
  assert.equal(byId.get('memory.injected')?.value, 2)
  assert.equal(byId.get('judgment.shadow_disagreement')?.value, 100)
  assert.equal(byId.get('judgment.cost')?.value, 0.005)
  assert.equal(byId.get('security.approvals_denied')?.value, 1)
  assert.equal(byId.get('security.policy_denials')?.quality, 'unknown')
  assert.equal(metrics.judgments.length, 6)
  const alternateMetrics = metrics.models.find(group => group.model === 'pro')!.metrics
  assert.equal(alternateMetrics.find(metric => metric.id === 'model.mean_latency')?.quality, 'unknown')
  assert.equal(alternateMetrics.find(metric => metric.id === 'model.cost')?.quality, 'unknown')
})

test('time, role and model filters retain span ends and do not attribute root requests to a worker', () => {
  const { task, events } = scenario()
  const metrics = buildMetrics([task], events, now + 250, { from: now + 51, to: now + 70, role: 'worker', provider: 'deepseek', model: 'flash' })
  const byId = new Map(metrics.domains.models.map(metric => [metric.id, metric.value]))
  assert.equal(byId.get('model.requests'), 1)
  assert.equal(byId.get('model.tokens'), 40)
  assert.equal(byId.get('model.mean_latency'), 60)
  assert.equal(metrics.models[0].role, 'worker')
  assert.deepEqual(metrics.taskIds, [task.id])
  assert.equal(metrics.domains.tools.find(metric => metric.id === 'tool.failure_rate')?.value, 100)
})

test('a gap and a competing reservation leave attribution and timing unknown', () => {
  const { task, events } = scenario()
  const gap = events.find(event => event.type === 'model.reservation_settled' && event.correlationId === 'reservation-root')!
  const incomplete = events.filter(event => event.id !== gap.id)
  const trace = buildTrace(task, incomplete)
  assert.equal(trace.coverage.complete, false)
  assert.equal(trace.coverage.missingEvents, 1)
  assert.equal(trace.coverage.contiguousCursor, gap.seq - 1)
  assert.equal(trace.coverage.openSpans, 1)
  assert.equal(trace.coverage.unpairedEvents, 2)
  const ambiguous = trace.spans.find(span => span.status === 'unpaired')!
  assert.equal(ambiguous.model, undefined)
  assert.equal(ambiguous.durationMs, null)
  assert.equal(trace.timing.modelWallMs, 60)
  const metrics = buildMetrics([task], incomplete)
  assert.equal(metrics.domains.reliability.find(metric => metric.id === 'reliability.missing_events')?.value, 1)
  const cost = metrics.domains.models.find(metric => metric.id === 'model.cost')!
  assert.equal(cost.value, null)
  assert.equal(cost.samples, 0)
  assert.equal(metrics.domains.models.find(metric => metric.id === 'model.tokens')?.value, 40)
  const usageOnly = buildMetrics([task], incomplete, now + 250, { from: now + 99, to: now + 101 })
  assert.equal(usageOnly.domains.models.find(metric => metric.id === 'model.cost')?.value, null)
})

test('crash-recovered lifetimes and incomplete dependencies do not become precise elapsed times', () => {
  const { task, events } = scenario()
  const agent = events.find(event => event.type === 'agent.finished' && event.agentRunId === 'agent-a')!
  agent.payload.reason = 'process_interrupted'
  task.attempts.find(attempt => attempt.id === 'a1')!.recoveries = 1
  const trace = buildTrace(task, events)
  assert.equal(trace.agents.find(span => span.id === 'agent-a')?.durationMs, null)
  assert.equal(trace.timing.criticalPathMs, null)
  assert.deepEqual(trace.timing.criticalPath, [])
  assert.equal(trace.timing.agentRunMs, 370)
})

test('explicit reservation correlation survives a missing settlement without guessing route or latency', () => {
  const { task, events } = scenario()
  const reservation = events.find(event => event.type === 'model.reserved' && event.correlationId === 'reservation-root')!
  reservation.payload.estimatedInputTokens = 20
  reservation.payload.maxOutputTokens = 80
  reservation.payload.taskTokenLimit = 1000
  const settlement = events.find(event => event.type === 'model.reservation_settled' && event.correlationId === 'reservation-root')!
  settlement.payload.durationMs = 62.5
  const usage = events.find(event => event.type === 'model.usage' && event.agentRunId === 'agent-root')!
  usage.correlationId = reservation.correlationId
  const full = buildMetrics([task], events)
  assert.equal(full.domains.models.find(metric => metric.id === 'model.mean_reservation')?.value, 62.5)
  assert.equal(full.domains.models.find(metric => metric.id === 'model.mean_latency')?.value, 57.5)
  assert.equal(full.domains.models.find(metric => metric.id === 'model.output_budget')?.value, 80)
  assert.equal(full.domains.models.find(metric => metric.id === 'model.task_token_limit')?.value, 1000)
  const partial = events.filter(event => event.id !== settlement.id)
  const trace = buildTrace(task, partial)
  const span = trace.spans.find(span => span.id === 'reservation-root')!
  assert.deepEqual(span.model, route)
  assert.equal(span.durationMs, null)
  assert.equal(span.detail.input, 5)
  assert.ok(span.eventIds.includes(usage.id))
  const metrics = buildMetrics([task], partial)
  assert.equal(metrics.domains.models.find(metric => metric.id === 'model.tokens')?.value, 53)
  assert.equal(metrics.domains.models.find(metric => metric.id === 'model.cost')?.value, 0.01)
  assert.ok(metrics.models.some(group => group.references.some(reference => reference.eventId === reservation.id)))
})

test('a failed deterministic check still counts execution completion; legacy self-reported success does not', () => {
  const { task, events } = scenario()
  task.status = 'failed'
  task.reason = 'verification_failed'
  task.verification = { verdict: 'failed', passed: false, basis: 'workspace_path' }
  events.at(-1)!.payload.status = 'failed'
  const verification = events.find(event => event.type === 'verification.finished')!
  verification.payload = { ...task.verification, executionStatus: 'completed' }
  const metrics = buildMetrics([task], events)
  const byId = new Map(metrics.domains.task.map(metric => [metric.id, metric]))
  assert.equal(byId.get('task.execution_rate')?.value, 100)
  assert.equal(byId.get('task.failure_rate')?.value, 100)
  assert.equal(byId.get('task.verified_rate')?.value, 0)
  delete verification.payload.executionStatus
  assert.equal(buildMetrics([task], events).domains.task.find(metric => metric.id === 'task.execution_rate')?.quality, 'unknown')
})

test('redacted operation identifiers still link delegation decisions and approval-gated receipts', () => {
  const { task, events, run, emit } = scenario()
  const id = `sha256:${'d'.repeat(64)}`
  const judgment = emit(244, 'judgment.evaluated', { id: 'delegation.worth', mode: 'off', baseline: true, output: true,
    resultLink: { delegationReceiptKey: id } }, run('root'))
  emit(245, 'tool.approval_resolved', { id, approved: true }, run('root'))
  emit(246, 'tool.started', { id, tool: 'delegate_task', effect: 'write' }, run('root'))
  const toolFinished = emit(255, 'tool.finished', { id, tool: 'delegate_task', status: 'succeeded' }, run('root'))
  const trace = buildTrace(task, events)
  assert.deepEqual(trace.judgments.find(result => result.eventId === judgment.id)?.linkedEventIds, [toolFinished.id])
  const metrics = buildMetrics([task], events, now + 260, { from: now + 246 })
  assert.equal(metrics.domains.security.find(metric => metric.id === 'security.approval_gated_tools')?.value, 1)
})
