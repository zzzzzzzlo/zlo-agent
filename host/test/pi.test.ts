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
import { LocalAgentHost } from '../src/host.ts'

const firstRoute = { provider: 'faux', model: 'test-a' }
const nextRoute = { provider: 'faux', model: 'test-b' }

async function fixture(t: TestContext, contextWindow?: number) {
  const cwd = await mkdtemp(join(tmpdir(), 'zlo-pi-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const faux = fauxProvider({ models: [{ id: firstRoute.model, contextWindow }, { id: nextRoute.model }] })
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

test('Pi compacts an existing transcript at a request boundary and meters each provider call', async t => {
  const { execution, config, faux, events } = await fixture(t, 4096)
  const requests: string[] = []
  config.reserveRequest = ({ kind }) => { requests.push(kind) }
  faux.setResponses(Array.from({ length: 16 }, () => fauxAssistantMessage('verified detail '.repeat(130))))
  const session = await execution.open(config)
  try {
    for (let turn = 0; turn < 5; turn++) {
      assert.equal((await session.run('Keep this distinct context: ' + turn + ' ' + 'project evidence '.repeat(130))).status, 'completed')
    }
    await session.checkpoint()
    assert.ok(requests.includes('compaction'))
    assert.equal(events.filter(event => event.type === 'model.usage').length, requests.length)
    assert.ok(events.some(event => event.type === 'context.compacted'))
    assert.match(await readFile(session.ref.path, 'utf8'), /"type":"compaction"/)
  } finally {
    await session.dispose()
  }
})

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

test('a failed patch guides Pi to reread the exact workspace lines and retry without partial writes', async t => {
  const { execution, config, faux } = await fixture(t)
  const cwd = join(config.cwd, 'workspace')
  const path = 'bike.html'
  const exact = '      <!-- far arm -->\r\n      <path/>\r\n'
  const original = '<svg>\r\n' + exact + '</svg>\r\n'
  await mkdir(cwd)
  await writeFile(join(cwd, path), original)
  const replacement = '      <path id="far-arm"/>\r\n'
  const call = (name: string, args: Parameters<typeof fauxToolCall>[1], id: string) =>
    fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: 'toolUse' })
  const firstEdit = { path, oldText: '<svg>', newText: '<svg viewBox="0 0 640 360">' }
  const failures: unknown[] = []
  const recoverySteps: string[] = []
  faux.setResponses([
    call('apply_patch', { edits: [firstEdit, { path, oldText: '        <!-- far arm -->\n      <path/>', newText: replacement }] }, 'wrong-indent'),
    async context => {
      try {
        const result = context.messages.findLast(message => message.role === 'toolResult')
        assert.equal(result?.toolCallId, 'wrong-indent')
        assert.equal(result?.isError, true)
        const content = result?.content.find(block => block.type === 'text')?.text
        assert.ok(content)
        const failure = JSON.parse(content)
        assert.equal(failure.edit, 2)
        assert.deepEqual(failure.readRange, { startLine: 2, lineCount: 2 })
        assert.equal(await readFile(join(cwd, path), 'utf8'), original)
        recoverySteps.push('failed patch')
        return call('read_text_file', { path, ...failure.readRange }, 'reread-lines')
      } catch (error) { failures.push(error); return fauxAssistantMessage('Patch recovery failed.') }
    },
    context => {
      try {
        const result = context.messages.findLast(message => message.role === 'toolResult')
        assert.equal(result?.toolCallId, 'reread-lines')
        const content = result?.content.find(block => block.type === 'text')?.text
        assert.ok(content)
        const excerpt = JSON.parse(content)
        assert.equal(excerpt.text, exact)
        recoverySteps.push('exact reread')
        return call('apply_patch', { edits: [firstEdit, { path, oldText: excerpt.text, newText: replacement }] }, 'correct-patch')
      } catch (error) { failures.push(error); return fauxAssistantMessage('Patch recovery failed.') }
    },
    fauxAssistantMessage('Both SVG edits were applied.'),
  ])
  const host = new LocalAgentHost({ directory: join(config.cwd, 'state'), execution })
  try {
    const { taskId } = await host.createTask({ requestId: 'patch-recovery', goal: 'Update the SVG arm and viewBox.', cwd,
      route: firstRoute, workspaceAccess: 'write', check: { path, contains: replacement } })
    await host.idle()
    assert.deepEqual(failures, [])
    assert.deepEqual(recoverySteps, ['failed patch', 'exact reread'])
    assert.equal(host.getTask(taskId).verification?.verdict, 'verified')
    assert.equal(await readFile(join(cwd, path), 'utf8'), firstEdit.newText + '\r\n' + replacement + '</svg>\r\n')
    assert.deepEqual(host.events(taskId).filter(event => event.type === 'tool.finished').map(event => [event.payload.tool, event.payload.status]), [
      ['apply_patch', 'failed'], ['read_text_file', 'succeeded'], ['apply_patch', 'succeeded'],
    ])
  } finally { await host.close() }
})

test('Pi assembles trusted instructions and skill descriptions, then reads only an available skill', async t => {
  const { execution, config, faux } = await fixture(t)
  const user = join(config.cwd, 'instructions')
  const project = join(config.cwd, 'project')
  const guide = join(project, '.agents', 'skills', 'test-guide')
  const privateGuide = join(project, '.agents', 'skills', 'private-guide')
  await mkdir(user)
  await mkdir(guide, { recursive: true })
  await mkdir(privateGuide, { recursive: true })
  await writeFile(join(config.cwd, 'AGENTS.md'), 'OUTSIDE_SCOPE_GUIDE')
  await writeFile(join(user, 'AGENTS.md'), 'USER_SCOPE_GUIDE')
  await writeFile(join(project, 'AGENTS.md'), 'PROJECT_SCOPE_GUIDE')
  await writeFile(join(guide, 'SKILL.md'), '---\nname: test-guide\ndescription: Skill summary for a scoped task\n---\nSKILL_BODY_ON_DEMAND')
  await writeFile(join(privateGuide, 'SKILL.md'), '---\nname: private-guide\ndescription: PRIVATE_SKILL_SUMMARY\ndisable-model-invocation: true\n---\nPRIVATE_SKILL_BODY')
  let allowed = true
  faux.setResponses([
    context => {
      const rendered = JSON.stringify(context)
      for (const text of ['USER_SCOPE_GUIDE', 'PROJECT_SCOPE_GUIDE', 'Skill summary for a scoped task', config.systemPrompt]) {
        assert.ok(rendered.includes(text), 'Missing prompt material: ' + text)
      }
      for (const text of ['OUTSIDE_SCOPE_GUIDE', 'SKILL_BODY_ON_DEMAND', 'PRIVATE_SKILL_SUMMARY', 'PRIVATE_SKILL_BODY']) {
        assert.ok(!rendered.includes(text), 'Unexpected prompt material: ' + text)
      }
      assert.deepEqual(getCurrentTools(context.messages).map(tool => tool.name), ['read_skill'])
      return fauxAssistantMessage(fauxToolCall('read_skill', { name: 'test-guide' }, { id: 'skill-before' }), { stopReason: 'toolUse' })
    },
    context => {
      assert.match(JSON.stringify(context.messages.findLast(message => message.role === 'toolResult')), /SKILL_BODY_ON_DEMAND/)
      allowed = false
      return fauxAssistantMessage(fauxToolCall('read_skill', { name: 'test-guide' }, { id: 'skill-after' }), { stopReason: 'toolUse' })
    },
    context => {
      const result = context.messages.findLast(message => message.role === 'toolResult')
      assert.equal(result?.isError, true)
      assert.match(JSON.stringify(result), /Skill access is unavailable/)
      return fauxAssistantMessage('Scope enforced')
    },
  ])
  const session = await execution.open({ ...config, cwd: project, instructionScopes: { user, project }, skillReadsAllowed: () => allowed })
  try { assert.deepEqual(await session.run('Use the approved guidance'), { status: 'completed', text: 'Scope enforced' }) }
  finally { await session.dispose() }

  faux.setResponses([context => {
    assert.deepEqual(getCurrentTools(context.messages).map(tool => tool.name), [])
    assert.doesNotMatch(JSON.stringify(context), /read_skill|Skill summary for a scoped task/)
    return fauxAssistantMessage('Skill hidden')
  }])
  const restricted = await execution.open({ ...config, cwd: project, instructionScopes: { user, project }, skillReadsAllowed: () => false })
  try { assert.deepEqual(await restricted.run('Complete this without skills'), { status: 'completed', text: 'Skill hidden' }) }
  finally { await restricted.dispose() }
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

test('a nonretryable Pi model error is reported and observer exceptions do not escape', async t => {
  const { execution, config, faux } = await fixture(t)
  config.onEvent = () => { throw new Error('broken observer') }
  faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: '401 invalid test credential' })])
  const session = await execution.open(config)
  try {
    assert.deepEqual(await session.run('Trigger a provider error'), { status: 'model_error' })
    assert.equal(faux.state.callCount, 1)
    await session.checkpoint()
  } finally { await session.dispose() }
})

test('Pi serializes a tool batch and retries a transient provider error without repeating completed work', async t => {
  const { execution, config, faux } = await fixture(t)
  const metering: string[] = []
  let tools = 0
  let toolActive = false
  config.reserveRequest = () => { metering.push('reserve') }
  config.onEvent = event => {
    if (event.type === 'model.request_unaccounted') metering.push('uncertain')
    if (event.type === 'model.usage') metering.push('usage')
  }
  config.tools = [{ name: 'record_test_result', description: 'Return a completed verification receipt', parameters: { type: 'object' },
    async execute() {
      assert.equal(toolActive, false)
      toolActive = true
      await new Promise(resolve => setImmediate(resolve))
      toolActive = false
      tools++
      return { evidence: 'confirmed test result ' + tools }
    } }]
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('record_test_result', {}), fauxToolCall('record_test_result', {})], { stopReason: 'toolUse' }),
    () => { throw new Error('429 transient test error') },
    context => {
      assert.match(JSON.stringify(context.messages), /confirmed test result 1/)
      assert.match(JSON.stringify(context.messages), /confirmed test result 2/)
      return fauxAssistantMessage('Verified')
    },
  ])
  const session = await execution.open(config)
  try { assert.deepEqual(await session.run('Verify the fixture'), { status: 'completed', text: 'Verified' }) }
  finally { await session.dispose() }
  assert.equal(tools, 2)
  assert.deepEqual(metering, ['reserve', 'usage', 'reserve', 'uncertain', 'reserve', 'usage'])
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
