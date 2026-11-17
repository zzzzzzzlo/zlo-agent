import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { ExecutionConfig, ExecutionResult } from '../src/execution.ts'
import { FakeExecution } from '../src/fake.ts'
import { LocalAgentHost } from '../src/host.ts'
import { LocalStore } from '../src/store.ts'
import { TaskEngine } from '../src/task-engine.ts'
import { CodingWorkspace } from '../src/workspace.ts'

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'zlo-concurrency-'))
  const cwd = join(base, 'workspace')
  const directory = join(base, 'state')
  await mkdir(join(cwd, 'src'), { recursive: true })
  t.after(() => rm(base, { recursive: true, force: true }))
  return { base, cwd, directory }
}

type Call = (name: string, input: unknown) => Promise<{ ok: boolean; error?: string; [k: string]: unknown }>
type Script = (config: ExecutionConfig, call: Call, prompt: string, signal?: AbortSignal) => Promise<string>

class ConcurrencyExecution extends FakeExecution {
  readonly errors: unknown[] = []
  readonly #script: Script

  constructor(script: Script) {
    super()
    this.#script = script
  }

  override async open(config: ExecutionConfig) {
    const session = await super.open(config)
    const controller = new AbortController()
    return {
      ...session,
      requestStop: async () => {
        controller.abort()
        await session.requestStop()
      },
      run: async (prompt: string): Promise<ExecutionResult> => {
        try {
          config.reserveRequest?.({ route: session.route, estimatedInputTokens: 20, maxOutputTokens: 80, kind: 'prompt' })
          config.onEvent({ type: 'model.request_started' })
          config.onEvent({ type: 'model.usage', input: 15, output: 5, cacheRead: 0, cacheWrite: 0 })
          const call: Call = async (name, input) => {
            const tool = config.tools.find(item => item.name === name)
            assert.ok(tool, `${config.role} is missing tool ${name}`)
            return await tool.execute(randomUUID(), input, controller.signal) as { ok: boolean; error?: string; [k: string]: unknown }
          }
          const text = await this.#script(config, call, prompt, controller.signal)
          return controller.signal.aborted ? { status: 'interrupted' } : { status: 'completed', text }
        } catch (error) {
          this.errors.push(error)
          return controller.signal.aborted ? { status: 'interrupted' } : { status: 'runtime_error' }
        }
      },
    }
  }
}

test('multiple Read Workers run in parallel (including under a Team) while Writers stay mutually exclusive', { timeout: 15_000 }, async (t) => {
  const { cwd, directory } = await fixture(t)
  await writeFile(join(cwd, 'src', 'a.txt'), 'alpha')
  await writeFile(join(cwd, 'src', 'b.txt'), 'beta')
  await writeFile(join(cwd, 'src', 'c.txt'), 'gamma')

  const teamReadersEntered = Promise.withResolvers<void>()
  let activeTeamReaders = 0
  let maxConcurrentReads = 0
  let activeWriters = 0
  let maxConcurrentWrites = 0
  let overlapDetected = false

  const execution = new ConcurrencyExecution(async (config, call, prompt) => {
    if (config.role === 'root') {
      const res = await call('propose_task_plan', {
        nodes: [
          { ref: 'team', role: 'team', teamKey: 'readers', goal: 'Coordinate parallel reads', access: 'write', scopePath: 'src' },
          { ref: 'r1', parentNodeId: 'team', goal: 'Read file A', scopePath: 'src', tools: ['read_text_file'] },
          { ref: 'r2', parentNodeId: 'team', goal: 'Read file B', scopePath: 'src', tools: ['read_text_file'] },
          { ref: 'w1', goal: 'Write summary W1', access: 'write', scopePath: 'src', dependencies: ['team'] },
          { ref: 'w2', goal: 'Write follow-up W2', access: 'write', scopePath: 'src', dependencies: ['team'] },
        ],
      })
      assert.equal(res.ok, true, res.error)
      return 'Parallel Team readers and serial writers completed'
    }
    if (config.role === 'team') {
      const r = await call('create_text_file', { path: 'src/team.txt', content: 'team ok' })
      assert.equal(r.ok, true, r.error)
      return 'Team finished after parallel read children'
    }
    if (prompt.includes('Read file A') || prompt.includes('Read file B')) {
      activeTeamReaders++
      maxConcurrentReads = Math.max(maxConcurrentReads, activeTeamReaders)
      if (activeWriters > 0) overlapDetected = true
      if (activeTeamReaders === 2) teamReadersEntered.resolve()
      await teamReadersEntered.promise
      const target = prompt.includes('Read file A') ? 'src/a.txt' : 'src/b.txt'
      const read = await call('read_text_file', { path: target })
      assert.equal(read.ok, true)
      activeTeamReaders--
      return `Read ${target}`
    }
    activeWriters++
    maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWriters)
    if (activeTeamReaders > 0) overlapDetected = true
    await delay(20)
    const target = prompt.includes('W1') ? 'src/w1.txt' : 'src/w2.txt'
    const res = await call('create_text_file', { path: target, content: target })
    assert.equal(res.ok, true, res.error)
    activeWriters--
    return `Wrote ${target}`
  })

  const host = new LocalAgentHost({ directory, execution })
  try {
    const { taskId } = await host.createTask({ requestId: 'rw-parallel', goal: 'Parallel team read then serial writes', cwd, workspaceAccess: 'write' })
    await host.idle()
    assert.deepEqual(execution.errors, [])
    assert.equal(host.getTask(taskId).status, 'succeeded')
    assert.equal(maxConcurrentReads, 2)
    assert.equal(maxConcurrentWrites, 1)
    assert.equal(overlapDetected, false)
    assert.equal(new CodingWorkspace(cwd).leaseState().waitingCount, 0)
    assert.deepEqual(new CodingWorkspace(cwd).leaseState().readers, [])
    assert.equal(new CodingWorkspace(cwd).leaseState().writer, undefined)
  } finally {
    await host.close()
  }
})

test('fair Writer-preference queue prevents continuous Read Workers from starving a waiting Writer', { timeout: 10_000 }, async (t) => {
  const { cwd } = await fixture(t)
  const workspace = new CodingWorkspace(cwd)

  // 1. Direct WorkspaceLeaseManager FIFO Writer-Preference verification
  const events: string[] = []
  const r1 = await workspace.acquireLease('read', { ownerId: 'r1' })
  events.push('r1:acquired')

  const w1Promise = workspace.acquireLease('write', { ownerId: 'w1' }).then(lease => {
    events.push('w1:acquired')
    return lease
  })
  const r2Promise = workspace.acquireLease('read', { ownerId: 'r2' }).then(lease => {
    events.push('r2:acquired')
    return lease
  })
  const r3Promise = workspace.acquireLease('read', { ownerId: 'r3' }).then(lease => {
    events.push('r3:acquired')
    return lease
  })

  await delay(10)
  // While w1 is queued, r2 and r3 MUST NOT jump ahead!
  assert.deepEqual(events, ['r1:acquired'])

  // Active reader re-entering with same ownerId must still work without deadlocking
  const r1Reentrant = await workspace.acquireLease('read', { ownerId: 'r1' })
  r1Reentrant.release()

  r1.release()
  const w1 = await w1Promise
  await delay(10)
  // w1 MUST acquire exclusively before r2 and r3
  assert.deepEqual(events, ['r1:acquired', 'w1:acquired'])

  w1.release()
  const [r2, r3] = await Promise.all([r2Promise, r3Promise])
  // Once w1 finishes, BOTH queued reads r2 and r3 acquire concurrently together!
  assert.equal(events.length, 4)
  assert.equal(events[0], 'r1:acquired')
  assert.equal(events[1], 'w1:acquired')
  assert.ok(workspace.leaseState().readers.includes('r2') && workspace.leaseState().readers.includes('r3'))
  r2.release()
  r3.release()
  assert.deepEqual(workspace.leaseState(), { readers: [], waitingCount: 0 })

  // 2. TaskEngine scheduling-level Writer starvation prevention
  const store = new LocalStore(':memory:')
  t.after(() => store.close())
  const engine = new TaskEngine(store, { maxConcurrentNodes: 4 })
  const { taskId } = engine.create({ requestId: 'fair-sched', goal: 'Prevent writer starvation', cwd, workspaceAccess: 'write' })
  const [nR1, nW1, nR2, nR3] = engine.proposePlan(taskId, 'plan', 0, [
    { ref: 'r1', goal: 'First read', access: 'read' },
    { ref: 'w1', goal: 'Queued write', access: 'write' },
    { ref: 'r2', goal: 'Second read', access: 'read' },
    { ref: 'r3', goal: 'Third read', access: 'read' },
  ])
  engine.start(taskId)
  // Initial batch returns ONLY nR1 because nW1 is second and conflicts with running nR1; nR2/nR3 MUST NOT overtake nW1!
  assert.deepEqual(engine.runnableNodes(taskId).map(n => n.id), [nR1.id])
  const r1Attempt = engine.startWorker(taskId, nR1.id)
  assert.deepEqual(engine.runnableNodes(taskId), [])
  engine.settleWorker(taskId, nR1.id, { resultStatus: 'succeeded', summary: 'R1 done', artifactRefs: [], evidenceRefs: [] , remainingRisks: [] },
    { passed: true, evidence: 'ok' }, r1Attempt)

  // Now nW1 runs exclusively before nR2/nR3!
  assert.deepEqual(engine.runnableNodes(taskId).map(n => n.id), [nW1.id])
  const w1Attempt = engine.startWorker(taskId, nW1.id)
  engine.settleWorker(taskId, nW1.id, { resultStatus: 'succeeded', summary: 'W1 done', artifactRefs: [], evidenceRefs: [], remainingRisks: [] },
    { passed: true, evidence: 'ok' }, w1Attempt)

  // Now nR2 and nR3 dispatch together in parallel!
  assert.deepEqual(engine.runnableNodes(taskId).map(n => n.id), [nR2.id, nR3.id])
})

test('Team suspendParent handoff via delegate_worker avoids deadlock and safely restores Team write lease', { timeout: 15_000 }, async (t) => {
  const { cwd, directory } = await fixture(t)
  const check = { path: 'src/team-final.txt', contains: 'team verified' }
  const execution = new ConcurrencyExecution(async (config, call) => {
    if (config.role === 'root') {
      const planned = await call('propose_task_plan', {
        nodes: [{ ref: 't1', role: 'team', teamKey: 'handoff', goal: 'Delegate then finalize file', access: 'write', scopePath: 'src', check }],
      })
      assert.equal(planned.ok, true, planned.error)
      return 'Root completed'
    }
    if (config.role === 'team') {
      const childRes = await call('delegate_worker', {
        goal: 'Write child part', access: 'write', scopePath: 'src', tools: ['create_text_file', 'read_text_file'],
      })
      assert.equal(childRes.ok, true, childRes.error)
      // Team must cleanly resume its own exclusive write lease and write check target!
      const finalWrite = await call('create_text_file', { path: 'src/team-final.txt', content: 'team verified' })
      assert.equal(finalWrite.ok, true, finalWrite.error)
      return 'Team wrote final file after child handoff'
    }
    const created = await call('create_text_file', { path: 'src/child-part.txt', content: 'from child' })
    assert.equal(created.ok, true, created.error)
    return 'Child finished'
  })

  const host = new LocalAgentHost({ directory, execution })
  try {
    const { taskId } = await host.createTask({ requestId: 'team-handoff', goal: 'Team delegate_worker handoff', cwd, workspaceAccess: 'write', check })
    await host.idle()
    assert.deepEqual(execution.errors, [])
    assert.equal(host.getTask(taskId).status, 'succeeded')
    assert.equal(await readFile(join(cwd, 'src', 'child-part.txt'), 'utf8'), 'from child')
    assert.equal(await readFile(join(cwd, 'src', 'team-final.txt'), 'utf8'), 'team verified')
    assert.deepEqual(new CodingWorkspace(cwd).leaseState(), { readers: [], waitingCount: 0 })
  } finally {
    await host.close()
  }
})

test('user stop, worker timeout/failure, and shell_exec background deferral/unknown_effect uphold lease safety across recovery', { timeout: 20_000 }, async (t) => {
  const { cwd, directory } = await fixture(t)

  // Part A: User stop releases leases cleanly & recovery allows fresh task without stuck locks
  const stopReached = Promise.withResolvers<void>()
  const releaseStoppedWorker = Promise.withResolvers<void>()
  let mode: 'stop_mid_write' | 'shell_crash' | 'normal_follow' = 'stop_mid_write'

  const execution = new ConcurrencyExecution(async (config, call, _prompt, stopSignal) => {
    if (config.role === 'root') {
      if (mode === 'stop_mid_write') {
        await call('propose_task_plan', { nodes: [{ ref: 'w', goal: 'Hold write and stop', access: 'write', scopePath: 'src' }] })
        return 'Stopped'
      }
      if (mode === 'shell_crash') {
        const execRes = await call('shell_exec', {
          shell: process.platform === 'win32' ? 'powershell' : 'sh',
          command: process.platform === 'win32' ? 'Start-Sleep -Milliseconds 1500' : 'sleep 1.5',
        })
        assert.equal(execRes.ok, true, execRes.error)
        return 'Responding while background shell is still active'
      }
      const created = await call('create_text_file', { path: 'src/after-recovery.txt', content: 'recovered ok' })
      assert.equal(created.ok, true, created.error)
      return 'Follow-up succeeded'
    }
    if (config.role === 'worker') {
      const ok = await call('create_text_file', { path: 'src/in-flight.txt', content: 'partial' })
      assert.equal(ok.ok, true)
      stopReached.resolve()
      await Promise.race([
        releaseStoppedWorker.promise,
        new Promise<void>(resolve => stopSignal?.addEventListener('abort', () => resolve(), { once: true })),
      ])
      return 'Aborted'
    }
    return 'Ok'
  })

  let host = new LocalAgentHost({ directory, execution, approveTool: async () => ({ approved: true }) })
  try {
    const conv = host.createConversation({ requestId: 'stop-conv', workspace: cwd, workspaceAccess: 'trusted' })
    const sent = await host.sendMessage({ requestId: 'msg-stop', conversationId: conv.id, text: 'Stop test' })
    await stopReached.promise
    host.stopConversation({ requestId: 'cmd-stop', conversationId: conv.id, taskId: sent.taskId })
    releaseStoppedWorker.resolve()
    await host.idle()
    assert.equal(host.getTask(sent.taskId).status, 'stopped')
    assert.deepEqual(new CodingWorkspace(cwd).leaseState(), { readers: [], waitingCount: 0 })

    // Part B: shell_exec background deferral holds exclusive lease while active and settles cleanly before completion
    mode = 'shell_crash'
    const conv2 = host.createConversation({ requestId: 'shell-conv', workspace: cwd, workspaceAccess: 'trusted' })
    const shellTask = await host.sendMessage({ requestId: 'msg-shell', conversationId: conv2.id, text: 'Run shell deferral' })
    await host.idle()
    assert.equal(host.getTask(shellTask.taskId).status, 'succeeded')
    assert.deepEqual(new CodingWorkspace(cwd).leaseState(), { readers: [], waitingCount: 0 })
  } finally {
    await host.close()
  }

  // Part C: Simulate process crash leaving an open write op -> restart Host -> no ghost memory lock, unknown_effect enforced in SQLite!
  const store = new LocalStore(join(directory, 'tasks.sqlite'))
  let crashTaskId = ''
  try {
    const engine = new TaskEngine(store)
    const created = engine.create({ requestId: 'crashed-task', goal: 'Crash mid-write', cwd, workspaceAccess: 'write' })
    crashTaskId = created.taskId
    const [n1] = engine.proposePlan(crashTaskId, 'crash-plan', 0, [{ ref: 'w', goal: 'Write file', access: 'write' }])
    const meta = engine.start(crashTaskId)
    const att = engine.startWorker(crashTaskId, n1.id)
    engine.beginTool(crashTaskId, { taskId: crashTaskId, taskRunId: meta.taskRunId, taskAttemptId: att, taskNodeId: n1.id, agentRunId: 'run-crashed', type: '', payload: {} },
      'op-crashed', 'create_text_file', 'write', 'src/crashed.txt')
  } finally {
    store.close()
  }

  mode = 'normal_follow'
  host = new LocalAgentHost({ directory, execution })
  try {
    // Recovery marks unknown_effect write as needs_reconciliation AND leaves zero in-memory stale leases!
    const recoveredTask = host.getTask(crashTaskId)
    assert.equal(recoveredTask.status, 'needs_reconciliation')
    assert.deepEqual(new CodingWorkspace(cwd).leaseState(), { readers: [], waitingCount: 0 })

    // A fresh independent task on the same workspace is not deadlocked by stale memory locks
    const conv3 = host.createConversation({ requestId: 'clean-conv', workspace: cwd, workspaceAccess: 'write' })
    const follow = await host.sendMessage({ requestId: 'msg-follow', conversationId: conv3.id, text: 'Continue after recovery' })
    await host.idle()
    assert.equal(host.getTask(follow.taskId).status, 'succeeded')
    assert.equal(await readFile(join(cwd, 'src', 'after-recovery.txt'), 'utf8'), 'recovered ok')
  } finally {
    await host.close()
  }
})
