import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { getCurrentTools } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { PiExecution } from '../src/pi.ts'
import { ModelUnavailableError, type ExecutionConfig, type RuntimeEvent } from '../src/execution.ts'

const firstRoute = { provider: 'faux', model: 'test-a' }
const nextRoute = { provider: 'faux', model: 'test-b' }

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'zlo-pi-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const faux = fauxProvider({ models: [{ id: firstRoute.model }, { id: nextRoute.model }] })
  const execution = new PiExecution(async () => {
    const runtime = await ModelRuntime.create({ authPath: join(cwd, 'auth.json'), modelsPath: null })
    runtime.registerNativeProvider(faux.provider)
    return runtime
  })
  const events: RuntimeEvent[] = []
  const config: ExecutionConfig = {
    cwd,
    sessionDirectory: join(cwd, 'sessions'),
    route: firstRoute,
    tools: [],
    systemPrompt: 'Perform the supplied coding task.',
    onEvent: event => { events.push(event) },
  }
  return { execution, config, faux, events }
}

test('Pi executes an allowlisted tool, streams output and restores its transcript with a new model', async t => {
  const { execution, config, faux, events } = await fixture(t)
  await mkdir(join(config.cwd, '.pi', 'extensions'), { recursive: true })
  await writeFile(join(config.cwd, '.pi', 'extensions', 'untrusted.js'), 'throw new Error("extension should never run")')
  await writeFile(join(config.cwd, 'AGENTS.md'), 'UNTRUSTED_PROJECT_INSTRUCTIONS')
  let calls = 0
  config.tools = [{
    name: 'workspace_write',
    description: 'Write the test artifact',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async execute(id, input) {
      calls++
      assert.equal(id, 'call-write')
      assert.deepEqual(input, { text: 'hello' })
      await writeFile(join(config.cwd, 'artifact.txt'), 'hello')
      return { written: true }
    },
  }]
  const failures: string[] = []
  faux.setResponses([
    (context, options) => {
      if (getCurrentTools(context.messages).map(tool => tool.name).join() !== 'workspace_write') failures.push('tool allowlist')
      if (JSON.stringify(context).includes('UNTRUSTED_PROJECT_INSTRUCTIONS')) failures.push('ambient instructions')
      if (options?.maxRetries !== 0) failures.push('provider retry not disabled')
      return fauxAssistantMessage(fauxToolCall('workspace_write', { text: 'hello' }, { id: 'call-write' }), { stopReason: 'toolUse' })
    },
    context => {
      if (!JSON.stringify(context).includes('written')) failures.push('tool receipt missing')
      return fauxAssistantMessage('Artifact created')
    },
  ])
  const session = await execution.open(config)
  try {
    assert.deepEqual(await session.run('Write an artifact'), { status: 'completed', text: 'Artifact created' })
    await session.checkpoint()
  } finally { await session.dispose() }
  assert.equal(failures.length, 0, failures.join(', '))
  assert.equal(calls, 1)
  assert.equal(await readFile(join(config.cwd, 'artifact.txt'), 'utf8'), 'hello')
  assert.equal(events.filter(event => event.type === 'model.request_started').length, 2)
  assert.equal(events.filter(event => event.type === 'model.usage').length, 2)
  assert.equal(events.flatMap(event => event.type === 'message.delta' ? [event.delta] : []).join(''), 'Artifact created')

  await execution.validateRoute(nextRoute)
  await assert.rejects(execution.validateRoute({ provider: 'faux', model: 'missing' }), ModelUnavailableError)
  faux.setResponses([(context, _options, _state, model) => {
    if (model.id !== nextRoute.model) failures.push('switch did not reach provider')
    if (!JSON.stringify(context).includes('Write an artifact')) failures.push('old context not restored')
    return fauxAssistantMessage('Resumed with previous context')
  }])
  const reopened = await execution.open({ ...config, session: session.ref, route: nextRoute })
  try {
    assert.deepEqual(reopened.ref, session.ref)
    assert.deepEqual(reopened.route, nextRoute)
    assert.deepEqual(await reopened.run('Continue'), { status: 'completed', text: 'Resumed with previous context' })
    await reopened.checkpoint()
  } finally { await reopened.dispose() }
  assert.deepEqual(failures, [])
  assert.ok(events.some(event => event.type === 'model.route_changed' && event.route.model === nextRoute.model))
  const restored = await execution.open({ ...config, session: session.ref, route: undefined })
  try { assert.deepEqual(restored.route, nextRoute) } finally { await restored.dispose() }
})

test('Pi queues steering while a provider call is active and persists the user message', { timeout: 5_000 }, async t => {
  const { execution, config, faux } = await fixture(t)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  faux.setResponses([
    async () => {
      entered.resolve()
      await release.promise
      return fauxAssistantMessage('First reply')
    },
    context => fauxAssistantMessage(JSON.stringify(context).includes('new constraint') ? 'Constraint seen' : 'Missing constraint'),
  ])
  const session = await execution.open(config)
  const result = session.run('Start working')
  try {
    await entered.promise
    await session.steer('new constraint')
    release.resolve()
    assert.deepEqual(await result, { status: 'completed', text: 'Constraint seen' })
    await session.checkpoint()
    assert.match(await readFile(session.ref.path, 'utf8'), /new constraint/)
  } finally {
    release.resolve()
    await session.dispose()
  }
})

test('Pi cancels a live model request, checkpoints and continues with a fresh session instance', { timeout: 5_000 }, async t => {
  const { execution, config, faux } = await fixture(t)
  const entered = Promise.withResolvers<void>()
  let sawAbort = false
  faux.setResponses([async (_context, options) => {
    entered.resolve()
    const signal = options?.signal
    if (!signal) return fauxAssistantMessage('Missing abort signal')
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    sawAbort = signal.aborted
    return fauxAssistantMessage('', { stopReason: 'aborted' })
  }])
  const session = await execution.open(config)
  const result = session.run('This turn is interrupted')
  await entered.promise
  await Promise.all([session.requestStop(), session.requestStop()])
  assert.deepEqual(await result, { status: 'interrupted' })
  assert.equal(sawAbort, true)
  await session.checkpoint()
  await session.dispose()

  faux.setResponses([context => fauxAssistantMessage(JSON.stringify(context).includes('This turn is interrupted') ? 'Continued' : 'Missing context')])
  const resumed = await execution.open({ ...config, session: session.ref })
  try { assert.deepEqual(await resumed.run('Resume safely'), { status: 'completed', text: 'Continued' }) }
  finally { await resumed.dispose() }
})

test('Pi waits for a started tool to settle and skips the next tool after Stop', { timeout: 5_000 }, async t => {
  const { execution, config, faux } = await fixture(t)
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const calls: string[] = []
  config.tools = [{
    name: 'test_effect',
    description: 'Return a result after a safe boundary',
    parameters: { type: 'object' },
    async execute(id) {
      calls.push(id)
      started.resolve()
      await release.promise
      return { boundary: 'completed' }
    },
  }]
  faux.setResponses([fauxAssistantMessage([
    fauxToolCall('test_effect', {}, { id: 'first' }),
    fauxToolCall('test_effect', {}, { id: 'second' }),
  ], { stopReason: 'toolUse' })])
  const session = await execution.open(config)
  const result = session.run('Execute both tools')
  try {
    await started.promise
    let stopFinished = false
    const stop = session.requestStop().then(() => { stopFinished = true })
    await Promise.resolve()
    assert.equal(stopFinished, false)
    release.resolve()
    await stop
    assert.deepEqual(await result, { status: 'interrupted' })
    assert.deepEqual(calls, ['first'])
    assert.equal(faux.state.callCount, 1)
    await session.checkpoint()
    assert.match(await readFile(session.ref.path, 'utf8'), /boundary/)
  } finally {
    release.resolve()
    await session.dispose()
  }
  faux.setResponses([fauxAssistantMessage('Continued without replay')])
  const resumed = await execution.open({ ...config, session: session.ref })
  try { assert.deepEqual(await resumed.run('Resume safely'), { status: 'completed', text: 'Continued without replay' }) }
  finally { await resumed.dispose() }
  assert.deepEqual(calls, ['first'])
})

test('Pi can checkpoint before a first assistant response and rejects damaged or missing transcripts', { timeout: 5_000 }, async t => {
  const { execution, config, faux } = await fixture(t)
  const fresh = await execution.open(config)
  const result = fresh.run('Stop immediately')
  await fresh.requestStop()
  assert.deepEqual(await result, { status: 'interrupted' })
  await fresh.checkpoint()
  await fresh.dispose()
  assert.equal(faux.state.callCount, 0)
  const reopened = await execution.open({ ...config, session: fresh.ref })
  assert.deepEqual(reopened.ref, fresh.ref)
  await reopened.dispose()
  await appendFile(fresh.ref.path, '{"type":')
  await assert.rejects(execution.open({ ...config, session: fresh.ref }), /incomplete/)
  await rm(fresh.ref.path)
  await assert.rejects(execution.open({ ...config, session: fresh.ref }), { code: 'ENOENT' })
})

test('a resolved Pi model error is reported without retry and observer exceptions do not escape', async t => {
  const { execution, config, faux } = await fixture(t)
  config.onEvent = () => { throw new Error('broken observer') }
  faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: '429 retryable test error' })])
  const session = await execution.open(config)
  try {
    assert.deepEqual(await session.run('Trigger a provider error'), { status: 'model_error' })
    assert.equal(faux.state.callCount, 1)
    await session.checkpoint()
  } finally { await session.dispose() }
})

test('Pi rejects missing model configuration before a session is created', async t => {
  const { config } = await fixture(t)
  await assert.rejects(new PiExecution().open({ ...config, route: undefined }), ModelUnavailableError)
  assert.deepEqual(await readdir(config.sessionDirectory), [])
})

test('default Pi runtime validates an environment route without discovery or a credential file', async t => {
  const { config } = await fixture(t)
  const piDirectory = join(config.cwd, 'pi-config')
  await mkdir(piDirectory)
  const oldDirectory = process.env.PI_CODING_AGENT_DIR
  const oldKey = process.env.OPENAI_API_KEY
  process.env.PI_CODING_AGENT_DIR = piDirectory
  process.env.OPENAI_API_KEY = 'offline-test-value'
  t.after(() => {
    if (oldDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldDirectory
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = oldKey
  })
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request') })
  const execution = new PiExecution()
  const route = { provider: 'openai', model: 'gpt-4.1-mini' }
  await execution.validateRoute(route)
  const session = await execution.open({ ...config, route })
  try { assert.deepEqual(session.route, route) } finally { await session.dispose() }
  await assert.rejects(execution.validateRoute({ provider: 'google-vertex', model: 'gemini-2.5-flash' }), ModelUnavailableError)
  assert.deepEqual(await readdir(piDirectory), [])
  assert.equal(fetch.mock.callCount(), 0)
})
