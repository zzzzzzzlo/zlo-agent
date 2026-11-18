import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { EventDraft, ModelRoute } from '../src/contracts/domain.ts'
import type { AgentExecution, ModelCandidate, ModelRequest } from '../src/execution.ts'
import { LocalJudgment } from '../src/judgment.ts'
import { LocalModelScheduler, ModelBudgetError } from '../src/model-scheduler.ts'
import { LocalStore } from '../src/store.ts'

const defaultRoute = { provider: 'authorized', model: 'main' }
const alternate = { provider: 'authorized', model: 'tool-alternate' }
const other = { provider: 'different', model: 'other' }
const event: EventDraft = { taskId: 'task', taskRunId: 'run', agentRunId: 'root', type: '', payload: {} }
const worker = { ...event, agentRunId: 'worker', taskNodeId: 'leaf', parentAgentRunId: 'root' }

function catalogExecution() {
  const validated: ModelRoute[] = []
  const discovered: (string | undefined)[] = []
  const candidate = (route: ModelRoute, cost: number, contextWindow = 32768, input = ['text']): ModelCandidate =>
    ({ route, estimatedCost: cost, contextWindow, input, reasoning: false })
  const candidates = [
    candidate(defaultRoute, 8),
    candidate(alternate, 4),
    candidate({ ...alternate, model: 'short' }, 1, 1024),
    candidate({ ...alternate, model: 'image-only' }, 1, 32768, ['image']),
    candidate(other, 0.5),
  ]
  const execution: AgentExecution = {
    async open() { throw new Error('Unexpected runtime open') },
    async validateRoute(route) {
      validated.push(route)
      if (!candidates.some(({ route: known }) => known.provider === route.provider && known.model === route.model)) {
        throw new Error('Unavailable model')
      }
    },
    async discoverModels(provider) {
      discovered.push(provider)
      return candidates
    },
  }
  return { execution, validated, discovered }
}

const request = (estimatedInputTokens: number, maxOutputTokens: number, kind: ModelRequest['kind'] = 'prompt'): ModelRequest =>
  ({ route: defaultRoute, estimatedInputTokens, maxOutputTokens, kind })

test('scheduler distinguishes existing session resume from cross-provider fresh Worker allocation', async () => {
  const store = new LocalStore(':memory:')
  try {
    const { execution, validated, discovered } = catalogExecution()
    const candidates: unknown[] = []
    const judgment = new LocalJudgment(store, {
      modes: { 'model.task_fit': 'active' },
      judge: {
        async evaluate(decision) {
          const routes = decision.input.candidates as Array<{ provider: string; model: string }>
          candidates.push(routes.map(({ provider, model }) => ({ provider, model })))
          return { output: 1000 }
        },
      },
    })
    const scheduler = new LocalModelScheduler(execution, store, judgment)
    await assert.rejects(
      scheduler.allocate(event, defaultRoute, other, true, undefined, undefined, { sessionMode: 'resume' }),
      /Cross-provider/,
    )
    assert.deepEqual(validated, [])
    await assert.rejects(scheduler.allocate(event, defaultRoute, { ...alternate, model: 'unknown' }), /Unavailable/)
    await assert.rejects(scheduler.allocate(event, defaultRoute, { ...alternate, model: 'bad\nroute' }), /Invalid model route/)
    // Fresh Worker Sessions allow cross-provider selection and prefer task-appropriate routes across providers.
    assert.deepEqual(await scheduler.allocate(event, defaultRoute, other, true), other)
    assert.deepEqual(await scheduler.allocate(event, defaultRoute, undefined, true), other)
    // Resumed independent selection discovers only the session's current provider and selects same-provider alternate.
    assert.deepEqual(
      await scheduler.allocate(event, defaultRoute, undefined, true, undefined, undefined, { sessionMode: 'resume' }),
      alternate,
    )
    assert.deepEqual(await scheduler.allocate(event, defaultRoute, defaultRoute, true), defaultRoute)
    assert.deepEqual(discovered, [undefined, defaultRoute.provider])
    assert.deepEqual(candidates, [[other], [defaultRoute, other, alternate], [defaultRoute, alternate], [defaultRoute]])
    assert.deepEqual(store.events('task').map(({ type, payload }) => [type, payload.judgeStatus, payload.output]), [
      ['judgment.evaluated', 'invalid', 0],
      ['judgment.evaluated', 'invalid', 1],
      ['judgment.evaluated', 'invalid', 1],
      ['judgment.evaluated', 'invalid', 0],
    ])
    assert.equal(scheduler.canSwitch(defaultRoute, alternate), true)
    assert.equal(scheduler.canSwitch(defaultRoute, other), false)
    assert.equal(scheduler.canResumeSession(defaultRoute, other), false)
  } finally {
    store.close()
  }
})

test('scheduler enforces task and Agent capacity, accounts exactly once, and correlates model receipts', () => {
  const store = new LocalStore(':memory:')
  try {
    const { execution } = catalogExecution()
    const scheduler = new LocalModelScheduler(execution, store, new LocalJudgment(store), {
      activeAgents: 2, requests: 3,
    })
    let rootEvent = event
    const root = scheduler.reserve(() => rootEvent, 'root')
    const leaf = scheduler.reserve(() => worker, 'worker')
    assert.deepEqual(scheduler.getRouteStatus(), { quota: 'unknown', activeReservations: 2 })
    assert.throws(() => scheduler.reserve(() => ({ ...event, agentRunId: 'extra' }), 'worker'), ModelBudgetError)
    assert.throws(() => root.request(request(-1, 20)), ModelBudgetError)
    assert.throws(() => root.request(request(10, 0)), ModelBudgetError)
    rootEvent = { ...rootEvent, sessionId: 'opened-session' }
    root.request(request(40, 10))
    assert.throws(() => root.request(request(5, 1)), ModelBudgetError)
    leaf.request(request(35, 5, 'compaction'))
    assert.deepEqual(scheduler.budget('task'), { requests: 2, confirmed: 0, reserved: 90, uncertain: 0 })
    const usage = { type: 'model.usage', input: 3, output: 5, cacheRead: 3, cacheWrite: 2 } as const
    leaf.usage(usage)
    leaf.usage(usage)
    root.release()
    root.release()
    assert.deepEqual(scheduler.budget('task'), { requests: 2, confirmed: 13, reserved: 0, uncertain: 50 })
    assert.deepEqual(scheduler.getRouteStatus(), { quota: 'unknown', activeReservations: 1 })
    leaf.request(request(36, 1))
    leaf.usage(usage)
    assert.throws(() => leaf.request(request(0, 1)), ModelBudgetError)
    leaf.release()
    assert.deepEqual(scheduler.budget('task'), { requests: 3, confirmed: 26, reserved: 0, uncertain: 50 })
    assert.deepEqual(scheduler.getRouteStatus(), { quota: 'unknown', activeReservations: 0 })
    const events = store.events('task')
    const reservations = events.filter(({ type }) => type === 'model.reserved')
    const settled = events.filter(({ type }) => type === 'model.reservation_settled')
    assert.equal(reservations.length, 3)
    assert.equal(settled.length, 3)
    assert.equal(new Set(reservations.map(({ correlationId }) => correlationId)).size, 3)
    assert.equal(reservations[0].sessionId, 'opened-session')
    assert.equal(reservations[1].taskNodeId, 'leaf')
    for (const reservation of reservations) {
      assert.ok(reservation.correlationId)
      const receipt = settled.find(({ correlationId }) => correlationId === reservation.correlationId)
      assert.ok(receipt)
      assert.equal(receipt.agentRunId, reservation.agentRunId)
      assert.equal(receipt.payload.kind, reservation.payload.kind)
      assert.equal(receipt.payload.estimatedTokens, reservation.payload.estimatedTokens)
      assert.equal(receipt.payload.status, reservation.agentRunId === 'root' ? 'uncertain' : 'settled')
      assert.equal(receipt.payload.actualTokens, reservation.agentRunId === 'root' ? undefined : 13)
    }
  } finally {
    store.close()
  }
})

test('restart preserves confirmed usage and charges an unfinished reservation only once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zlo-model-budget-'))
  const path = join(root, 'budget.sqlite')
  const { execution } = catalogExecution()
  let store = new LocalStore(path)
  try {
    let scheduler = new LocalModelScheduler(execution, store, new LocalJudgment(store))
    const prior = scheduler.reserve(() => event, 'root')
    prior.request(request(20, 10))
    prior.usage({ type: 'model.usage', input: 4, output: 6, cacheRead: 1, cacheWrite: 2 })
    prior.request(request(20, 10))
    const expected = { requests: 2, confirmed: 13, reserved: 0, uncertain: 30 }
    assert.deepEqual(scheduler.budget('task'), { ...expected, reserved: 30, uncertain: 0 })
    store.close()
    for (let restart = 0; restart < 2; restart++) {
      store = new LocalStore(path)
      scheduler = new LocalModelScheduler(execution, store, new LocalJudgment(store))
      assert.deepEqual(scheduler.budget('task'), expected)
      assert.deepEqual(scheduler.getRouteStatus(), { quota: 'unknown', activeReservations: 0 })
      const fresh = scheduler.reserve(() => worker, 'worker')
      assert.equal(fresh.request(request(6, 2)), 2)
      fresh.usage({ type: 'model.usage', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
      expected.requests++
      fresh.release()
      assert.equal(store.events('task').filter(({ payload }) => payload.status === 'uncertain').length, 1)
      store.close()
    }
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('default requests remain unlimited beyond 96 across restart, including uncertain usage', () => {
  const store = new LocalStore(':memory:')
  try {
    const { execution } = catalogExecution()
    let scheduler = new LocalModelScheduler(execution, store, new LocalJudgment(store))
    const lease = scheduler.reserve(() => event, 'root')
    for (let i = 0; i < 150; i++) {
      assert.equal(lease.request(request(1_000_000, 120_000)), 120_000)
      if (i % 2) lease.unknown()
      else lease.usage({ type: 'model.usage', input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 0 })
    }
    lease.release()
    scheduler = new LocalModelScheduler(execution, store, new LocalJudgment(store))
    assert.equal(scheduler.taskRequestLimit('task'), Infinity)
    assert.equal(scheduler.hasBudget('task'), true)
    const resumed = scheduler.reserve(() => event, 'root')
    assert.equal(resumed.request(request(1_000_000, 120_000)), 120_000)
    resumed.release()
    assert.equal(scheduler.budget('task').requests, 151)
    assert.ok(store.events('task').filter(e => e.type === 'model.reserved')
      .every(e => e.payload.taskRequestLimit === undefined && e.payload.taskTokenLimit === undefined))
    const explicit = new LocalModelScheduler(execution, store, new LocalJudgment(store), { requests: 150 })
    assert.equal(explicit.hasBudget('task'), false)
    const capped = explicit.reserve(() => event, 'root')
    assert.throws(() => capped.request(request(0, 1)), ModelBudgetError)
    capped.release()
  } finally { store.close() }
})

test('large cumulative usage does not shorten requests while delegated request counts still share a parent ledger', () => {
  const store = new LocalStore(':memory:')
  try {
    const { execution } = catalogExecution()
    const scheduler = new LocalModelScheduler(execution, store, new LocalJudgment(store))
    const parent = { nodeId: 'team', requests: 2 }
    const first = scheduler.reserve(() => worker, 'worker', [parent, { nodeId: 'leaf', requests: 1 }])
    const second = scheduler.reserve(() => ({ ...worker, agentRunId: 'worker-2', taskNodeId: 'other' }), 'worker', [parent])
    assert.equal(first.request(request(1_000_000, 80_000)), 80_000)
    const uncertain = first.unknown()
    assert.ok(uncertain)
    assert.equal(first.unknown(), undefined)
    assert.throws(() => first.request(request(0, 1)), ModelBudgetError)
    assert.equal(second.request(request(950_000, 120_000)), 120_000)
    second.usage({ type: 'model.usage', input: 100_000, output: 50_000, cacheRead: 900_000, cacheWrite: 0 })
    assert.throws(() => second.request(request(0, 1)), ModelBudgetError)
    const root = scheduler.reserve(() => event, 'root')
    assert.equal(root.request(request(1_000_000, 100_000)), 100_000)
    root.usage({ type: 'model.usage', input: 100_000, output: 1, cacheRead: 900_000, cacheWrite: 0 })
    assert.equal(root.request(request(50_000, 32_768)), 32_768)
    root.usage({ type: 'model.usage', input: 0, output: 1, cacheRead: 50_000, cacheWrite: 0 })
    assert.deepEqual(scheduler.budget('task'), { requests: 4, confirmed: 2_100_002, reserved: 0, uncertain: 1_080_000 })
    assert.ok(store.events('task').every(({ payload }) => payload.taskTokenLimit === undefined))
    assert.deepEqual(store.events('task').filter(event => event.type === 'model.reserved')
      .map(({ payload }) => payload.maxOutputTokens), [80_000, 120_000, 100_000, 32_768])
    first.release()
    second.release()
    root.release()
  } finally {
    store.close()
  }
})

test('P1-5: model.task_fit baseline keeps parent model when parent is already cheaper than alternatives across off/shadow/active', async () => {
  const cheapParent = { provider: 'authorized', model: 'cheap-parent' }
  const expensiveAlt = { provider: 'authorized', model: 'expensive-alt' }
  const execution: AgentExecution = {
    async open() { throw new Error('Unexpected open') },
    async validateRoute(route) {
      if (route.provider !== 'authorized' || (route.model !== cheapParent.model && route.model !== expensiveAlt.model)) {
        throw new Error('Unavailable')
      }
    },
    async discoverModels() {
      return [
        { route: cheapParent, estimatedCost: 1, contextWindow: 32_768, input: ['text'], reasoning: false },
        { route: expensiveAlt, estimatedCost: 10, contextWindow: 65_536, input: ['text'], reasoning: true },
      ]
    },
  }
  for (const mode of ['off', 'shadow', 'active'] as const) {
    const store = new LocalStore(':memory:')
    try {
      const judgment = new LocalJudgment(store, {
        modes: { 'model.task_fit': mode },
        judge: { async evaluate() { return { output: 1 } } },
      })
      const scheduler = new LocalModelScheduler(execution, store, judgment)
      const route = await scheduler.allocate(event, cheapParent, undefined, true, 'Quick file read')
      if (mode === 'active') assert.deepEqual(route, expensiveAlt)
      else assert.deepEqual(route, cheapParent)
      const [evaluated] = store.events('task')
      assert.equal(evaluated.payload.baseline, 0)
    } finally {
      store.close()
    }
  }
})

test('unavailable primary uses top fallback baseline, slots queue, and only explicit request limits cap DAG execution', async () => {
  const downPrimary = { provider: 'authorized', model: 'down-primary' }
  const firstFallback = { provider: 'authorized', model: 'best-fallback' }
  const secondFallback = { provider: 'authorized', model: 'second-fallback' }
  const execution: AgentExecution = {
    async open() { throw new Error('Unexpected open') },
    async validateRoute(route) {
      if (route.model === downPrimary.model) throw new Error('Primary down')
      if (route.provider !== 'authorized' || (route.model !== firstFallback.model && route.model !== secondFallback.model)) {
        throw new Error('Unknown route')
      }
    },
    async discoverModels() {
      return [
        { route: secondFallback, estimatedCost: 5, contextWindow: 32_768, input: ['text'], reasoning: false },
        { route: firstFallback, estimatedCost: 2, contextWindow: 65_536, input: ['text'], reasoning: false },
      ]
    },
  }

  const store = new LocalStore(':memory:')
  try {
    const scheduler = new LocalModelScheduler(execution, store, new LocalJudgment(store), { activeAgents: 2 })
    // 1. When primary fails validation with allowFallback: true, baselineIndex must stay 0 (best alternative), not skip to index 1.
    const selected = await scheduler.allocate(event, downPrimary, undefined, true, 'Fallback task', undefined, { allowFallback: true })
    assert.deepEqual(selected, firstFallback)

    // 2. reserveAsync queues when activeAgents is saturated and resumes cleanly on suspend/release.
    const r1 = await scheduler.reserveAsync(() => ({ ...event, agentRunId: 'run-1' }), 'root')
    const r2 = await scheduler.reserveAsync(() => ({ ...event, agentRunId: 'run-2' }), 'team')
    let thirdAcquired = false
    const r3Promise = scheduler.reserveAsync(() => ({ ...event, agentRunId: 'run-3' }), 'worker').then(res => {
      thirdAcquired = true
      return res
    })
    await Promise.resolve()
    assert.equal(thirdAcquired, false)
    assert.equal(r2.suspend(), true)
    const r3 = await r3Promise
    assert.equal(thirdAcquired, true)
    let resumed = false
    const resumePromise = r2.resume().then(() => { resumed = true })
    await Promise.resolve()
    assert.equal(resumed, false)
    r3.release()
    await resumePromise
    assert.equal(resumed, true)
    r2.release()
    r1.release()
    assert.deepEqual(scheduler.getRouteStatus(), { quota: 'unknown', activeReservations: 0 })

    // DAG size must not introduce an implicit spending limit.
    scheduler.registerPlannedNodes('big-dag', 30)
    assert.equal(scheduler.taskRequestLimit('big-dag'), Infinity)

    const cappedScheduler = new LocalModelScheduler(execution, store, new LocalJudgment(store), { requests: 10 })
    cappedScheduler.registerPlannedNodes('big-dag-capped', 30)
    assert.equal(cappedScheduler.taskRequestLimit('big-dag-capped'), 10)
  } finally {
    store.close()
  }
})
