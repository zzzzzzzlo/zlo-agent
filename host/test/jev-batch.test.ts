import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JevConfiguration } from '../src/jev-settings.ts'
import { LocalJudgment } from '../src/judgment.ts'
import { LocalStore } from '../src/store.ts'

const event = { taskId: 'task', type: 'task.test', payload: {} }
const key = 'fixture-jev-key'
const point = 'skills.disclosure'

test('System One batches named predicates and falls back independently for low-confidence or malformed answers', async () => {
  const store = new LocalStore(':memory:')
  let calls = 0
  try {
    const configuration = new JevConfiguration(store, key, async (_input, options) => {
      calls++
      const body = JSON.parse(String(options?.body))
      assert.equal(body.state.goal, 'fix styles')
      assert.deepEqual(Object.keys(body.questions), ['item_0', 'item_1', 'item_2'])
      assert.equal(Object.values<{ type: string }>(body.questions).every(question => question.type === 'noul'), true)
      assert.equal(JSON.stringify(body.state).includes('fixture-jev-key'), false)
      return Response.json({
        model: 'jev-1.14.0',
        answers: { item_0: { type: 'noul', noul: 0.09 }, item_1: { type: 'noul', noul: 0.51 }, item_2: { type: 'score', noul: 1 } },
        usage: { input_tokens: 100, output_tokens: 9 },
      })
    })
    const judge = new LocalJudgment(store, configuration.judgmentOptions())
    const entries = [
      { baseline: true, label: 'style skill', excerpt: 'Fix styles with fixture-jev-key' },
      { baseline: true, label: 'test skill' },
      { baseline: false, label: 'fallback skill' },
    ]
    assert.deepEqual(await judge.decideBatch(event, point, { goal: 'fix styles' }, entries), [true, true, false])
    assert.equal(calls, 0)
    const { settings } = configuration.status()
    configuration.save({ ...settings, enabled: true, modes: { ...settings.modes, [point]: 'shadow' } })
    assert.deepEqual(await judge.decideBatch(event, point, { goal: 'fix styles' }, entries), [true, true, false])
    configuration.save({ ...settings, enabled: true, modes: { ...settings.modes, [point]: 'active' } })
    assert.deepEqual(await judge.decideBatch(event, point, { goal: 'fix styles' }, entries), [false, true, false])
    assert.equal(calls, 2)
    const records = store.events(event.taskId)
    assert.equal(records.length, 3)
    assert.equal(records[1].payload.disagreement, true)
    assert.deepEqual(records[2].payload.batch, {
      baseline: [true, true, false], output: [false, true, false], judgeOutput: [false, null, null],
      fallbackReasons: [null, 'uncertain', 'invalid_response'],
    })
    assert.equal(records[2].payload.requestSent, true)
    assert.deepEqual(records[2].payload.usage, { input: 100, output: 9, estimatedCostUsd: 100 * 0.042 / 1_000_000 })
    for (const sample of ['fix styles', 'style skill', key]) assert.equal(JSON.stringify(records).includes(sample), false)
  } finally { store.close() }
})

test('cancelled batches retain every baseline and static judges do not receive scoped excerpts', async () => {
  const store = new LocalStore(':memory:')
  try {
    const stopped = new AbortController()
    let invoked = 0
    const judge = new LocalJudgment(store, {
      modes: { [point]: 'active' },
      judge: {
        async evaluate() { throw new Error('Unexpected scalar decision') },
        async evaluateBatch({ items }) {
          invoked++
          assert.deepEqual(items, [{ baseline: true }, { baseline: false }])
          stopped.abort()
          return { items: [{ output: false }, { output: true }] }
        },
      },
    })
    const entries = [{ baseline: true, excerpt: 'worktree excerpt' }, { baseline: false }]
    assert.deepEqual(await judge.decideBatch(event, point, {}, entries, [], { signal: stopped.signal }), [true, false])
    assert.equal(invoked, 1)
    assert.deepEqual(store.events(event.taskId).at(-1)?.payload.batch, {
      baseline: [true, false], output: [true, false], judgeOutput: [null, null], fallbackReasons: ['cancelled', 'cancelled'],
    })
    await assert.rejects(judge.decideBatch(event, point, {}, Array.from({ length: 9 }, () => ({ baseline: true }))), RangeError)
  } finally { store.close() }
})
