import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { EventDraft } from '../src/contracts/domain.ts'
import { LocalJudgment } from '../src/judgment.ts'
import { ContextBudgetError, LocalMemory, memoryEntryInScope, ScopedContext, workspaceMemoryScope } from '../src/memory.ts'
import { createMemoryTools } from '../src/memory-tools.ts'
import { LocalStore } from '../src/store.ts'
import { CodingWorkspace } from '../src/workspace.ts'

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

test('memory removes artificial caps, preserves >768B & clipped >8KiB notes, prioritizes durable entries on eviction, and validates recall limits', () => {
  const store = new LocalStore(':memory:')
  try {
    const memory = new LocalMemory(store)
    for (let batch = 0; batch < 10; batch++) {
      memory.capture(event, scope, Array.from({ length: 15 }, (_, index) => ({
        kind: 'fact',
        text: 'Shared architecture note batch-' + batch + ' item-' + index,
        sourceRefs: ['operation-' + batch + '-' + index],
      })))
    }
    assert.equal(store.events('task').every(({ payload }) => payload.count === 15), true)
    const [records] = store.list<unknown[]>('memory-scopes')
    assert.equal(records.length, 150)
    const defaultRecalled = memory.recall(scope, 'shared')
    assert.equal(defaultRecalled.length, 12)
    assert.equal(memory.recall(scope, 'shared', 32).length, 32)
    assert.deepEqual(memory.recall(scope, 'shared', 0), [])
    assert.throws(() => memory.recall(scope, 'shared', 1000), /recall limit/)

    // Long notes (>768 B) are preserved intact and oversized notes (>8 KiB) are clipped cleanly instead of dropped.
    const mediumNote = 'Migration checklist detail ' + 'x'.repeat(2400)
    const oversizedNote = 'Oversized architecture spec ' + 'z'.repeat(9000)
    memory.capture(event, otherProvider, [
      { kind: 'fact', key: 'medium-note', text: mediumNote, sourceRefs: ['op-med'] },
      { kind: 'fact', key: 'oversized-note', text: oversizedNote, sourceRefs: ['op-big'] },
    ])
    const storedLong = memory.list(otherProvider)
    assert.equal(storedLong.length, 2)
    assert.equal(storedLong.find(item => item.key === 'medium-note')?.text.length, mediumNote.length)
    const clippedText = storedLong.find(item => item.key === 'oversized-note')!.text
    assert.ok(Buffer.byteLength(clippedText) <= 8192)
    assert.ok(clippedText.endsWith('...'))

    // Eviction drops older non-durable facts before durable/experience entries.
    const bounded = new LocalMemory(store, { maxEntriesPerScope: 4 })
    const pruneScope = JSON.stringify(['workspace', 'prune-priority'])
    bounded.capture(event, pruneScope, [
      { kind: 'experience', durable: true, key: 'keep-exp', text: 'Run project typecheck before verification', sourceRefs: ['op-0'] },
    ])
    for (let i = 1; i <= 5; i++) {
      bounded.capture(event, pruneScope, [
        { kind: 'fact', key: 'fact-' + i, text: 'Transient edit observation ' + i, sourceRefs: ['op-' + i] },
      ])
    }
    const kept = bounded.list(pruneScope)
    assert.equal(kept.length, 4)
    assert.ok(kept.some(item => item.key === 'keep-exp'))
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
      modes: { 'collaboration.mode': 'shadow', 'delegation.worth': 'active', 'turn.completion': 'active' },
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
    assert.equal(await judgment.decide(event, 'turn.completion', {}, true, [false, true]), true)
    assert.deepEqual(calls, ['collaboration.mode', 'delegation.worth', 'turn.completion'])
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

test('P1-5: memory recall filters boilerplate stopwords and scoped context filters file facts by scopePath', async () => {
  const store = new LocalStore(':memory:')
  try {
    const memory = new LocalMemory(store)
    memory.capture(event, scope, [
      { kind: 'fact', key: 'target:a', text: 'Confirmed workspace operation create_text_file on src/FeatureA.ts', sourceRefs: ['op-1'] },
      { kind: 'fact', key: 'target:b', text: 'Confirmed workspace operation create_text_file on secret_notes/Note.md', sourceRefs: ['op-2'] },
    ])
    // Stopwords like "on", "in", "the", "workspace", "confirmed", "operation" do not trigger false-positive recalls.
    assert.deepEqual(memory.recall(scope, 'what is going on in the workspace'), [])
    assert.equal(memory.recall(scope, 'FeatureA').length, 1)

    const context = new ScopedContext(memory, new LocalJudgment(store))
    const scopedPrompt = await context.build(event, {
      scope,
      goal: 'Inspect FeatureA and secret_notes',
      filter: (entry) => {
        const match = /^Confirmed workspace operation \S+ on (.+)$/u.exec(entry.text)
        return Boolean(match && (match[1] === 'src' || match[1]!.startsWith('src/')))
      },
    })
    assert.match(scopedPrompt, /src\/FeatureA\.ts/)
    assert.doesNotMatch(scopedPrompt, /secret_notes\/Note\.md/)
  } finally {
    store.close()
  }
})

test('Codex memory alignment: BM25 subtoken/CJK bigram ranking, MEMORY.md materialization, cross-scope fallback, and memory tools', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zlo-codex-memory-'))
  const memoriesDir = join(root, 'memories')
  const projectDir = join(root, 'repo')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(projectDir, 'src'), { recursive: true })
  t.after(() => rm(root, { recursive: true, force: true }))

  const store = new LocalStore(':memory:')
  try {
    const memory = new LocalMemory(store, { memoriesDir })
    const projectScope = workspaceMemoryScope(projectDir)
    const legacyScope = JSON.stringify(['old-conv-id', 'openai'])

    // Legacy entry in [conversationId, provider] plus modern shared workspace entries.
    const legacyTarget = 'src/LegacyModule.ts'
    const legacyKey = 'op:edit_text_file:' + createHash('sha256').update(legacyTarget).digest('hex').slice(0, 24)
    memory.capture(event, legacyScope, [
      { kind: 'fact', key: legacyKey, text: 'Confirmed workspace operation edit_text_file on ' + legacyTarget, sourceRefs: ['op-legacy'] },
    ])
    memory.capture(event, projectScope, [
      { kind: 'fact', key: 'noise', text: '数据库初始化与常规构建说明', sourceRefs: ['op-1'] },
      { kind: 'fact', key: 'target-cjk', durable: true, title: '迁移回滚策略', text: '数据库迁移失败时使用逆向脚本回滚表结构并校验索引', paths: ['src/MigrationRunner.ts'], sourceRefs: ['op-2'] },
      { kind: 'experience', durable: true, key: 'verify-exp', text: 'Project verification passed using npm_typecheck after fixing FeatureAuthHandler', sourceRefs: ['op-3'] },
      { kind: 'fact', key: 'secret-note', text: 'Confirmed workspace operation create_text_file on secret_notes/Note.md', paths: ['secret_notes/Note.md'], sourceRefs: ['op-4'] },
    ])

    // CJK bigram + camelCase subtoken BM25 ranking
    const cjkHits = memory.recall(projectScope, '迁移回滚策略')
    assert.equal(cjkHits[0]?.key, 'target-cjk')
    const subtokenHits = memory.recall(projectScope, 'AuthHandler')
    assert.equal(subtokenHits[0]?.key, 'verify-exp')
    assert.equal(memory.recall(projectScope, 'MigrationRunner').length, 1)

    // Materialized MEMORY.md & memory_summary.md exist on disk
    const { readdir } = await import('node:fs/promises')
    const scopeDirs = await readdir(memoriesDir)
    assert.equal(scopeDirs.length, 2)
    const markdownFiles = await Promise.all(scopeDirs.map(dir => readFile(join(memoriesDir, dir, 'MEMORY.md'), 'utf8')))
    assert.ok(markdownFiles.some(md => md.includes('迁移回滚策略') && md.includes('Durable Experiences & Key Notes')))
    const summaryFiles = await Promise.all(scopeDirs.map(dir => readFile(join(memoriesDir, dir, 'memory_summary.md'), 'utf8')))
    assert.ok(summaryFiles.some(md => md.includes('# Memory Summary')))

    // Scoped context uses the policy shared with the memory tools.
    const judgment = new LocalJudgment(store)
    const context = new ScopedContext(memory, judgment)
    const scopedPrompt = await context.build(event, {
      scope: projectScope,
      fallbackScopes: [legacyScope],
      includePlaybook: true,
      goal: 'Check FeatureAuthHandler, LegacyModule, secret_notes and verification',
      filter: entry => memoryEntryInScope(entry, 'src'),
    })
    assert.match(scopedPrompt, /LegacyModule\.ts/)
    assert.doesNotMatch(scopedPrompt, /Project verification passed/)
    assert.match(scopedPrompt, /Workspace memory summary/)
    assert.doesNotMatch(scopedPrompt, /secret_notes\/Note\.md/)

    // Memory tools: memory_save, memory_search, memory_list + scope enforcement & secret blocking
    const workspace = new CodingWorkspace(projectDir)
    const tools = createMemoryTools(workspace, () => ({
      memory,
      judgment,
      scopesFor: () => ({ primary: projectScope, all: [projectScope, legacyScope], goal: 'inspect memory', event }),
    }))
    const search = tools.find(tool => tool.name === 'memory_search')!
    const list = tools.find(tool => tool.name === 'memory_list')!
    const save = tools.find(tool => tool.name === 'memory_save')!

    const saved = await save.execute('call-save', {
      kind: 'experience',
      title: 'Edge pipe flake avoidance',
      text: 'Run playwright desktop and observatory E2E tests sequentially to avoid port contention',
      paths: ['src/runner.ts'],
    }, undefined, { taskId: 'task', agentRunId: 'agent-run', defer() {}, onCleanup() {} }) as { ok: boolean; saved: boolean }
    assert.equal(saved.ok, true)
    assert.equal(saved.saved, true)

    const badPath = await save.execute('call-bad-path', {
      kind: 'fact',
      text: 'Outside note',
      paths: ['other/file.ts'],
    }, undefined, { taskId: 'task', agentRunId: 'agent-run', scopePath: 'src', defer() {}, onCleanup() {} }) as { ok: boolean }
    assert.equal(badPath.ok, false)

    const secretTry = await save.execute('call-secret', {
      kind: 'fact',
      text: 'api_key=' + secret,
    }, undefined, { taskId: 'task', agentRunId: 'agent-run', defer() {}, onCleanup() {} }) as { ok: boolean; saved: boolean }
    assert.equal(secretTry.ok, true)
    assert.equal(secretTry.saved, false)

    const searched = await search.execute('call-search', { query: 'playwright sequential', kind: 'experience' }, undefined, {
      taskId: 'task', agentRunId: 'agent-run', scopePath: 'src', defer() {}, onCleanup() {},
    }) as { ok: boolean; entries: { title?: string }[] }
    assert.equal(searched.ok, true)
    assert.equal(searched.entries[0]?.title, 'Edge pipe flake avoidance')

    const listedScoped = await list.execute('call-list', { limit: 20 }, undefined, {
      taskId: 'task', agentRunId: 'agent-run', scopePath: 'src', defer() {}, onCleanup() {},
    }) as { ok: boolean; entries: { text: string }[] }
    assert.equal(listedScoped.ok, true)
    assert.ok(listedScoped.entries.some(item => item.text.includes('LegacyModule.ts')))
    assert.ok(!listedScoped.entries.some(item => item.text.includes('Project verification passed')))
    assert.ok(!listedScoped.entries.some(item => item.text.includes('secret_notes/Note.md')))

    // Multi-path entries crossing outside scopePath must NOT leak to scoped Workers (requires .every, not .some).
    memory.capture(event, projectScope, [
      {
        kind: 'fact', key: 'mixed-rollout',
        text: 'Task rollout updated src/MixedIn.ts and secret_notes/TopSecret.md',
        paths: ['src/MixedIn.ts', 'secret_notes/TopSecret.md'],
        sourceRefs: ['op-mix-1'],
      },
      {
        kind: 'experience', durable: true, key: 'mixed-repair',
        text: 'Self-repair touched src/MixedIn.ts and docs/私有笔记.md',
        paths: ['src/MixedIn.ts', 'docs/私有笔记.md'],
        sourceRefs: ['op-mix-2'],
      },
    ])
    const mixedSearch = await search.execute('call-mixed-search', { query: 'MixedIn' }, undefined, {
      taskId: 'task', agentRunId: 'agent-run', scopePath: 'src', defer() {}, onCleanup() {},
    }) as { ok: boolean; entries: { text: string }[] }
    assert.equal(mixedSearch.entries.length, 0)
    const mixedList = await list.execute('call-mixed-list', { limit: 50 }, undefined, {
      taskId: 'task', agentRunId: 'agent-run', scopePath: 'src', defer() {}, onCleanup() {},
    }) as { ok: boolean; entries: { text: string }[] }
    assert.ok(mixedList.entries.every(item => !/TopSecret\.md|私有笔记\.md/.test(item.text)))
    const mixedContext = await context.build(event, {
      scope: projectScope,
      includePlaybook: true,
      goal: 'Check MixedIn',
      filter: entry => memoryEntryInScope(entry, 'src'),
    })
    assert.doesNotMatch(mixedContext, /TopSecret\.md|私有笔记\.md/)
    assert.equal(memory.recall(projectScope, 'MixedIn').length, 2)

    const scopedInvocation = { taskId: 'task', agentRunId: 'agent-run', scopePath: 'src', defer() {}, onCleanup() {} }
    const localNote = await save.execute('call-local-note', {
      kind: 'experience', text: 'Use the local runner for scoped checks', paths: [],
    }, undefined, scopedInvocation) as { saved: boolean; id: string }
    assert.equal(localNote.saved, true)
    assert.deepEqual(memory.list(projectScope).find(item => item.id === localNote.id)?.paths, ['src'])
    const replaceOutside = await save.execute('call-replace-outside', {
      kind: 'experience', key: 'verify-exp', text: 'Replacement outside the assigned scope',
    }, undefined, scopedInvocation) as { saved: boolean }
    assert.equal(replaceOutside.saved, false)
    assert.equal(memory.recall(projectScope, 'AuthHandler')[0]?.version, 1)
  } finally {
    store.close()
  }
})
