import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FakeExecution } from '../src/fake.ts'
import { LocalAgentHost } from '../src/host.ts'
import { LocalJudgment } from '../src/judgment.ts'
import { LocalStore } from '../src/store.ts'
import { TaskEngine } from '../src/task-engine.ts'
import { telemetryEvent } from '../src/telemetry-projection.ts'

const check = { path: 'demo.txt', contains: 'verified by zlo agent' }

test('file operation telemetry correlates targets within a workspace without disclosing the path or its plain hash', () => {
  const store = new LocalStore(':memory:')
  try {
    const engine = new TaskEngine(store)
    const path = 'src/example.ts'
    function settle(cwd: string, taskName: string, tool: string) {
      const { taskId } = engine.create({ requestId: taskName, goal: 'Change project files', cwd, workspaceAccess: 'write' })
      const task = engine.start(taskId)
      const event = { taskId, taskAttemptId: task.attemptId, taskNodeId: task.rootNodeId, type: '', payload: {} }
      const id = taskId + ':file'
      engine.beginTool(taskId, event, id, tool, 'write', path)
      engine.finishTool(event, id, 'succeeded')
      return telemetryEvent(store.events(taskId).findLast(item => item.type === 'tool.finished')!)
    }
    const write = settle('workspace-one', 'write-one', 'create_text_file')
    const remove = settle('workspace-one', 'remove-one', 'delete_file')
    const other = settle('workspace-two', 'write-two', 'create_text_file')
    assert.equal(JSON.stringify(write).includes(path), false)
    assert.equal(JSON.stringify(write).includes(createHash('sha256').update(path).digest('hex')), false)
    assert.match((write.payload.targetDigests as string[])[0]!, /^sha256:[a-f0-9]{64}$/)
    assert.deepEqual(write.payload.targetDigests, remove.payload.targetDigests)
    assert.notDeepEqual(write.payload.targetDigests, other.payload.targetDigests)
  } finally { store.close() }
})

test('TaskEngine rejects illegal transitions, stale plans and reused request IDs', () => {
  const store = new LocalStore(':memory:')
  try {
    const engine = new TaskEngine(store)
    const command = { requestId: 'one', goal: 'Create a file', cwd: 'ignored', check }
    const { taskId } = engine.create(command)
    assert.deepEqual(engine.create(command), { taskId })
    assert.throws(() => engine.create({ ...command, goal: 'Different' }), /different command/)
    assert.throws(() => engine.verify(taskId, { passed: true, evidence: 'none' }), /Invalid task transition/)
    assert.throws(() => engine.addTask(taskId, 'stale', 'Read', 5), /version changed/)
    assert.throws(() => engine.addTask(taskId, 'dependency', 'Read', 0, [taskId]), /no execution dependencies/)
    const worker = engine.addTask(taskId, 'leaf', 'Read', 0)
    assert.equal(worker.parentNodeId, engine.get(taskId).rootNodeId)
    assert.deepEqual(engine.addTask(taskId, 'leaf', 'Read', 0), worker)
    assert.throws(() => engine.addTask(taskId, 'excess', 'Read again', 1), /budget exhausted/)
    assert.equal(engine.resume(taskId, 'premature').accepted, false)
    engine.start(taskId)
    assert.throws(() => engine.start(taskId), /Invalid task transition/)
    assert.equal(engine.attempts(taskId).length, 1)
    assert.equal(store.events(taskId).filter((event) => event.type === 'verification.finished').length, 0)
  } finally {
    store.close()
  }
})

test('P2-1 & P2-2: UUIDv7 FIFO task ordering, Phase 2 judgment telemetry projection, and conversation model clearing', async (t) => {
  const store = new LocalStore(':memory:')
  try {
    const engine = new TaskEngine(store)
    const createdIds: string[] = []
    for (let i = 0; i < 40; i++) {
      createdIds.push(engine.create({ requestId: `req-${i}`, goal: `Goal ${i}`, cwd: 'ignored' }).taskId)
    }
    assert.deepEqual([...createdIds].sort(), createdIds)
    assert.equal(engine.nextReady()?.id, createdIds[0])

    // Concurrent new task creation during cursor pagination never causes older tasks to be skipped.
    const page1 = engine.listPage(null, 15)
    assert.equal(page1.length, 15)
    engine.create({ requestId: 'req-late', goal: 'Late task', cwd: 'ignored' })
    const page2 = engine.listPage(page1.at(-1)!.id, 30)
    assert.deepEqual([...page1, ...page2].map(item => item.id), [...createdIds].reverse())

    const judgment = new LocalJudgment(store, { modes: { 'tool.admission': 'shadow' } })
    await judgment.decide(
      { taskId: createdIds[0]!, type: 'unused', payload: {} },
      'tool.admission',
      { evidenceCount: 2, failedCount: 1, writeCount: 3, checkConfigured: true, checkPassed: false, toolCount: 4, length: 900, initial: true, tool: 'web_fetch' },
      true,
      [true, false],
    )
    const projected = telemetryEvent(store.events(createdIds[0]!).at(-1)!)
    const features = projected.payload.features as Record<string, unknown>
    assert.equal(features.failedCount, 1)
    assert.equal(features.writeCount, 3)
    assert.equal(features.toolCount, 4)
    assert.equal(features.length, 900)
    assert.equal(features.checkConfigured, true)
    assert.equal(features.initial, true)
    assert.equal(features.tool, 'web_fetch')
  } finally {
    store.close()
  }

  const root = mkdtempSync(join(tmpdir(), 'zlo-model-clear-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const host = new LocalAgentHost({ directory: join(root, 'state'), defaultWorkspace: join(root, 'ws'), execution: new FakeExecution() })
  try {
    const conv = await host.createConversation({ requestId: 'c1', route: { provider: 'fake', model: 'alternate' } })
    assert.deepEqual(conv.route, { provider: 'fake', model: 'alternate' })
    const cleared = await host.setConversationModel({ requestId: 'm-clear', conversationId: conv.id, route: null })
    assert.equal(cleared.route, undefined)
  } finally {
    await host.close()
  }
})
