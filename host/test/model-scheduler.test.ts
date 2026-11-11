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

test('scheduler rejects invalid requests and restricts independent selection to eligible same-provider routes', async () => {
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
    await assert.rejects(scheduler.allocate(event, defaultRoute, other, true), /Cross-provider/)
    assert.deepEqual(validated, [])
    await assert.rejects(scheduler.allocate(event, defaultRoute, { ...alternate, model: 'unknown' }), /Unavailable/)
    await assert.rejects(scheduler.allocate(event, defaultRoute, { ...alternate, model: 'bad\nroute' }), /Invalid model route/)
    assert.deepEqual(await scheduler.allocate(event, defaultRoute, undefined, true), alternate)
    assert.deepEqual(await scheduler.allocate(event, defaultRoute, defaultRoute, true), defaultRoute)
    assert.deepEqual(discovered, [defaultRoute.provider])
    assert.deepEqual(candidates, [[defaultRoute, alternate], [defaultRoute]])
    assert.deepEqual(store.events('task').map(({ type, payload }) => [type, payload.judgeStatus, payload.output]), [
      ['judgment.evaluated', 'invalid', 1],
      ['judgment.evaluated', 'invalid', 0],
    ])
    assert.equal(scheduler.canSwitch(defaultRoute, alternate), true)
    assert.equal(scheduler.canSwitch(defaultRoute, other), false)
  } finally {
    store.close()
  }
})

test('scheduler enforces task and Agent capacity, accounts exactly once, and correlates model receipts', () => {
  const store = new LocalStore(':memory:')
  try {
    const { execution } = catalogExecution()
    const scheduler = new LocalModelScheduler(execution, store, new LocalJudgment(store), {
      activeAgents: 2, requests: 3, tokens: 100,
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
    assert.throws(() => leaf.request(request(45, 6)), ModelBudgetError)
    leaf.request(request(35, 5, 'compaction'))
    assert.deepEqual(scheduler.budget('task'), { requests: 2, confirmed: 0, reserved: 90, uncertain: 0 })
    const usage = { type: 'model.usage', input: 3, output: 5, cacheRead: 3, cacheWrite: 2 } as const
    leaf.usage(usage)
    leaf.usage(usage)
    root.release()
    root.release()
    assert.deepEqual(scheduler.budget('task'), { requests: 2, confirmed: 13, reserved: 0, uncertain: 50 })
    assert.deepEqual(scheduler.getRouteStatus(), { quota: 'unknown', activeReservations: 1 })
    assert.throws(() => leaf.request(request(37, 1)), ModelBudgetError)
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
    let scheduler = new LocalModelScheduler(execution, store, new LocalJudgment(store), { tokens: 50 })
    const prior = scheduler.reserve(() => event, 'root')
    prior.request(request(20, 10))
    prior.usage({ type: 'model.usage', input: 4, output: 6, cacheRead: 1, cacheWrite: 2 })
    prior.request(request(20, 10))
    const expected = { requests: 2, confirmed: 13, reserved: 0, uncertain: 30 }
    assert.deepEqual(scheduler.budget('task'), { ...expected, reserved: 30, uncertain: 0 })
    store.close()
    for (let restart = 0; restart < 2; restart++) {
      store = new LocalStore(path)
      scheduler = new LocalModelScheduler(execution, store, new LocalJudgment(store), { tokens: 50 })
      assert.deepEqual(scheduler.budget('task'), expected)
      assert.deepEqual(scheduler.getRouteStatus(), { quota: 'unknown', activeReservations: 0 })
      const fresh = scheduler.reserve(() => worker, 'worker')
      assert.throws(() => fresh.request(request(6, 2)), ModelBudgetError)
      fresh.release()
      assert.equal(store.events('task').filter(({ payload }) => payload.status === 'uncertain').length, 1)
      store.close()
    }
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
