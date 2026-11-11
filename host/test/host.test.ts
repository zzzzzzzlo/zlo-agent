import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { FakeExecution } from '../src/fake.ts'
import { LocalAgentHost } from '../src/host.ts'
import { PiExecution } from '../src/pi.ts'
import type { AgentExecution } from '../src/execution.ts'

async function paths(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'zlo-host-'))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, cwd, directory: join(root, 'state') }
}

const fakeA = { provider: 'fake', model: 'coding' }
const fakeB = { provider: 'fake', model: 'alternate' }
const check = { path: 'demo.txt', contains: 'verified by zlo agent' }

async function until(predicate: () => boolean) {
  for (let tick = 0; tick < 250; tick++) {
    if (predicate()) return
    await delay(10)
  }
  throw new Error('Timed out waiting for event')
}

test('Host records tasks, isolated subscriptions and cursor replay across restart', { timeout: 6000 }, async (t) => {
  const setup = await paths(t)
  const execution = new FakeExecution()
  let host = new LocalAgentHost({ ...setup, execution })
  try {
    const command = { requestId: 'request', goal: 'demo', cwd: setup.cwd, check }
    const [first, duplicate] = await Promise.all([host.createTask(command), host.createTask(command)])
    assert.deepEqual(first, duplicate)
    const live: number[] = []
    const output: string[] = []
    host.subscribe(first.taskId, 0, () => { throw new Error('observer failed') })
    host.subscribe(first.taskId, 0, async (event) => { live.push(event.seq) })
    host.subscribeOutput((event) => { output.push(event.delta) })
    await host.idle()
    assert.equal(host.getTask(first.taskId).status, 'succeeded')
    await until(() => live.at(-1) === host.events(first.taskId).at(-1)?.seq)
    assert.equal(output.join(''), 'Demo run completed.')
    assert.ok((await readFile(join(setup.cwd, check.path), 'utf8')).includes(check.contains))
    const history = host.getHistory(first.taskId)
    assert.ok(history.session)
    assert.equal(history.attempts.length, 1)
    assert.deepEqual(history.operations.map(({ status }) => status).sort(), ['failed', 'succeeded'])
    const toolEvent = host.events(first.taskId).find(({ type }) => type === 'tool.started')
    assert.equal(toolEvent?.sessionId, history.session.id)
    assert.equal(toolEvent?.taskAttemptId, history.attempts[0].id)
    const cut = live.at(-2)!
    await host.close()
    host = new LocalAgentHost({ ...setup, execution })
    assert.deepEqual(host.getHistory(first.taskId), history)
    assert.deepEqual(await host.createTask(command), first)
    assert.deepEqual(host.events(first.taskId, cut).map((event) => event.seq), [cut + 1])
    assert.equal(host.getTask(first.taskId).status, 'succeeded')
  } finally {
    await host.close()
  }
})

test('A successful model response fails the task when the file check fails', async (t) => {
  const setup = await paths(t)
  const host = new LocalAgentHost({ ...setup, execution: new FakeExecution() })
  try {
    const { taskId } = await host.createTask({
      requestId: 'fail-verification', goal: 'demo', cwd: setup.cwd, check: { ...check, contains: 'does not exist' },
    })
    await host.idle()
    const task = host.getTask(taskId)
    assert.equal(task.status, 'failed')
    assert.equal(task.reason, 'verification_failed')
    assert.equal(task.verification?.passed, false)
  } finally {
    await host.close()
  }
})

test('Root stops during active Worker, then resumes the saved Session and completes one Worker node', { timeout: 9000 }, async (t) => {
  const setup = await paths(t)
  const host = new LocalAgentHost({ ...setup, execution: new FakeExecution() })
  try {
    const { taskId } = await host.createTask({ requestId: 'delegated', goal: 'demo delegate', cwd: setup.cwd, check })
    await until(() => host.events(taskId).some(({ type, payload }) => type === 'agent.started' && payload.role === 'worker'))
    const session = host.getHistory(taskId).session
    const stop = host.stop(taskId, 'stop-worker')
    assert.equal(stop.status, 'stop_requested')
    assert.deepEqual(host.stop(taskId, 'stop-worker'), stop)
    assert.equal(host.resume(taskId, 'resume-too-soon').accepted, false)
    await host.idle()
    assert.equal(host.getTask(taskId).status, 'stopped')
    assert.equal(host.getTask(taskId).reason, 'user_stop')
    assert.equal(host.getTask(taskId).worker?.status, 'ready')
    assert.deepEqual(await host.command({ schemaVersion: 1, type: 'getRouteStatus' }), { quota: 'unknown', activeReservations: 0 })
    host.addInstruction(taskId, 'instruction', 'Keep the verified marker')
    await host.requestModelSwitch(taskId, 'switch', fakeB)
    assert.equal(host.resume(taskId, 'resume').accepted, true)
    await host.idle()
    const { task, session: resumed, attempts } = host.getHistory(taskId)
    assert.deepEqual(resumed, session)
    assert.equal(task.status, 'succeeded')
    assert.equal(task.worker?.result?.resultStatus, 'succeeded')
    assert.equal(task.instructions[0].delivered, true)
    assert.equal(attempts.filter((attempt) => attempt.nodeId === task.rootNodeId).length, 2)
    const events = host.events(taskId)
    const rootRuns = events.filter(({ type, payload }) => type === 'agent.started' && payload.role === 'root')
    const workers = events.filter(({ type, payload }) => type === 'agent.started' && payload.role === 'worker')
    assert.equal(workers.length, 2)
    assert.deepEqual(workers.map((item) => item.parentAgentRunId), rootRuns.map((item) => item.agentRunId))
    assert.notEqual(workers[0].sessionId, workers[1].sessionId)
    assert.ok(workers.every((item) => item.sessionId !== session?.id && item.taskAttemptId !== task.attemptId))
    assert.ok([...workers, ...rootRuns].every((item) => item.taskRunId === task.taskRunId && item.taskRunId !== item.taskAttemptId))
    assert.notEqual(rootRuns[0].taskAttemptId, rootRuns[1].taskAttemptId)
    assert.equal(events.filter(({ type }) => type === 'model.route_changed').length, 1)
    assert.equal(events.filter(({ type }) => type === 'task.stopped').length, 1)
    assert.equal(host.stop(taskId, 'stop-worker').status, 'stop_requested')
    assert.equal(host.getTask(taskId).status, 'succeeded')
    assert.deepEqual(await host.command({ schemaVersion: 1, type: 'getRouteStatus' }), { quota: 'unknown', activeReservations: 0 })
  } finally {
    await host.close()
  }
})

test('Pi-backed Host runs actual Root and Fresh Worker loops, applies a model change at a turn boundary', { timeout: 8000 }, async (t) => {
  const setup = await paths(t)
  const first = { provider: 'faux', model: 'a' }
  const second = { provider: 'faux', model: 'b' }
  const provider = fauxProvider({ models: [{ id: first.model }, { id: second.model }] })
  const execution = new PiExecution(async () => {
    const runtime = await ModelRuntime.create({ authPath: join(setup.root, 'auth.json'), modelsPath: null })
    runtime.registerNativeProvider(provider.provider)
    return runtime
  })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const observed: string[] = []
  const tool = (name: string, input: Record<string, string>, id: string) =>
    fauxAssistantMessage(fauxToolCall(name, input, { id }), { stopReason: 'toolUse' })
  const rootGoal = 'ROOT ONLY create demo.txt and delegate a read'
  provider.setResponses([
    async () => {
      entered.resolve()
      await release.promise
      return tool('create_text_file', { path: 'demo.txt', content: check.contains }, 'write')
    },
    () => tool('delegate_task', { goal: 'Inspect demo.txt' }, 'delegate'),
    (context) => {
      observed.push(JSON.stringify(context).includes(rootGoal) ? 'leaked-parent' : 'fresh-worker')
      return tool('read_text_file', { path: 'demo.txt' }, 'read')
    },
    () => fauxAssistantMessage('Verified the marker in demo.txt.'),
    (context) => {
      observed.push(JSON.stringify(context).includes('evidenceRefs') ? 'structured-handoff' : 'missing-handoff')
      return tool('delegate_task', { goal: 'Attempt a second independent delegation' }, 'delegate-again')
    },
    (context) => {
      observed.push(JSON.stringify(context).includes('rejected by task scope or budget') ? 'budget-enforced' : 'budget-bypassed')
      return fauxAssistantMessage('Worker handed off its evidence.')
    },
    (context, _options, _state, model) => {
      observed.push(model.id)
      observed.push(JSON.stringify(context).includes('new user constraint') ? 'instruction' : 'missing-instruction')
      return fauxAssistantMessage('Applied the updates.')
    },
  ])
  const host = new LocalAgentHost({ ...setup, execution })
  try {
    const { taskId } = await host.createTask({ requestId: 'pi', goal: rootGoal, cwd: setup.cwd, check, route: first })
    await entered.promise
    host.addInstruction(taskId, 'live-instruction', 'new user constraint')
    await host.requestModelSwitch(taskId, 'live-switch', second)
    release.resolve()
    await host.idle()
    assert.deepEqual(observed, ['fresh-worker', 'structured-handoff', 'budget-enforced', 'b', 'instruction'])
    const task = host.getTask(taskId)
    assert.equal(task.status, 'succeeded')
    assert.equal(task.worker?.result?.resultStatus, 'succeeded')
    assert.equal(task.worker?.result?.artifactRefs[0], 'demo.txt')
    assert.equal(host.events(taskId).filter(({ type, payload }) => type === 'agent.started' && payload.role === 'worker').length, 1)
    assert.ok(host.events(taskId).some(({ type }) => type === 'model.usage'))
    const changed = host.events(taskId).filter(({ type }) => type === 'model.route_changed')
    assert.equal(changed.length, 1)
    assert.equal(changed[0].sessionId, host.getHistory(taskId).session?.id)
  } finally {
    release.resolve()
    await host.close()
  }
})

test('Provider errors are blocked, explicit replacement of an unavailable same-provider model can resume', async (t) => {
  const setup = await paths(t)
  const fake = new FakeExecution()
  const execution: AgentExecution = {
    validateRoute: (route) => fake.validateRoute(route),
    async open(config) {
      const session = await fake.open(config)
      return session.route.model === fakeA.model ? { ...session, async run() { return { status: 'model_error' } } } : session
    },
  }
  const host = new LocalAgentHost({ ...setup, execution })
  try {
    const { taskId } = await host.createTask({ requestId: 'provider', goal: 'demo', cwd: setup.cwd, check, route: fakeA })
    await host.idle()
    assert.equal(host.getTask(taskId).status, 'blocked')
    assert.equal(host.getTask(taskId).reason, 'model_error')
    await assert.rejects(host.requestModelSwitch(taskId, 'disallowed', { provider: 'other', model: 'a' }), /Cross-provider/)
    await assert.rejects(host.requestModelSwitch(taskId, 'missing', { provider: 'fake', model: 'missing' }), /Fake routes/)
    await host.requestModelSwitch(taskId, 'replace', fakeB)
    assert.equal(host.resume(taskId, 'retry').accepted, true)
    await host.idle()
    assert.equal(host.getTask(taskId).status, 'succeeded')
  } finally {
    await host.close()
  }
})

test('Worker failure records its own attempt, releases resources and prevents root acceptance', async (t) => {
  const setup = await paths(t)
  const fake = new FakeExecution()
  const execution: AgentExecution = {
    validateRoute: (route) => fake.validateRoute(route),
    async open(config) {
      const session = await fake.open(config)
      if (config.tools.some(({ name }) => name === 'delegate_task')) return session
      assert.deepEqual(config.tools.map(({ name }) => name), ['list_directory', 'read_text_file'])
      return { ...session, async run() { return { status: 'model_error' } } }
    },
  }
  const host = new LocalAgentHost({ ...setup, execution })
  try {
    const { taskId } = await host.createTask({ requestId: 'worker-failure', goal: 'demo delegate', cwd: setup.cwd, check })
    await host.idle()
    const { task, attempts } = host.getHistory(taskId)
    assert.equal(task.worker?.status, 'failed')
    assert.equal(task.verification?.evidence, 'worker_verification_failed')
    assert.equal(task.verification?.verdict, 'failed')
    assert.equal(task.status, 'failed')
    assert.equal(attempts.find(({ nodeId }) => nodeId === task.worker?.id)?.status, 'failed')
    assert.deepEqual(await host.command({ schemaVersion: 1, type: 'getRouteStatus' }), { quota: 'unknown', activeReservations: 0 })
  } finally {
    await host.close()
  }
})

test('User can append one leaf while the root runs, with a checked plan version', { timeout: 6000 }, async (t) => {
  const setup = await paths(t)
  const host = new LocalAgentHost({ ...setup, execution: new FakeExecution() })
  try {
    const { taskId } = await host.createTask({ requestId: 'append-task', goal: 'demo', cwd: setup.cwd, check })
    await until(() => host.events(taskId).some(({ type }) => type === 'model.request_started'))
    assert.throws(() => host.addTask(taskId, 'stale-plan', 'Read demo.txt', 1), /version changed/)
    const worker = host.addTask(taskId, 'user-leaf', 'Read demo.txt', 0)
    assert.deepEqual(host.addTask(taskId, 'user-leaf', 'Read demo.txt', 0), worker)
    await host.idle()
    const task = host.getTask(taskId)
    assert.equal(task.status, 'succeeded')
    assert.equal(task.planVersion, 1)
    assert.equal(task.worker?.id, worker.id)
    assert.equal(task.worker?.result?.resultStatus, 'succeeded')
  } finally {
    await host.close()
  }
})
