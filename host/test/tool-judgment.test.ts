import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toolImages } from '../src/execution.ts'
import type { ToolImage } from '../src/execution.ts'
import { LocalJudgment } from '../src/judgment.ts'
import type { JudgeBatchRequest, JudgmentOptions } from '../src/judgment.ts'
import { LocalStore } from '../src/store.ts'
import { TaskEngine } from '../src/task-engine.ts'
import { ToolApprovalBroker } from '../src/tool-approval.ts'
import { ToolEvidenceArchive } from '../src/tool-judgment.ts'
import { ToolRun } from '../src/tool-run.ts'
import { CodingWorkspace } from '../src/workspace.ts'

function setup(store: LocalStore, modes: JudgmentOptions['modes'], stop = new AbortController()) {
  const calls: JudgeBatchRequest[] = []
  const judgment = new LocalJudgment(store, {
    policy: (point) => ({
      mode: modes?.[point] ?? 'off', allowScopedEvidence: true,
      judge: {
        async evaluate() { throw new Error('Expected a batch') },
        async evaluateBatch(request) {
          calls.push(request)
          return { items: request.items.map((_, index) => ({ output: request.id === 'tool.admission' ? index !== 0 : index === 1 })) }
        },
      },
    }),
  })
  const tasks = new TaskEngine(store)
  const { taskId } = tasks.create({ requestId: 'classified-read', cwd: process.cwd(), goal: 'Find configuration' })
  const task = tasks.start(taskId)
  const event = { taskId, taskNodeId: task.rootNodeId, taskAttemptId: task.attemptId, agentRunId: 'agent-run', type: '', payload: {} }
  const archive = new ToolEvidenceArchive(store)
  const run = new ToolRun(tasks, new ToolApprovalBroker(), judgment, archive)
  const workspace = new CodingWorkspace(process.cwd())
  const wrap = (name: string, result: unknown, authorize = () => true) =>
    run.wrap({ name, effect: 'read', description: '', parameters: {}, execute: async () => result },
      workspace, () => event, stop.signal, authorize, undefined, undefined, task.goal)
  return { event, wrap, run, calls, tasks, stop, archive }
}

test('Active reranks only authorized search candidates and preserves every hit', async () => {
  const store = new LocalStore(':memory:')
  try {
    const { wrap, run, calls } = setup(store, { 'files.locate': 'active' })
    const result = { ok: true, paths: ['private/a.ts', 'internal/z.ts', 'component/b.ts'], truncated: true }
    assert.deepEqual(await wrap('search_files', result).execute('search', {}), {
      ...result, paths: ['internal/z.ts', 'private/a.ts', 'component/b.ts'],
    })
    assert.deepEqual(calls[0].items.map(item => item.label), ['a.ts', 'z.ts', 'b.ts'])
    assert.ok(!JSON.stringify(calls[0].items).includes('private/'))
    await run.close()
  } finally { store.close() }
})

test('Active admission archives complete evidence and checks ownership, policy, cancellation and image preservation', async () => {
  const store = new LocalStore(':memory:')
  try {
    const { wrap, run, event, calls, tasks, archive, stop } = setup(store, { 'tool.admission': 'active' })
    const frames = Array.from({ length: 8 }, (_, index) =>
      ({ cursor: index + 1, stream: index === 0 ? 'stderr' : 'stdout', text: 'local-output:' + String(index).repeat(500) }))
    const original = { ok: true, frames, cursor: frames.length, hasMore: false }
    const images: ToolImage[] = [{ bytes: Buffer.from([1, 2, 3]), width: 5, height: 5 }]
    let granted = true
    let enabled = true
    const replay = run.replayTool(() => event, stop.signal, tool => tool === 'process_output' && enabled)!
    const output = await wrap('process_output', { ...original, [toolImages]: images }, () => granted).execute('long-output', {}) as
      typeof original & { evidenceId: string; [toolImages]: ToolImage[] }
    assert.notDeepEqual(output.frames, frames)
    assert.deepEqual(output.frames[0], frames[0])
    assert.equal(output.cursor, original.cursor)
    assert.equal(output[toolImages], images)
    assert.ok(!JSON.stringify(calls[0]).includes('local-output'))
    const input = { evidenceId: output.evidenceId }
    assert.deepEqual(await replay.execute('replay', input), original)
    assert.equal(archive.replay({ ...event, agentRunId: 'other' }, output.evidenceId, () => true), undefined)
    assert.equal(archive.replay({ ...event, taskId: 'other' }, output.evidenceId, () => true), undefined)
    granted = false
    assert.equal((await replay.execute('revoked', input) as { ok: boolean }).ok, false)
    granted = true
    enabled = false
    assert.equal((await replay.execute('disabled', input) as { ok: boolean }).ok, false)
    const visual = await wrap('browser_screenshot', { ok: true, [toolImages]: images }).execute('visual', {}) as { [toolImages]: ToolImage[] }
    assert.equal(visual[toolImages], images)
    stop.abort()
    enabled = true
    assert.equal((await replay.execute('stopped', input) as { ok: boolean }).ok, false)
    assert.deepEqual(tasks.operations(event.taskId).map(item => item.status), ['succeeded', 'succeeded'])
    await run.close()
  } finally { store.close() }
})

test('Shadow leaves external output alone while Active masks a detected passage without exposing it to replay', async () => {
  for (const mode of ['shadow', 'active'] as const) {
    const store = new LocalStore(':memory:')
    try {
      const { wrap, run, calls, event, stop } = setup(store, { 'tool.injection': mode })
      const replay = run.replayTool(() => event, stop.signal, () => true)!
      const source = { ok: true, untrusted: true, title: 'Example', text: 'test-canary', url: 'https://example.com/' }
      const output = await wrap('web_fetch', source).execute('fetch', {}) as typeof source & { evidenceId?: string }
      assert.ok(calls.length)
      if (mode === 'shadow') assert.deepEqual(output, source)
      else {
        assert.ok(output.evidenceId)
        assert.doesNotMatch(output.text, /test-canary/u)
        assert.doesNotMatch(JSON.stringify(await replay.execute('replay', { evidenceId: output.evidenceId })), /test-canary/u)
        const archived = store.get<{ original: typeof source }>('tool-judge-evidence', output.evidenceId)
        assert.equal(archived?.original.text, source.text)
      }
      assert.doesNotMatch(JSON.stringify(store.events(event.taskId)), /test-canary/u)
      await run.close()
    } finally { store.close() }
  }
})
