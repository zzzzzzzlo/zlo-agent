import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { EventDraft } from '../src/contracts/domain.ts'
import { LocalJudgment } from '../src/judgment.ts'
import { ContextBudgetError, LocalMemory, ScopedContext } from '../src/memory.ts'
import { LocalStore } from '../src/store.ts'

const event: EventDraft = { taskId: 'task', taskRunId: 'run', agentRunId: 'agent-run', type: '', payload: {} }
const scope = JSON.stringify(['workspace', 'test', 'provider-a'])
const otherProvider = JSON.stringify(['workspace', 'test', 'provider-b'])
const secret = 'sk-' + 'synthetic_test_only_'.repeat(3)

test('memory persists separate evidence-backed facts and experiences and rejects credential-like data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zlo-memory-'))
  const path = join(root, 'memory.sqlite')
  let store = new LocalStore(path)
  try {
    const memory = new LocalMemory(store)
    const oldFact = { kind: 'fact', key: 'node', text: 'Build uses Node 22', sourceRefs: ['operation-1'] } as const
    const newFact = { ...oldFact, text: 'Build uses Node 24', sourceRefs: ['operation-2'] }
    memory.capture(event, scope, [oldFact, { kind: 'experience', text: '构建工具 TypeScript测试', sourceRefs: ['operation-3'] }])
    memory.capture(event, scope, [newFact])
    memory.capture(event, scope, [oldFact, newFact])
    memory.capture(event, scope, [
      { kind: 'fact', text: 'Authorization: Bearer fake_credential', sourceRefs: ['op'] },
      { kind: 'experience', text: 'Build private token ' + secret, sourceRefs: ['op'] },
      { kind: 'experience', text: 'Build receipt', sourceRefs: [secret] },
      { kind: 'fact', text: 'An unsourced fact', sourceRefs: [] },
    ])
    assert.equal(store.events('task').length, 2)
    const events = JSON.stringify(store.events('task'))
    for (const privateText of ['Build uses', 'operation-2', 'private token', secret, scope]) {
      assert.equal(events.includes(privateText), false)
    }
    assert.equal(store.events('task')[1].taskRunId, 'run')
    assert.equal(store.events('task')[1].agentRunId, 'agent-run')
    const before = memory.recall(scope, 'build node')
    assert.equal(before.length, 1)
    assert.equal(before[0].kind, 'fact')
    assert.equal(before[0].text, newFact.text)
    assert.equal(before[0].version, 2)
    assert.equal(before[0].supersedes, 1)
    assert.deepEqual(before[0].sourceRefs, ['operation-2'])
    assert.deepEqual(memory.recall(otherProvider, 'build node'), [])
    assert.equal(memory.recall(scope, '测试')?.[0]?.kind, 'experience')
    assert.deepEqual(memory.recall(scope, 'unrelated'), [])

    store.close()
    store = new LocalStore(path)
    assert.deepEqual(new LocalMemory(store).recall(scope, 'build node'), before)
    assert.equal(store.events('task').length, 2)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('memory bounds per-scope retention, writes, and retrieval', () => {
  const store = new LocalStore(':memory:')
  try {
    const memory = new LocalMemory(store)
    for (let batch = 0; batch < 10; batch++) {
      memory.capture(event, scope, Array.from({ length: 13 }, (_, index) => ({
        kind: 'fact',
        text: 'Shared feature-' + batch + '-' + index,
        sourceRefs: ['operation-' + batch + '-' + index],
      })))
    }
    assert.equal(store.events('task').every(({ payload }) => payload.count === 12), true)
    const [records] = store.list<unknown[]>('memory-scopes')
    assert.equal(records.length, 96)
    const entries = memory.recall(scope, 'shared')
    assert.equal(entries.length, 8)
    assert.equal(entries[0].text, 'Shared feature-9-11')
    assert.deepEqual(memory.recall(scope, 'shared', 0), [])
    assert.throws(() => memory.recall(scope, 'shared', 1000), /recall limit/)
  } finally {
    store.close()
  }
})

test('context selects eligible memory within its byte budget and only publishes references', async () => {
  const store = new LocalStore(':memory:')
  try {
    const memory = new LocalMemory(store)
    memory.capture(event, scope, [
      { kind: 'fact', text: 'Router schema requires a lock', sourceRefs: ['operation-1'] },
      { kind: 'experience', text: 'Router invocation uses retries', sourceRefs: ['operation-2'] },
    ])
    const context = new ScopedContext(memory, new LocalJudgment(store, {
      modes: { 'context.relevance': 'active' },
      judge: {
        async evaluate(request) {
          assert.equal(request.id, 'context.relevance')
          assert.deepEqual(request.allowed, [0, 1])
          assert.equal(JSON.stringify(request.input).includes('Router'), false)
          return { output: 1 }
        },
      },
    }))
    const prompt = await context.build(event, { scope, goal: 'Router schema', budget: 140 })
    assert.ok(Buffer.byteLength(prompt) <= 140)
    assert.ok(prompt.startsWith('Router schema'))
    assert.ok(prompt.includes('untrusted evidence'))
    assert.ok(prompt.includes('uses retries'))
    assert.ok(!prompt.includes('requires a lock'))
    const decisions = store.events('task')
    assert.equal(decisions[1].type, 'judgment.evaluated')
    assert.equal(decisions[1].payload.baseline, 0)
    assert.equal(decisions[1].payload.output, 1)
    assert.equal(decisions[2].type, 'memory.recalled')
    assert.equal(decisions[2].payload.count, 1)
    assert.equal(JSON.stringify(decisions).includes('uses retries'), false)
    const isolated = await context.build(event, { scope: otherProvider, goal: 'Router schema' })
    assert.equal(isolated, 'Router schema')
    assert.equal(store.events('task').at(-1)?.payload.count, 0)
    await assert.rejects(context.build(event, { scope, goal: '开发😀', budget: 9 }), ContextBudgetError)
    assert.equal(await context.build(event, { scope, goal: '开发😀', budget: 10 }), '开发😀')
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(context.build(event, { scope, goal: 'ignored', signal: controller.signal }), { name: 'AbortError' })
  } finally {
    store.close()
  }
})

test('judgment enforces baseline and allowed choices across off, shadow and active modes', async () => {
  const store = new LocalStore(':memory:')
  try {
    const calls: string[] = []
    const judgment = new LocalJudgment(store, {
      modes: { 'collaboration.mode': 'shadow', 'delegation.worth': 'active', 'handoff.sufficiency': 'active' },
      judge: {
        async evaluate(request) {
          calls.push(request.id)
          switch (request.id) {
            case 'collaboration.mode': return { output: 'team', usage: { input: 3, output: 2 } }
            case 'delegation.worth': return { output: true }
            default: throw new Error(secret)
          }
        },
      },
    })
    assert.equal(await judgment.decide(event, 'model.task_fit', {}, 0, [0, 1]), 0)
    assert.equal(await judgment.decide(event, 'collaboration.mode', {
      privatePrompt: secret, nodeCount: 2, nodeOrdinal: 1, teamCandidate: true, hasDependencies: false,
    }, 'worker', ['worker', 'team'], ['node-1', secret]), 'worker')
    assert.equal(await judgment.decide(event, 'delegation.worth', {}, false, [false]), false)
    assert.equal(await judgment.decide(event, 'handoff.sufficiency', {}, true, [false, true]), true)
    assert.deepEqual(calls, ['collaboration.mode', 'delegation.worth', 'handoff.sufficiency'])
    const payloads = store.events('task').map(({ payload }) => payload)
    assert.deepEqual(payloads.map(({ judgeStatus }) => judgeStatus), ['baseline', 'valid', 'invalid', 'failed'])
    assert.equal(payloads[1].shadow, 'team')
    const references = payloads[1].evidenceRefs as string[]
    assert.ok(references.length > 0 && references.every(ref => /^sha256:[a-f0-9]{64}$/.test(ref)))
    assert.deepEqual(payloads[1].features, { nodeCount: 2, nodeOrdinal: 1, teamCandidate: true, hasDependencies: false })
    assert.deepEqual(payloads[1].candidates, ['worker', 'team'])
    assert.equal(payloads[1].featureSchemaVersion, 1)
    assert.deepEqual(payloads[1].usage, { input: 3, output: 2 })
    assert.equal(JSON.stringify(payloads).includes(secret), false)
    assert.equal(JSON.stringify(payloads).includes('privatePrompt'), false)
    await assert.rejects(judgment.decide(event, 'task.replan', {}, 'retry', ['fail']), /rule baseline/)
  } finally {
    store.close()
  }
})

test('judgment event features and choices cannot persist arbitrary strings from callers', async (t) => {
  const store = new LocalStore(':memory:')
  t.after(() => store.close())
  const judgment = new LocalJudgment(store)
  await judgment.decide(event, 'model.task_fit', {
    privatePrompt: secret, candidates: [{ provider: secret, model: secret, contextWindow: 32_000, supportsText: true, estimatedCost: 0.5 }],
  }, 0, [0])
  await judgment.decide(event, 'context.relevance', {
    candidates: [{ kind: secret, rank: 0, evidenceCount: 3, estimatedBytes: 104, text: secret }],
  }, 0, [0])
  await judgment.decide(event, 'task.replan', { status: secret }, secret, [secret], [secret], {
    planRequestId: secret, delegationReceiptId: secret,
  })
  const payloads = store.events('task').map(({ payload }) => payload)
  assert.equal(JSON.stringify(payloads).includes(secret), false)
  const model = (payloads[0].features as { candidates: Record<string, unknown>[] }).candidates[0]
  assert.match(String(model.modelKey), /^sha256:[a-f0-9]{64}$/)
  assert.equal(model.estimatedCost, 0.5)
  const memory = (payloads[1].features as { candidates: Record<string, unknown>[] }).candidates[0]
  assert.deepEqual(memory, { index: 0, rank: 0, evidenceCount: 3, estimatedBytes: 104 })
  assert.equal(payloads[2].output, 'opaque:0')
})

test('a slow judge is aborted, bounded in flight, and cannot block future rule decisions', async () => {
  const store = new LocalStore(':memory:')
  const signals: AbortSignal[] = []
  const resolveCalls: Array<() => void> = []
  try {
    const judgment = new LocalJudgment(store, {
      modes: { 'task.replan': 'active' },
      timeoutMs: 10,
      judge: {
        evaluate(_request, signal) {
          signals.push(signal)
          return new Promise((resolve) => {
            resolveCalls.push(() => resolve({ output: 'retry' }))
          })
        },
      },
    })
    const run = () => judgment.decide(event, 'task.replan', {}, 'fail', ['fail', 'retry'])
    assert.deepEqual(await Promise.all(Array.from({ length: 6 }, run)), Array(6).fill('fail'))
    assert.equal(signals.length, 4)
    assert.ok(signals.every((signal) => signal.aborted))
    const statuses = store.events('task').map(({ payload }) => payload.judgeStatus)
    assert.equal(statuses.filter((status) => status === 'timed_out').length, 4)
    assert.equal(statuses.filter((status) => status === 'busy').length, 2)
    for (const resolve of resolveCalls) resolve()
    await new Promise(setImmediate)
    assert.equal(await run(), 'fail')
    assert.equal(signals.length, 5)
  } finally {
    for (const resolve of resolveCalls) resolve()
    store.close()
  }
})
