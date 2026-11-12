import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { EventDraft, VerificationResult } from '../src/contracts/domain.ts'
import { LocalStore } from '../src/store.ts'
import { TaskEngine } from '../src/task-engine.ts'
import type { WorkerNode, WorkerResult } from '../src/task-engine.ts'

const result: WorkerResult = {
  resultStatus: 'succeeded', summary: 'Completed scope', artifactRefs: [], evidenceRefs: [], remainingRisks: [],
}

function nodeEvent(taskId: string, taskNodeId: string, taskAttemptId?: string): EventDraft {
  return { taskId, taskNodeId, taskAttemptId, type: '', payload: {} }
}

function settleRead(engine: TaskEngine, taskId: string, node: WorkerNode, attemptId: string,
  verification?: VerificationResult): WorkerNode | undefined {
  const event = nodeEvent(taskId, node.id, attemptId)
  const id = attemptId + ':read'
  engine.beginTool(taskId, event, id, 'read_text_file', 'read')
  engine.finishTool(event, id, 'succeeded')
  return engine.settleWorker(taskId, node.id, { ...result, evidenceRefs: [id] }, verification)
}

test('a versioned plan resolves forward dependencies atomically and dispatches independent reads first', (t) => {
  const store = new LocalStore(':memory:')
  t.after(() => store.close())
  const engine = new TaskEngine(store)
  const { taskId } = engine.create({ requestId: 'root', goal: 'Plan work', cwd: 'ignored' })
  const invalid = [
    { ref: 'a', goal: 'First', dependencies: ['b'] },
    { ref: 'b', goal: 'Second', dependencies: ['a'] },
  ]
  assert.throws(() => engine.proposePlan(taskId, 'cycle', 0, invalid), /cyclic/i)
  assert.equal(engine.get(taskId).planVersion, 0)
  assert.equal(store.events(taskId).filter(({ type }) => type === 'task.plan_changed').length, 0)

  const plan = [
    { ref: 'join', goal: 'Combine the handoffs', dependencies: ['first', 'second'] },
    { ref: 'first', goal: 'Read the first input' },
    { ref: 'second', goal: 'Read the second input' },
  ]
  const [joined, first, second] = engine.proposePlan(taskId, 'plan', 0, plan)
  assert.deepEqual(engine.proposePlan(taskId, 'plan', 0, plan), [joined, first, second])
  assert.throws(() => engine.proposePlan(taskId, 'stale', 0, plan), /version changed/)
  assert.deepEqual(joined.dependencies, [first.id, second.id])
  assert.deepEqual(engine.runnableNodes(taskId), [])
  engine.start(taskId)
  assert.deepEqual(engine.runnableNodes(taskId).map(({ id }) => id), [first.id, second.id])
  assert.throws(() => engine.startWorker(taskId, joined.id), /not runnable/)
  const attempt1 = engine.startWorker(taskId, first.id)
  const attempt2 = engine.startWorker(taskId, second.id)
  assert.deepEqual(engine.runnableNodes(taskId), [])
  assert.equal(settleRead(engine, taskId, first, attempt1)?.status, 'succeeded')
  assert.deepEqual(engine.runnableNodes(taskId), [])
  assert.equal(settleRead(engine, taskId, second, attempt2)?.status, 'succeeded')
  assert.deepEqual(engine.runnableNodes(taskId).map(({ id }) => id), [joined.id])
  assert.equal(settleRead(engine, taskId, joined, engine.startWorker(taskId, joined.id))?.status, 'succeeded')
  engine.beginVerification(taskId)
  assert.equal(engine.verify(taskId, { passed: true, evidence: 'verified' }).status, 'succeeded')
  const events = store.events(taskId)
  assert.equal(events.filter(({ type }) => type === 'task.plan_changed').length, 1)
  assert.deepEqual(events.filter(({ type }) => type === 'task.node_started').map(({ taskNodeId }) => taskNodeId),
    [first.id, second.id, joined.id])
  assert.equal(events.find(({ type }) => type === 'task.node_settled')?.taskAttemptId, attempt1)
})

test('node verification gates dependencies and permits one versioned replan', (t) => {
  const store = new LocalStore(':memory:')
  t.after(() => store.close())
  const engine = new TaskEngine(store)
  const { taskId } = engine.create({ requestId: 'root', goal: 'Verify artifacts', cwd: 'ignored' })
  const [first, second] = engine.proposePlan(taskId, 'plan', 0, [
    { ref: 'artifact', goal: 'Inspect artifact', check: { path: 'demo.txt', contains: 'verified' } },
    { ref: 'use', goal: 'Use artifact', dependencies: ['artifact'] },
  ])
  engine.start(taskId)
  const failedAttempt = engine.startWorker(taskId, first.id)
  const failed = settleRead(engine, taskId, first, failedAttempt, { passed: false, evidence: 'workspace_file_missing_expected_text' })
  assert.equal(failed?.status, 'failed')
  assert.equal(failed?.verification?.evidence, 'workspace_file_missing_expected_text')
  assert.throws(() => engine.startWorker(taskId, second.id), /not runnable/)
  assert.deepEqual(engine.runnableNodes(taskId), [])
  engine.beginVerification(taskId)
  assert.throws(() => engine.verify(taskId, { passed: true, evidence: 'verified' }), /acceptance/)
  engine.continueExecution(taskId)

  const replan = engine.replanNode(taskId, 'retry', 1, first.id, {})
  assert.deepEqual(engine.replanNode(taskId, 'retry', 1, first.id, {}), replan)
  assert.throws(() => engine.replanNode(taskId, 'retry-2', 2, first.id, {}), /budget exhausted/)
  const retryAttempt = engine.startWorker(taskId, first.id)
  assert.notEqual(retryAttempt, failedAttempt)
  assert.equal(settleRead(engine, taskId, first, retryAttempt, { passed: true, evidence: 'workspace_file_exists' })?.status, 'succeeded')
  engine.startWorker(taskId, second.id)
  assert.equal(engine.settleWorker(taskId, second.id, result)?.verification?.evidence, 'node_missing_evidence')
  engine.beginVerification(taskId)
  assert.equal(engine.verify(taskId, { passed: false, evidence: 'worker_verification_failed' }).status, 'failed')
  assert.equal(engine.attempts(taskId).find(({ id }) => id === failedAttempt)?.status, 'failed')
})

test('Team scopes inherit and same-workspace writers serialize while a Team yields to its child', (t) => {
  const store = new LocalStore(':memory:')
  t.after(() => store.close())
  const engine = new TaskEngine(store)
  const { taskId } = engine.create({ requestId: 'root', goal: 'Team work', cwd: 'ignored', workspaceAccess: 'trusted' })
  const [team, child, sibling] = engine.proposePlan(taskId, 'plan', 0, [
    { ref: 'team', goal: 'Fix feature', role: 'team', teamKey: 'feature', access: 'write', scopePath: 'src' },
    { ref: 'child', goal: 'Inspect feature', parentNodeId: 'team' },
    { ref: 'sibling', goal: 'Update documentation', access: 'write', scopePath: 'docs' },
  ])
  assert.equal(child.scopePath, 'src')
  assert.throws(() => engine.proposePlan(taskId, 'scope', 1,
    [{ ref: 'expand', goal: 'Read outside scope', parentNodeId: team.id, scopePath: 'src-other' }]), /expand parent scope/)
  assert.throws(() => engine.proposePlan(taskId, 'check-scope', 1,
    [{ ref: 'outside', goal: 'Check outside scope', parentNodeId: team.id, check: { path: 'docs/demo.md' } }]), /outside the node scope/)
  assert.throws(() => engine.proposePlan(taskId, 'unsafe-child', 1,
    [{ ref: 'trusted', goal: 'Run outside the Team grant', parentNodeId: team.id, access: 'trusted' }]), /expand parent access/)
  assert.throws(() => engine.proposePlan(taskId, 'wrong-dependency', 1,
    [{ ref: 'cross', goal: 'Read', dependencies: [child.id] }]), /parent scope/)
  assert.throws(() => engine.replanNode(taskId, 'expanded-replan', 1, child.id,
    { scopePath: 'docs' } as never), /Invalid node replan/)

  engine.start(taskId)
  assert.deepEqual(engine.runnableNodes(taskId).map(({ id }) => id), [team.id])
  assert.deepEqual(engine.runnableNodes(taskId, team.id), [])
  const teamAttempt = engine.startWorker(taskId, team.id)
  assert.throws(() => engine.startWorker(taskId, sibling.id), /not runnable/)
  assert.deepEqual(engine.runnableNodes(taskId, team.id).map(({ id }) => id), [child.id])
  assert.throws(() => engine.startWorker(taskId, child.id), /not runnable/)
  const teamEvent = nodeEvent(taskId, team.id, teamAttempt)
  engine.beginTool(taskId, teamEvent, 'delegate', 'delegate_task', 'read')
  const childAttempt = engine.startWorker(taskId, child.id, { suspendParent: true })
  assert.throws(() => engine.beginTool(taskId, teamEvent, 'blocked-write', 'edit_text_file', 'write'), /not accepting/)
  assert.throws(() => engine.beginTool(taskId, nodeEvent(taskId, child.id, childAttempt),
    'child-write', 'create_text_file', 'write'), /denies writes/)
  assert.equal(settleRead(engine, taskId, child, childAttempt)?.status, 'succeeded')
  engine.finishTool(teamEvent, 'delegate', 'succeeded')
  const completed = engine.settleWorker(taskId, team.id, result)
  assert.equal(completed?.verification?.evidence, 'node_completed_children')
  assert.equal(completed?.verification?.verdict, 'unverified')
  assert.deepEqual(engine.runnableNodes(taskId).map(({ id }) => id), [sibling.id])
})

test('Team activations reserve a slot for each Team to make progress with a child', (t) => {
  const store = new LocalStore(':memory:')
  t.after(() => store.close())
  const engine = new TaskEngine(store)
  const { taskId } = engine.create({ requestId: 'root', goal: 'Coordinate two Teams', cwd: 'ignored' })
  const [teamA, teamB, childA, childB, otherA, spare] = engine.proposePlan(taskId, 'plan', 0, [
    { ref: 'a', goal: 'A', role: 'team', teamKey: 'a' },
    { ref: 'b', goal: 'B', role: 'team', teamKey: 'b' },
    { ref: 'ca', goal: 'Read A', parentNodeId: 'a' },
    { ref: 'cb', goal: 'Read B', parentNodeId: 'b' },
    { ref: 'extraA', goal: 'Also read A', parentNodeId: 'a' },
    { ref: 'spare', goal: 'Read C' },
  ])
  engine.start(taskId)
  assert.deepEqual(engine.runnableNodes(taskId).map(({ id }) => id), [teamA.id, teamB.id])
  engine.startWorker(taskId, teamA.id)
  engine.startWorker(taskId, teamB.id)
  assert.throws(() => engine.startWorker(taskId, spare.id), /not runnable/)
  assert.deepEqual(engine.runnableNodes(taskId, teamA.id).map(({ id }) => id), [childA.id])
  engine.startWorker(taskId, childA.id)
  assert.throws(() => engine.startWorker(taskId, otherA.id), /not runnable/)
  assert.deepEqual(engine.runnableNodes(taskId, teamB.id).map(({ id }) => id), [childB.id])
  engine.startWorker(taskId, childB.id)
})

test('a recovered stop preserves the graph and only redispatches interrupted reads after resume', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zlo-dag-recovery-'))
  const path = join(dir, 'tasks.sqlite')
  let store = new LocalStore(path)
  try {
    let engine = new TaskEngine(store)
    const { taskId } = engine.create({ requestId: 'root', goal: 'Recover reads', cwd: 'ignored' })
    const [a, b] = engine.proposePlan(taskId, 'plan', 0, [
      { ref: 'a', goal: 'Read A' },
      { ref: 'b', goal: 'Read B' },
      { ref: 'later', goal: 'Use evidence', dependencies: ['a', 'b'] },
    ])
    engine.start(taskId)
    const aAttempt = engine.startWorker(taskId, a.id)
    const bAttempt = engine.startWorker(taskId, b.id)
    engine.beginTool(taskId, nodeEvent(taskId, a.id, aAttempt), 'read-a', 'read_text_file', 'read')
    assert.equal(engine.requestStop(taskId, 'stop').status, 'stop_requested')
    assert.deepEqual(engine.runnableNodes(taskId), [])
    assert.throws(() => engine.beginTool(taskId, nodeEvent(taskId, b.id, bAttempt), 'read-b', 'read_text_file', 'read'), /not accepting/)
    store.close()

    store = new LocalStore(path)
    engine = new TaskEngine(store)
    const stopped = engine.end(taskId, 'process_interrupted')
    assert.equal(stopped.status, 'stopped')
    assert.equal(stopped.reason, 'user_stop')
    assert.deepEqual(stopped.nodes?.map(({ status }) => status), ['ready', 'ready', 'ready'])
    assert.equal(engine.operations(taskId).at(0)?.status, 'interrupted')
    assert.equal(engine.attempts(taskId).filter(({ status }) => status === 'interrupted').length, 3)
    assert.deepEqual(engine.runnableNodes(taskId), [])
    assert.equal(engine.resume(taskId, 'resume').accepted, true)
    engine.start(taskId)
    assert.deepEqual(engine.runnableNodes(taskId).map(({ id }) => id), [a.id, b.id])
    assert.notEqual(engine.startWorker(taskId, a.id), aAttempt)
    assert.equal(engine.settleWorker(taskId, a.id, result, undefined, aAttempt), undefined)
    assert.equal(engine.get(taskId).nodes?.find(({ id }) => id === a.id)?.status, 'running')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unconfirmed node write blocks further work and survives a crash as unknown effect', (t) => {
  const store = new LocalStore(':memory:')
  t.after(() => store.close())
  const engine = new TaskEngine(store)
  const { taskId } = engine.create({ requestId: 'root', goal: 'Crash during write', cwd: 'ignored', workspaceAccess: 'write' })
  const [writer, reader] = engine.proposePlan(taskId, 'plan', 0,
    [{ ref: 'writer', goal: 'Edit', access: 'write' }, { ref: 'reader', goal: 'Read' }])
  engine.start(taskId)
  const attemptId = engine.startWorker(taskId, writer.id)
  engine.beginTool(taskId, nodeEvent(taskId, writer.id, attemptId), 'write', 'edit_text_file', 'write', 'demo.txt')
  assert.deepEqual(engine.runnableNodes(taskId), [])
  const interrupted = engine.end(taskId, 'process_interrupted')
  assert.equal(interrupted.status, 'needs_reconciliation')
  assert.equal(interrupted.nodes?.find(({ id }) => id === writer.id)?.verification?.evidence, 'node_unknown_effect')
  assert.equal(engine.attempts(taskId).find(({ id }) => id === attemptId)?.status, 'unknown_effect')
  assert.equal(engine.operations(taskId).at(0)?.status, 'unknown_effect')
  assert.equal(engine.resume(taskId, 'resume').accepted, false)
  assert.throws(() => engine.startWorker(taskId, reader.id), /not runnable/)
  assert.throws(() => engine.replanNode(taskId, 'retry', 1, writer.id, {}), /not accepting/)
})

test('node and activation budgets survive replanning and repeated interruptions', (t) => {
  const store = new LocalStore(':memory:')
  t.after(() => store.close())
  const engine = new TaskEngine(store)
  const { taskId } = engine.create({ requestId: 'root', goal: 'Bound repeated runs', cwd: 'ignored' })
  const plan = Array.from({ length: 16 }, (_, index) => ({ ref: 'node' + index, goal: 'Read input ' + index }))
  const [first] = engine.proposePlan(taskId, 'plan', 0, plan)
  assert.throws(() => engine.addTask(taskId, 'excess-legacy', 'Too many nodes', 1), /node budget/)
  assert.throws(() => engine.proposePlan(taskId, 'excess', 1, [{ ref: 'extra', goal: 'Too many nodes' }]), /node budget/)
  for (let index = 0; index < 32; index++) {
    engine.start(taskId)
    engine.startWorker(taskId, first.id)
    assert.equal(engine.end(taskId, 'process_interrupted').status, 'stopped')
    assert.equal(engine.resume(taskId, 'resume-' + index).accepted, true)
  }
  engine.start(taskId)
  assert.deepEqual(engine.runnableNodes(taskId), [])
  assert.throws(() => engine.startWorker(taskId, first.id), /not runnable/)
})

test('a prior write receipt prohibits replanning even when the tool reported failure', (t) => {
  const store = new LocalStore(':memory:')
  t.after(() => store.close())
  const engine = new TaskEngine(store)
  const { taskId } = engine.create({ requestId: 'root', goal: 'Edit safely', cwd: 'ignored', workspaceAccess: 'trusted' })
  const [a, b] = engine.proposePlan(taskId, 'plan', 0, [
    { ref: 'a', goal: 'Run a project command', access: 'write' },
    { ref: 'b', goal: 'Modify a file', access: 'write' },
  ])
  engine.start(taskId)
  for (const [node, status] of [[a, 'failed'], [b, 'succeeded']] as const) {
    const attempt = engine.startWorker(taskId, node.id)
    const event = nodeEvent(taskId, node.id, attempt)
    engine.beginTool(taskId, event, attempt, 'write_tool', 'write')
    engine.finishTool(event, attempt, status)
    engine.settleWorker(taskId, node.id, { ...result, resultStatus: 'failed' })
    assert.throws(() => engine.replanNode(taskId, 'retry-' + node.id, 1, node.id, {}), /previous write attempt/)
  }
  assert.equal(engine.get(taskId).planVersion, 1)
})

test('stopped and recovered nodes never redispatch after a recorded write', (t) => {
  const store = new LocalStore(':memory:')
  t.after(() => store.close())
  const engine = new TaskEngine(store)
  for (const crash of [false, true]) {
    const { taskId } = engine.create({ requestId: 'root-' + crash, goal: 'Edit safely', cwd: 'ignored', workspaceAccess: 'write' })
    const [writer] = engine.proposePlan(taskId, 'plan-' + crash, 0, [{ ref: 'a', goal: 'Modify a file', access: 'write' }])
    engine.start(taskId)
    const attempt = engine.startWorker(taskId, writer.id)
    const event = nodeEvent(taskId, writer.id, attempt)
    engine.beginTool(taskId, event, attempt, 'edit_text_file', 'write')
    engine.finishTool(event, attempt, crash ? 'failed' : 'succeeded')
    if (!crash) {
      engine.requestStop(taskId, 'stop')
      assert.equal(engine.settleWorker(taskId, writer.id, undefined, undefined, attempt)?.status, 'failed')
    }
    const stopped = engine.end(taskId, crash ? 'process_interrupted' : 'user_stop')
    assert.equal(stopped.status, 'stopped')
    const failed = stopped.nodes?.[0]
    assert.equal(failed?.status, 'failed')
    assert.equal(failed?.verification?.evidence, 'node_interrupted_after_write')
    assert.deepEqual(failed?.result?.evidenceRefs, [attempt])
    assert.equal(engine.attempts(taskId).find(({ id }) => id === attempt)?.status, 'interrupted')
    assert.equal(engine.resume(taskId, 'resume-' + crash).accepted, true)
    engine.start(taskId)
    assert.deepEqual(engine.runnableNodes(taskId), [])
    assert.throws(() => engine.startWorker(taskId, writer.id), /not runnable/)
  }
})

test('trusted command verification is journaled during root verification and must settle before acceptance', (t) => {
  const store = new LocalStore(':memory:')
  t.after(() => store.close())
  const engine = new TaskEngine(store)
  const check = { command: { command: 'npm_test' as const, path: '.' } }
  assert.throws(() => engine.create({ requestId: 'deny', goal: 'Run tests', cwd: 'ignored', check }), /requires trusted/)
  const { taskId } = engine.create({ requestId: 'grant', goal: 'Run tests', cwd: 'ignored', workspaceAccess: 'trusted', check })
  const task = engine.start(taskId)
  const event = nodeEvent(taskId, task.rootNodeId, task.attemptId)
  assert.throws(() => engine.beginTool(taskId, event, 'early', 'verify_command', 'write', '.', 'verification'), /not accepting/)
  engine.beginVerification(taskId)
  engine.beginTool(taskId, event, 'check', 'verify_command', 'write', '.', 'verification')
  assert.throws(() => engine.verify(taskId, { passed: true, evidence: 'exit_zero' }), /Tool receipts/)
  engine.finishTool(event, 'check', 'succeeded')
  assert.equal(engine.verify(taskId, { passed: true, evidence: 'exit_zero' }).status, 'succeeded')
})
