import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import type { EvaluationEvidence } from '../../shared/contracts/observatory.ts'
import { Evaluator } from '../src/evaluation.ts'
import type { EvaluatorConfig } from '../src/evaluation.ts'

const credential = 'fixture-evaluation-provider-credential'

function evidence(): EvaluationEvidence {
  return {
    taskId: 'task-1', taskRunId: 'run-1', nodeId: 'worker-1', capturedAt: '2026-01-01T00:00:00Z',
    goal: 'Implement a welcome page.', constraints: ['No external requests.'],
    artifacts: [{ path: 'index.html', digest: 'fixture-digest', bytes: 22, excerpt: '<h1>Hello, world</h1>' }],
    operations: [{ id: 'tool-1', tool: 'create_text_file', status: 'succeeded', effect: 'write' }],
    structure: ['index.html'], limitations: [],
  }
}

function assessment(verdict: 'pass' | 'fail' | 'uncertain' = 'pass') {
  const score = verdict === 'pass' ? 4 : verdict === 'fail' ? 1 : null
  const dimension = () => ({ score, rationale: 'Observed the checked-in markup.', evidence: ['artifact:0'] })
  return { verdict, scores: { completion: dimension(), correctness: dimension(), quality: dimension() }, evidence: ['artifact:0'],
    issues: verdict === 'fail' ? ['A required heading is missing.'] : [], unknowns: verdict === 'uncertain' ? ['Behavior is not established.'] : [] }
}

function modelResponse(content: unknown = assessment(), finish = 'stop', usage: unknown = { prompt_tokens: 30, completion_tokens: 12 }) {
  return Response.json({ choices: [{ finish_reason: finish, message: { content: JSON.stringify(content) } }], usage })
}

function evaluator(fetch: typeof globalThis.fetch, config: EvaluatorConfig = {}) {
  return new Evaluator({ fetch, provider: 'deepseek', model: 'deepseek-flash', apiKey: credential,
    inputUsdPerMillion: 1, outputUsdPerMillion: 2, ...config })
}

test('conclusive checks stay deterministic and missing evidence stays uncertain', async () => {
  const judge = evaluator(async () => assert.fail('A deterministic verdict must skip the model'))
  const input = evidence()
  const options = { useModel: true }
  const passed = await judge.evaluate({ ...input, artifacts: [], verification: { verdict: 'verified', passed: true, basis: 'workspace_path' } }, options)
  assert.equal(passed.method, 'deterministic')
  assert.equal(passed.verdict, 'pass')
  assert.equal(passed.scores.correctness.score, 5)
  assert.equal(passed.scores.quality.score, null)
  assert.deepEqual(passed.evidence, ['verification'])
  assert.deepEqual(passed.usage, { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, complete: true })
  const failed = await judge.evaluate({ ...input, verification: { verdict: 'failed', passed: false, evidence: 'workspace_command_failed' } }, options)
  assert.equal(failed.verdict, 'fail')
  assert.equal(failed.scores.correctness.score, 0)
  const missing = await judge.evaluate({ ...input, artifacts: [] }, options)
  assert.equal(missing.verdict, 'uncertain')
  assert.equal(missing.scores.completion.score, null)
  assert.equal((await judge.evaluate(input)).verdict, 'uncertain')
  assert.equal((await judge.evaluate({ ...input, verification: { verdict: 'failed', passed: false, evidence: 'project_command_not_authorized' } })).verdict, 'uncertain')
  const changed = await judge.evaluate({ ...input, verification: { verdict: 'verified', passed: true },
    snapshotVerification: { verdict: 'failed', passed: false, evidence: 'workspace_file_missing_expected_text' } })
  assert.equal(changed.verdict, 'fail')
  assert.equal(missing.rounds, 0)
})

test('a real provider wire request is isolated, credential scrubbed and separately accounted', async () => {
  const input = evidence()
  input.verification = { verdict: 'verified', passed: true, basis: 'workspace_path' }
  input.goal += '\nCookie: application-secret-cookie'
  input.artifacts[0].diff = '+ Authorization: Bearer ' + credential
  const snapshot = structuredClone(input)
  const observed: string[] = []
  const judge = evaluator(async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions')
    assert.equal(options?.redirect, 'error')
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer ' + credential)
    const payload = JSON.parse(String(options?.body))
    const material = JSON.parse(payload.messages[1].content)
    observed.push(material.goal.text)
    assert.equal(payload.model, 'deepseek-flash')
    assert.equal(payload.max_tokens, 256)
    assert.deepEqual(payload.thinking, { type: 'disabled' })
    assert.equal(payload.tools, undefined)
    assert.equal(material.artifacts[0].ref, 'artifact:0')
    const output = assessment()
    output.issues = ['Cookie: application-secret-cookie', credential]
    return modelResponse(output)
  }, { maxTokens: 256 })
  const result = await judge.evaluate(input, { useModel: true })
  assert.equal(result.status, 'completed')
  assert.equal(result.verdict, 'pass')
  assert.equal(result.method, 'model')
  assert.equal(result.taskRunId, input.taskRunId)
  assert.equal(result.nodeId, input.nodeId)
  assert.equal(result.rounds, 1)
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 12, estimatedCostUsd: 0.000054, complete: true })
  assert.match(observed[0], /\[redacted\]/u)
  assert.doesNotMatch(observed[0], /application-secret-cookie/u)
  assert.doesNotMatch(JSON.stringify(result), /application-secret-cookie|fixture-evaluation-provider-credential/u)
  assert.deepEqual(input, snapshot)
})

test('model judgments report fail or uncertain and reject invented evidence references', async () => {
  const input = evidence()
  const make = (verdict: 'fail' | 'uncertain') => evaluator(async (_, options) => {
    const payload = JSON.parse(String(options?.body))
    assert.equal(payload.max_completion_tokens, 1600)
    assert.equal(payload.store, false)
    return modelResponse(assessment(verdict))
  }, { provider: 'openai', model: 'gpt-4.1-mini' })
  assert.equal((await make('fail').evaluate(input, { useModel: true })).verdict, 'fail')
  const uncertain = await make('uncertain').evaluate(input, { useModel: true })
  assert.equal(uncertain.status, 'completed')
  assert.equal(uncertain.verdict, 'uncertain')
  const invented = evaluator(async () => modelResponse({ ...assessment(), evidence: ['artifact:999'] }))
  const refused = await invented.evaluate(input, { useModel: true })
  assert.equal(refused.verdict, 'uncertain')
  assert.equal(refused.status, 'failed')
  assert.equal(refused.usage.complete, true)
})

test('follow-up inspection only uses authorized additional detail and respects the shared token budget', async () => {
  const input = evidence()
  input.artifacts[0].excerpt = 'a'.repeat(1000) + 'more detail'
  input.artifacts[0].diff = '+ changed heading'
  const limits: number[] = []
  const judge = evaluator(async (_, options) => {
    const payload = JSON.parse(String(options?.body))
    const artifact = JSON.parse(payload.messages[1].content).artifacts[0]
    limits.push(payload.max_tokens)
    if (limits.length === 1) {
      assert.equal(artifact.excerpt.length, 1000)
      assert.equal(artifact.diff, undefined)
      return modelResponse({ ...assessment('uncertain'), inspect: ['artifact:0'] })
    }
    assert.match(artifact.excerpt, /more detail/u)
    assert.equal(artifact.diff, '+ changed heading')
    return modelResponse()
  }, { maxRounds: 2, maxTokens: 512 })
  const result = await judge.evaluate(input, { useModel: true })
  assert.equal(result.verdict, 'pass')
  assert.deepEqual(limits, [256, 500])
  assert.deepEqual(result.usage, { inputTokens: 60, outputTokens: 24, estimatedCostUsd: 0.000108, complete: true })
})

test('configured budgets prevent excess input, repeated retries and oversized provider output', async () => {
  const input = evidence()
  const noRequests = async () => assert.fail('Request exceeded budget')
  const lowOutput = await evaluator(noRequests, { maxTokens: 127 }).evaluate(input, { useModel: true })
  assert.equal(lowOutput.status, 'budget_exhausted')
  assert.equal(lowOutput.rounds, 0)
  const lowInput = await evaluator(noRequests, { maxInputBytes: 1024 }).evaluate(input, { useModel: true })
  assert.equal(lowInput.status, 'budget_exhausted')
  assert.equal(lowInput.rounds, 0)
  const providerOverran = await evaluator(async () => modelResponse(assessment(), 'stop', { prompt_tokens: 5, completion_tokens: 130 }),
    { maxTokens: 128 }).evaluate(input, { useModel: true })
  assert.equal(providerOverran.status, 'budget_exhausted')
  assert.equal(providerOverran.usage.outputTokens, 130)
  const tooLarge = await evaluator(async () => new Response('a'.repeat(100 * 1024))).evaluate(input, { useModel: true })
  assert.equal(tooLarge.status, 'failed')
  assert.equal(tooLarge.usage.complete, false)
})

test('one transient retry consumes request capacity and preserves unknown billing for a failed attempt', async () => {
  const limits: number[] = []
  const judge = evaluator(async (_, options) => {
    limits.push(JSON.parse(String(options?.body)).max_tokens)
    return limits.length === 1 ? new Response('redacted provider detail', { status: 503 }) : modelResponse()
  }, { maxRounds: 2, maxTokens: 512 })
  const result = await judge.evaluate(evidence(), { useModel: true })
  assert.equal(result.verdict, 'pass')
  assert.deepEqual(limits, [256, 256])
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 12, estimatedCostUsd: null, complete: false })
})

test('provider errors cannot publish credentials in result messages or diagnostics', async (t) => {
  const diagnostic = t.mock.method(console, 'error', () => {})
  const log = t.mock.method(console, 'log', () => {})
  const failure = await evaluator(async () => { throw new Error('Provider error: Authorization: Bearer ' + credential) })
    .evaluate(evidence(), { useModel: true })
  assert.equal(failure.status, 'failed')
  assert.equal(failure.usage.complete, false)
  assert.doesNotMatch(JSON.stringify(failure), /Authorization|fixture-evaluation-provider-credential/u)
  assert.equal(diagnostic.mock.callCount(), 0)
  assert.equal(log.mock.callCount(), 0)
})

test('a pending request obeys evaluation timeout and user cancellation', async () => {
  const pending: typeof fetch = async (_, options) => {
    await delay(2000, undefined, { signal: options?.signal ?? undefined })
    return modelResponse()
  }
  const timed = await evaluator(pending, { timeoutMs: 15 }).evaluate(evidence(), { useModel: true })
  assert.equal(timed.status, 'timed_out')
  assert.equal(timed.usage.inputTokens, null)
  const abort = new AbortController()
  const result = evaluator(pending).evaluate(evidence(), { useModel: true, signal: abort.signal })
  abort.abort()
  assert.equal((await result).status, 'cancelled')
  const before = await evaluator(async () => assert.fail('A cancelled job should not use the model'))
    .evaluate(evidence(), { useModel: true, signal: abort.signal })
  assert.equal(before.rounds, 0)
})
