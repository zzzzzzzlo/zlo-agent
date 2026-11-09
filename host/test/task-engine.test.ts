import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LocalStore } from '../src/store.ts'
import { TaskEngine } from '../src/task-engine.ts'

const check = { path: 'demo.txt', contains: 'verified by zlo agent' }

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
