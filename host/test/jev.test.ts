import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { coreJudgmentPoints, defaultJevModes, jevEndpoint, judgmentPoints, openCodeFreeJudgeModel, openCodeJudgeEndpoint, parseJevSettings, parseJudgeCredentials, secondaryJudgmentPoints } from '../../shared/contracts/jev.ts'
import type { JevStatus } from '../../shared/contracts/jev.ts'
import { JevConfiguration } from '../src/jev-settings.ts'
import { LocalJudgment } from '../src/judgment.ts'
import type { JudgmentOptions } from '../src/judgment.ts'
import { LocalStore } from '../src/store.ts'
import { telemetryEvent } from '../src/telemetry-projection.ts'
import { openCodeJudgeFetch } from '../src/jev-transport.ts'
import { Response as ProxyResponse } from 'undici'

const key = 'synthetic-jev-test-key'
const valid = (p = 0.01) => Response.json({
  model: 'jev-1.14.0', answers: { verdict: { type: 'noul', noul: p } },
  usage: { input_tokens: 100, output_tokens: 5 },
})
const point = 'delegation.worth'

test('desktop proxy dispatch is scoped to the OpenCode System One URL', async () => {
  const calls: RequestInit[] = []
  const direct: typeof fetch = async (_input, options) => {
    calls.push(options ?? {})
    return valid()
  }
  const routeFetch = openCodeJudgeFetch('http://127.0.0.1:8080', direct, async (_input, options) => {
    calls.push(options as RequestInit)
    return new ProxyResponse()
  })
  assert.ok(routeFetch)
  assert.equal(openCodeJudgeFetch('http://user@proxy:8080'), undefined)
  await routeFetch(openCodeJudgeEndpoint, { method: 'POST' })
  await routeFetch(jevEndpoint, { method: 'POST' })
  assert.ok('dispatcher' in calls[0])
  assert.equal(calls[0].redirect, 'error')
  assert.ok(!('dispatcher' in calls[1]))
})

test('System One routes keep credentials bound to the exact endpoint and preserve old TypeSafe settings', async () => {
  const requests: { url: unknown; auth: string | null; model: string }[] = []
  const { store, settings, decide, last } = fixture(async (url, init) => {
    requests.push({ url, auth: new Headers(init?.headers).get('authorization'), model: JSON.parse(String(init?.body)).model })
    return valid()
  })
  try {
    const { settings: original } = settings.status()
    const { provider, endpoint, ...legacy } = original
    assert.deepEqual(parseJevSettings(legacy, true), original)
    const oldModes = Object.fromEntries(['collaboration.mode', 'delegation.worth', 'model.task_fit', 'context.relevance', 'handoff.sufficiency', 'task.replan'].map(id => [id, 'shadow']))
    const oldSettings = { ...original, enabled: true, modes: oldModes }
    assert.equal(parseJevSettings(oldSettings), undefined)
    const migrated = parseJevSettings(oldSettings, true)
    assert.equal(migrated?.enabled, true)
    assert.equal(migrated?.modes['collaboration.mode'], 'shadow')
    assert.equal(migrated?.modes['turn.completion'], 'shadow')
    assert.equal(migrated?.modes['tool.admission'], 'off')
    assert.equal(Object.keys(migrated?.modes ?? {}).length, judgmentPoints.length)
    assert.deepEqual(original.modes, defaultJevModes())
    assert.equal(coreJudgmentPoints.every(({ id }) => original.modes[id] === 'active'), true)
    assert.equal(secondaryJudgmentPoints.every(({ id }) => original.modes[id] === 'off'), true)
    const oldSixteenModes = {
      'collaboration.mode': 'shadow', 'delegation.worth': 'off', 'model.task_fit': 'off', 'context.relevance': 'off',
      'handoff.sufficiency': 'off', 'task.replan': 'off', 'input.preflight': 'off', 'task.frame': 'off',
      'skills.disclosure': 'off', 'tool.admission': 'off', 'memory.capture': 'off', 'files.locate': 'off',
      'tool.injection': 'off', 'turn.completion': 'shadow', 'turn.continue': 'active', 'swarm.patch': 'off',
    }
    assert.equal(parseJevSettings({ ...original, modes: oldSixteenModes }), undefined)
    const migratedSixteen = parseJevSettings({ ...original, modes: oldSixteenModes }, true)
    assert.equal(migratedSixteen?.modes['turn.completion'], 'active')
    assert.equal(Object.keys(migratedSixteen?.modes ?? {}).length, judgmentPoints.length)
    const openCode = { ...original, enabled: true, provider: 'opencode' as const, endpoint: openCodeJudgeEndpoint,
      model: openCodeFreeJudgeModel, modes: { ...original.modes, [point]: 'shadow' as const } }
    const custom = { ...openCode, provider: 'custom' as const, endpoint: 'https://example.com/v1/systemone', model: 'vendor/decision-2' }
    assert.ok(!parseJevSettings({ ...openCode, endpoint: custom.endpoint }))
    assert.ok(!parseJevSettings({ ...custom, endpoint: 'https://example.com/v1/systemone?token=secret' }))
    assert.ok(!parseJevSettings({ ...custom, endpoint: 'http://example.com/v1/systemone' }))
    assert.ok(parseJevSettings({ ...custom, endpoint: 'http://127.0.0.1:8700/v1/systemone' }))
    assert.equal(parseJudgeCredentials({ [custom.endpoint]: 'oc_sk_synthetic' }), undefined)
    settings.save(openCode)
    assert.equal(await decide(), true)
    assert.equal(last().fallbackReason, 'missing_key')
    assert.deepEqual(requests, [])
    settings.setKey('oc_sk_synthetic')
    assert.equal(await decide(), true)
    assert.equal((last().usage as Record<string, unknown>).estimatedCostUsd, 0)
    settings.save(custom)
    assert.equal(settings.status().credential, 'missing')
    settings.setKey('custom-synthetic')
    assert.equal(await decide(), true)
    assert.equal((last().usage as Record<string, unknown>).estimatedCostUsd, undefined)
    settings.save(original)
    await settings.test()
    assert.deepEqual(requests, [
      { url: openCodeJudgeEndpoint, auth: 'Bearer oc_sk_synthetic', model: openCodeFreeJudgeModel },
      { url: custom.endpoint, auth: 'Bearer custom-synthetic', model: custom.model },
      { url: jevEndpoint, auth: 'Bearer ' + key, model: original.model },
    ])
  } finally { store.close() }
})

function fixture(request: typeof fetch, options: Partial<JudgmentOptions> = {}) {
  const store = new LocalStore(':memory:')
  const settings = new JevConfiguration(store, key, request)
  const kernel = new LocalJudgment(store, { ...settings.judgmentOptions(), ...options })
  const taskId = randomUUID()
  const last = () => telemetryEvent(store.events(taskId).at(-1)!).payload
  return { store, settings, last, decide: (input: Record<string, unknown> = {}, signal?: AbortSignal,
    allowed: boolean[] = [true, false]) =>
    kernel.decide({ taskId, type: 'unused', payload: {} }, point, input, true, allowed, [], { signal }) }
}

test('Jev defaults off, validates settings, records Shadow and applies only allowed Active choices', async (t) => {
  const envSecret = 'zlo-env-secret-value-9988'
  process.env.ZLO_JEV_TEST_SECRET_TOKEN = envSecret
  t.after(() => { delete process.env.ZLO_JEV_TEST_SECRET_TOKEN })
  let calls = 0
  const { store, settings, last, decide } = fixture(async (url, init) => {
    calls++
    assert.equal(url, jevEndpoint)
    assert.equal(init?.redirect, 'error')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + key)
    const { state } = JSON.parse(String(init?.body))
    for (const marker of [key, envSecret, 'sk-testing-0123456789', 'oc_sk_other_redaction_test', 'secret-cookie', 'private-file']) {
      assert.ok(!JSON.stringify(state).includes(marker))
    }
    return valid()
  })
  try {
    const { settings: current } = settings.status()
    assert.equal(current.enabled, false)
    assert.deepEqual(Object.keys(current.modes), judgmentPoints.map(({ id }) => id))
    assert.ok(!parseJevSettings({ ...current, endpoint: 'http://localhost' }))
    assert.ok(!parseJevSettings({ ...current, model: 'https://localhost' }))
    assert.equal(await decide(), true)
    assert.equal(calls, 0)
    current.enabled = true
    settings.save(current)
    assert.equal(await decide(), true)
    assert.equal(calls, 0)
    current.modes[point] = 'shadow'
    settings.save(current)
    const sensitive = { goal: 'Check ' + key + ' ' + envSecret + ' oc_sk_other_redaction_test\nAuthorization: Bearer sk-testing-0123456789\nCookie: secret-cookie\nfix SVG',
      contents: 'private-file' }
    assert.equal(await decide(sensitive), true)
    assert.equal(last().shadow, false)
    assert.equal(last().judgeOutput, false)
    assert.equal(last().disagreement, true)
    assert.equal(last().judgeModel, 'jev-1.14.0')
    assert.equal(last().requestSent, true)
    assert.equal((last().usage as Record<string, number>).estimatedCostUsd, 100 * 0.042 / 1_000_000)
    assert.ok(!JSON.stringify(last()).includes('fix SVG'))
    current.modes[point] = 'active'
    settings.save(current)
    assert.equal(await decide(), false)
    assert.equal(await decide({}, undefined, [true]), true)
    assert.equal(last().fallbackReason, 'no_choice')
    assert.equal(last().requestSent, false)
    assert.equal(calls, 2)
    settings.setKey(null)
    assert.equal(await decide(), true)
    assert.equal(last().fallbackReason, 'missing_key')
    assert.equal(settings.status().credential, 'missing')
    assert.equal(calls, 2)
  } finally { store.close() }
})

test('Jev falls back on transport failure, malformed or uncertain decisions, invalid credentials, rate limit and deadline', async () => {
  const cases: [string, typeof fetch][] = [
    ['unavailable', async () => { throw new Error(key) }],
    ['invalid_response', async () => Response.json({ model: 'jev-latest', answers: { verdict: { type: 'noul', noul: 3 } } })],
    ['uncertain', async () => valid(0.5)],
    ['unauthorized', async () => new Response(key, { status: 401 })],
    ['rate_limited', async () => new Response(key, { status: 429 })],
    ['billing', async () => new Response(key, { status: 402 })],
    ['timeout', async (_url, init) => { await delay(5000, undefined, { signal: init?.signal ?? undefined }); return valid() }],
  ]
  for (const [reason, request] of cases) {
    let calls = 0
    const { store, settings, last, decide } = fixture((...args) => { calls++; return request(...args) }, { timeoutMs: 30 })
    try {
      const { settings: next } = settings.status()
      settings.save({ ...next, enabled: true, modes: { ...next.modes, [point]: 'active' } })
      assert.equal(await decide(), true)
      assert.equal(last().fallbackReason, reason)
      assert.ok(!JSON.stringify(last()).includes(key))
      assert.equal(settings.status().decisions[point]?.reason, reason)
      if (reason === 'rate_limited') {
        assert.equal(await decide(), true)
        assert.equal(last().requestSent, false)
        assert.equal(calls, 1)
      }
    } finally { store.close() }
  }
})

test('Jev enforces no local request limit, supports smart circuit breakers and 64k-scale evidence, and isolates per-point changes', async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let waiting = false
  let calls = 0
  let sawLargeGoal = false
  let sawLargeSummary = false
  const { store, settings, last, decide } = fixture(async (_url, init) => {
    calls++
    const { state } = JSON.parse(String(init?.body))
    if (state.sample) assert.deepEqual(state, { sample: 'The build passed.' })
    if (typeof state.goal === 'string' && state.goal.length === 2400) sawLargeGoal = true
    if (typeof state.summary === 'string' && state.summary.length > 4000) {
      sawLargeSummary = true
      assert.ok(!state.summary.includes(key))
    }
    if (waiting) { started.resolve(); await release.promise }
    return valid()
  })
  try {
    const { settings: next } = settings.status()
    const status: JevStatus = await settings.test()
    assert.equal(status.connection.model, 'jev-1.14.0')
    next.enabled = true
    next.modes[point] = 'active'
    settings.save({ ...next, modes: { ...next.modes } })
    for (let i = 0; i < 65; i++) assert.equal(await decide(), false)
    waiting = true
    const unaffected = decide()
    await started.promise
    settings.save({ ...next, modes: { ...next.modes, 'task.replan': 'shadow' } })
    release.resolve()
    assert.equal(await unaffected, false)
    let disable!: () => void
    const checking = fixture(async (_url, init) => {
      disable()
      await delay(4000, undefined, { signal: init?.signal ?? undefined })
      return valid()
    })
    try {
      checking.settings.save(next)
      disable = () => { checking.settings.save({ ...next, modes: { ...next.modes, [point]: 'off' } }) }
      assert.equal(await checking.decide(), true)
      assert.equal(checking.last().fallbackReason, 'configuration_changed')
    } finally { checking.store.close() }
    settings.save({ ...next, enabled: false })
    assert.equal(await decide(), true)
    assert.equal(last().mode, 'off')
    settings.save(next)
    assert.equal(await decide(), false)
    const bigGoal = 'G'.repeat(2400)
    const bigSummary = 'S'.repeat(5000) + ' ' + key
    assert.equal(await decide({ goal: bigGoal, summary: bigSummary }), false)
    assert.equal(sawLargeGoal, true)
    assert.equal(sawLargeSummary, true)
    assert.equal(calls, 69)
  } finally { store.close() }
})

test('Jev fast circuit-breaks permanent/config errors and resets cleanly on test() or credential updates', async () => {
  for (const [status, expectedReason] of [[401, 'unauthorized'], [402, 'billing'], [404, 'invalid_model']] as const) {
    let calls = 0
    let recover = false
    const { store, settings, last, decide } = fixture(async () => {
      calls++
      return recover ? valid() : new Response(key, { status })
    })
    try {
      const { settings: next } = settings.status()
      settings.save({ ...next, enabled: true, modes: { ...next.modes, [point]: 'active' } })
      assert.equal(await decide(), true)
      assert.equal(last().fallbackReason, expectedReason)
      assert.equal(last().requestSent, true)
      assert.equal(await decide(), true)
      assert.equal(last().fallbackReason, expectedReason)
      assert.equal(last().requestSent, false)
      assert.equal(calls, 1)
      recover = true
      const probed = await settings.test()
      assert.equal(probed.connection.state, 'connected')
      assert.equal(await decide(), false)
      assert.equal(calls, 3)
    } finally { store.close() }
  }
})

test('P1-5: Jev aborts hung HTTP 200 body streams on deadline and circuit-breaks consecutive timeouts', async () => {
  let calls = 0
  let streamCancelled = false
  const hungBodyFetch: typeof fetch = async () => {
    calls++
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {})
      },
      cancel() {
        streamCancelled = true
      },
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const { store, settings, last, decide } = fixture(hungBodyFetch, { timeoutMs: 35 })
  try {
    const { settings: next } = settings.status()
    settings.save({ ...next, enabled: true, modes: { ...next.modes, [point]: 'active' } })
    assert.equal(await decide(), true)
    assert.equal(last().fallbackReason, 'timeout')
    assert.equal(streamCancelled, true)
    assert.equal(await decide(), true)
    assert.equal(last().fallbackReason, 'timeout')
    assert.equal(calls, 2)
    // Third call hits the short consecutive-timeout cooldown immediately without issuing a network request.
    assert.equal(await decide(), true)
    assert.equal(last().fallbackReason, 'timeout')
    assert.equal(last().requestSent, false)
    assert.equal(calls, 2)
  } finally {
    store.close()
  }
})
