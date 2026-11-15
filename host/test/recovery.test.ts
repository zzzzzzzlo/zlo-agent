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
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { LocalAgentHost } from '../src/host.ts'
import { PiExecution } from '../src/pi.ts'

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

test('P0-5: crash recovery rejects 0-byte and truncated JSONL sessions and prevents duplicate or lost instructions across interrupted Pi runs', { timeout: 15000 }, async (t) => {
  // 1. 0-byte and truncated partial JSONL session files must enter needs_reconciliation (checkpoint_error)
  for (const damagedContent of ['', '{"id":"crash-fixture-session"}\n{"partial":']) {
    const { directory, cwd } = directories(t)
    const { taskId } = await crashHost(t, directory, cwd, 'settled-write')
    const sessionPath = join(directory, 'sessions', taskId, 'crash-fixture-session.jsonl')
    writeFileSync(sessionPath, damagedContent, { flush: true })
    const host = new LocalAgentHost({ directory, execution: deterministicExecution() })
    try {
      const { task } = host.getHistory(taskId)
      assert.equal(task.status, 'needs_reconciliation')
      assert.equal(task.reason, 'checkpoint_error')
      assert.deepEqual(host.resume(taskId, 'resume-damaged'), { accepted: false, status: 'needs_reconciliation' })
    } finally {
      await host.close()
    }
  }

  // 2. Mid-prompt user stop marks persisted prompted instructions delivered (no duplicate replay on resume),
  // whereas pre-prompt stop during compaction retains undelivered instructions for resume.
  const { directory, cwd } = directories(t)
  const piRoute = { provider: 'faux', model: 'pi-recovery' }
  const faux = fauxProvider({ models: [{ id: piRoute.model, contextWindow: 4096 }] })
  const execution = new PiExecution(async () => {
    const runtime = await ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: null })
    runtime.registerNativeProvider(faux.provider)
    return runtime
  })
  const host = new LocalAgentHost({ directory, execution, defaultRoute: piRoute })
  try {
    const enteredFirstPrompt = Promise.withResolvers<void>()
    let resumeContextJson = ''
    faux.setResponses([
      async (_ctx, options) => {
        enteredFirstPrompt.resolve()
        await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }))
        return fauxAssistantMessage('', { stopReason: 'aborted' })
      },
      ctx => {
        resumeContextJson = JSON.stringify(ctx.messages)
        return fauxAssistantMessage('Completed after mid-prompt stop')
      },
    ])
    const { taskId } = await host.createTask({
      requestId: 'p05-mid-prompt', goal: 'Inspect repository notes', cwd, route: piRoute,
    })
    // Wait until prompt stream starts, stop it, add an instruction, resume so the instruction is in `prompted`, then stop mid-prompt again!
    await enteredFirstPrompt.promise
    host.stop(taskId, 'stop-turn-1')
    await host.idle()
    assert.equal(host.getTask(taskId).status, 'stopped')

    host.addInstruction(taskId, 'inst-once', 'UNIQUE_CONSTRAINT_ALPHA')
    const enteredSecondPrompt = Promise.withResolvers<void>()
    faux.setResponses([
      async (_ctx, options) => {
        enteredSecondPrompt.resolve()
        await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }))
        return fauxAssistantMessage('', { stopReason: 'aborted' })
      },
      ctx => {
        resumeContextJson = JSON.stringify(ctx.messages)
        return fauxAssistantMessage('Finished cleanly')
      },
    ])
    assert.equal(host.resume(taskId, 'resume-with-inst').accepted, true)
    await enteredSecondPrompt.promise
    host.stop(taskId, 'stop-turn-2')
    await host.idle()
    assert.equal(host.getTask(taskId).status, 'stopped')
    assert.equal(host.getTask(taskId).instructions.find(item => item.id === 'inst-once')?.delivered, true)

    assert.equal(host.resume(taskId, 'resume-after-persisted-inst').accepted, true)
    await host.idle()
    assert.equal(host.getTask(taskId).status, 'succeeded')
    const occurrences = resumeContextJson.split('UNIQUE_CONSTRAINT_ALPHA').length - 1
    assert.equal(occurrences, 1, 'Persisted instruction must appear exactly once in resumed Pi context')

    // Use a dedicated standalone task stopped across 4 attempts so session.messages.length >= 8 and tokens > 0.7 * 4096:
    let attemptGate = Promise.withResolvers<void>()
    faux.setResponses(Array.from({ length: 8 }, () => async (_ctx: unknown, options?: { signal?: AbortSignal }) => {
      attemptGate.resolve()
      await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }))
      return fauxAssistantMessage('partial ' + 'context '.repeat(450), { stopReason: 'aborted' })
    }))
    const { taskId: longTaskId } = await host.createTask({
      requestId: 'p05-standalone-compact', goal: 'Standalone long goal ' + 'context '.repeat(450), cwd, route: piRoute,
    })
    await attemptGate.promise
    host.stop(longTaskId, 'long-stop-0')
    await host.idle()
    for (let i = 1; i < 4; i++) {
      attemptGate = Promise.withResolvers<void>()
      host.resume(longTaskId, 'long-resume-' + i)
      await attemptGate.promise
      host.stop(longTaskId, 'long-stop-' + i)
      await host.idle()
    }

    host.addInstruction(longTaskId, 'inst-pre-compact', 'MUST_SURVIVE_COMPACT_STOP')
    const enteredCompact = Promise.withResolvers<void>()
    let finalCompactResumeContext = ''
    faux.setResponses([
      async (_ctx, options) => {
        enteredCompact.resolve()
        await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }))
        return fauxAssistantMessage('', { stopReason: 'aborted' })
      },
      fauxAssistantMessage('Summary after resume'),
      ctx => {
        finalCompactResumeContext = JSON.stringify(ctx.messages)
        return fauxAssistantMessage('Done with retained instruction')
      },
    ])
    assert.equal(host.resume(longTaskId, 'resume-into-compact').accepted, true)
    await enteredCompact.promise
    host.stop(longTaskId, 'stop-during-compact')
    await host.idle()
    assert.equal(host.getTask(longTaskId).instructions.find(item => item.id === 'inst-pre-compact')?.delivered, false)

    assert.equal(host.resume(longTaskId, 'resume-after-compact-stop').accepted, true)
    await host.idle()
    assert.equal(host.getTask(longTaskId).status, 'succeeded')
    assert.equal(host.getTask(longTaskId).instructions.find(item => item.id === 'inst-pre-compact')?.delivered, true)
    assert.match(finalCompactResumeContext, /MUST_SURVIVE_COMPACT_STOP/)
  } finally {
    await host.close()
  }
})
