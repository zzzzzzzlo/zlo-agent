import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { AgentExecution, ExecutionConfig, ExecutionResult } from '../src/execution.ts'
import { LocalAgentHost } from '../src/host.ts'

const route = { provider: 'test', model: 'deterministic' }
const crashFixture = fileURLToPath(new URL('./fixtures/crash-host.ts', import.meta.url))

function directories(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'zlo-recovery-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, 'workspace')
  mkdirSync(cwd)
  return { directory: join(root, 'host'), cwd: realpathSync.native(cwd) }
}

async function crashHost(t: TestContext, directory: string, cwd: string,
  mode: 'settled-write' | 'unknown-effect' | 'missing-session'): Promise<{ taskId: string; sessionId: string }> {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', crashFixture, directory, cwd, mode], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const exited = once(child, 'exit')
  const lines = createInterface({ input: child.stdout })
  let boundaryReached = false
  try {
    const [line] = await Promise.race([
      once(lines, 'line', { signal: t.signal }),
      exited.then(([code, signal]) => { throw new Error(`Host exited before crash boundary (${code ?? signal})`) }),
    ])
    boundaryReached = true
    return JSON.parse(line)
  } finally {
    lines.close()
    child.kill('SIGKILL')
    const [, signal] = await exited
    if (boundaryReached) assert.equal(signal, 'SIGKILL')
  }
}

function deterministicExecution(options: {
  onOpen?: (config: ExecutionConfig) => void
  onRun?: (prompt: string) => Promise<ExecutionResult>
  onStop?: () => void
  onCheckpoint?: () => void
} = {}): AgentExecution {
  return {
    async validateRoute() {},
    async open(config) {
      options.onOpen?.(config)
      const ref = config.session ?? { id: 'deterministic-session', path: join(config.sessionDirectory, 'test.jsonl') }
      if (!config.session) {
        mkdirSync(config.sessionDirectory, { recursive: true })
        writeFileSync(ref.path, JSON.stringify({ id: ref.id }) + '\n', { flush: true })
      }
      return {
        ref,
        route,
        async run(prompt) { return options.onRun?.(prompt) ?? { status: 'completed', text: 'verified' } },
        async steer() {},
        async requestStop() { options.onStop?.() },
        async checkpoint() { options.onCheckpoint?.() },
        async dispose() {},
      }
    },
  }
}

test('crash recovery honors Stop Intent and resumes the same Session without repeating a confirmed write', { timeout: 10000 }, async (t) => {
  const { directory, cwd } = directories(t)
  const { taskId, sessionId } = await crashHost(t, directory, cwd, 'settled-write')
  const opened: ExecutionConfig[] = []
  const prompts: string[] = []
  const host = new LocalAgentHost({ directory, execution: deterministicExecution({
    onOpen: (config) => opened.push(config),
    onRun: async (prompt) => { prompts.push(prompt); return { status: 'completed', text: 'Verified existing artifact' } },
  }) })
  try {
    const stopped = host.getHistory(taskId)
    assert.equal(stopped.task.status, 'stopped')
    assert.equal(stopped.task.reason, 'user_stop')
    assert.deepEqual(stopped.task.stopIntent, { requestId: 'stop-before-crash', source: 'user' })
    assert.equal(stopped.session?.id, sessionId)
    assert.equal(stopped.attempts[0]?.status, 'interrupted')
    assert.equal(stopped.operations[0]?.status, 'succeeded')
    assert.deepEqual(host.stop(taskId, 'stop-before-crash'), { accepted: true, status: 'stop_requested' })
    assert.equal(host.events(taskId).filter((event) => event.type === 'task.stop_requested').length, 1)
    await host.idle()
    assert.equal(opened.length, 0)

    assert.equal(host.resume(taskId, 'resume-after-crash').accepted, true)
    await host.idle()
    const resumed = host.getHistory(taskId)
    assert.equal(resumed.task.status, 'succeeded')
    assert.equal(resumed.task.attemptCount, 2)
    assert.equal(resumed.task.verification?.passed, true)
    assert.equal(resumed.task.verification?.verdict, 'verified')
    assert.equal(resumed.task.stopIntent, undefined)
    assert.equal(opened.length, 1)
    assert.deepEqual(opened[0]?.session, stopped.session)
    assert.match(prompts[0] ?? '', /saved conversation/)
    assert.match(prompts[0] ?? '', /Create the verified artifact once/)
    assert.deepEqual(resumed.operations, stopped.operations)
    assert.equal(readFileSync(join(cwd, 'artifact.txt'), 'utf8'), 'written once\n')

    const events = host.events(taskId)
    const started = events.filter((event) => event.type === 'agent.started')
    assert.equal(started.length, 2)
    assert.equal(started[0]?.sessionId, sessionId)
    assert.equal(started[1]?.sessionId, sessionId)
    assert.notEqual(started[0]?.agentRunId, started[1]?.agentRunId)
    assert.equal(started[0]?.agentId, started[1]?.agentId)
    assert.ok(events.some((event) => event.type === 'agent.finished' && event.payload.reason === 'process_interrupted'))
    assert.deepEqual(events.map((event) => event.seq), events.map((_event, index) => index + 1))
  } finally {
    await host.close()
  }
})

test('crash after a write and before its receipt blocks replay even with a saved Stop Intent', { timeout: 10000 }, async (t) => {
  const { directory, cwd } = directories(t)
  const { taskId, sessionId } = await crashHost(t, directory, cwd, 'unknown-effect')
  let opened = 0
  const host = new LocalAgentHost({ directory, execution: deterministicExecution({ onOpen: () => { opened++ } }) })
  try {
    const { task, session, operations, attempts } = host.getHistory(taskId)
    assert.equal(task.status, 'needs_reconciliation')
    assert.equal(task.reason, 'unknown_effect')
    assert.equal(task.stopIntent?.requestId, 'stop-before-crash')
    assert.equal(session?.id, sessionId)
    assert.deepEqual(operations.map(({ effect, status }) => [effect, status]), [['write', 'unknown_effect']])
    assert.equal(attempts[0]?.status, 'unknown_effect')
    assert.equal(readFileSync(join(cwd, 'artifact.txt'), 'utf8'), 'written once\n')
    const events = host.events(taskId)
    assert.equal(events.filter((event) => event.type === 'tool.started').length, 1)
    assert.equal(events.some((event) => event.type === 'task.stopped'), false)
    assert.deepEqual(events.filter((event) => event.type === 'tool.finished').map(({ payload }) => payload.status),
      ['unknown_effect'])
    assert.deepEqual(events.find((event) => event.type === 'operation.reconciliation_required')?.payload.operationIds,
      [operations[0]?.id])
    assert.deepEqual(host.resume(taskId, 'unsafe-resume'), { accepted: false, status: 'needs_reconciliation' })
    await host.idle()
    assert.equal(opened, 0)
  } finally {
    await host.close()
  }
})

test('startup refuses to resume a crashed task whose recorded Session file disappeared', { timeout: 10000 }, async (t) => {
  const { directory, cwd } = directories(t)
  const { taskId, sessionId } = await crashHost(t, directory, cwd, 'missing-session')
  let opened = 0
  const host = new LocalAgentHost({ directory, execution: deterministicExecution({ onOpen: () => { opened++ } }) })
  try {
    const { task, session, operations } = host.getHistory(taskId)
    assert.equal(session?.id, sessionId)
    assert.ok(session && !existsSync(session.path))
    assert.equal(task.status, 'needs_reconciliation')
    assert.equal(task.reason, 'checkpoint_error')
    assert.equal(operations[0]?.status, 'succeeded')
    assert.equal(host.events(taskId).some((event) => event.type === 'task.stopped'), false)
    assert.deepEqual(host.resume(taskId, 'missing-session-resume'), { accepted: false, status: 'needs_reconciliation' })
    await host.idle()
    assert.equal(opened, 0)
  } finally {
    await host.close()
  }
})

test('a Run stuck past the graceful stop deadline cannot report stopped or allow resume', { timeout: 10000 }, async (t) => {
  const { directory, cwd } = directories(t)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<ExecutionResult>()
  const timedOut = Promise.withResolvers<void>()
  let stopRequests = 0
  let checkpoints = 0
  const execution = deterministicExecution({
    onRun: () => { entered.resolve(); return release.promise },
    onStop: () => { stopRequests++ },
    onCheckpoint: () => { checkpoints++ },
  })
  const host = new LocalAgentHost({ directory, execution, stopTimeoutMs: 20 })
  try {
    const { taskId } = await host.createTask({
      requestId: 'create-stuck-run', goal: 'Wait for the test to release the runtime', cwd, check: { path: 'artifact.txt' },
    })
    await entered.promise
    const unsubscribe = host.subscribe(taskId, 0, (event) => {
      if (event.type === 'operation.reconciliation_required' && event.payload.reason === 'stop_timeout') timedOut.resolve()
    })
    try {
      assert.deepEqual(host.stop(taskId, 'stop-stuck-run'), { accepted: true, status: 'stop_requested' })
      assert.equal(host.getTask(taskId).status, 'stopping')
      await timedOut.promise
    } finally {
      unsubscribe()
    }
    assert.equal(stopRequests, 1)
    assert.equal(checkpoints, 0)
    assert.equal(host.getTask(taskId).status, 'needs_reconciliation')
    assert.equal(host.getTask(taskId).reason, 'stop_timeout')
    assert.deepEqual(host.resume(taskId, 'resume-stuck-run'), { accepted: false, status: 'needs_reconciliation' })
    assert.throws(() => new LocalAgentHost({ directory, execution }), /already has a Host writer/)

    release.resolve({ status: 'interrupted' })
    await host.idle()
    assert.equal(checkpoints, 1)
    assert.equal(host.getTask(taskId).status, 'needs_reconciliation')
    assert.equal(host.events(taskId).some((event) => event.type === 'task.stopped'), false)
  } finally {
    release.resolve({ status: 'interrupted' })
    await host.close()
  }
})
