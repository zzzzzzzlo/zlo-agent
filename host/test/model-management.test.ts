import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { LocalAgentHost } from '../src/host.ts'
import { fetchProviderCatalog } from '../src/model-management.ts'
import { PiExecution } from '../src/pi.ts'

const fixtureKey = 'fixture-credential-for-regression'

test('DeepSeek recovers once, retains completed tool history, and resumes a persisted output-limit block', async () => {
  const route = { provider: 'deepseek', model: 'deepseek-flash' }
  const root = await mkdtemp(join(tmpdir(), 'zlo-deepseek-output-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const provider = fauxProvider({ provider: route.provider, models: [{ id: route.model, reasoning: true, maxTokens: 32_768 }] })
  const execution = new PiExecution(async () => {
    const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null })
    runtime.registerNativeProvider(provider.provider)
    return runtime
  })
  const budgets: (number | undefined)[] = []
  const efforts: (string | undefined)[] = []
  const thinking = 'thinking fixture kept inside the Pi transcript'
  const truncated = 'truncated reasoning fixture'
  provider.setResponses([
    (_, options) => {
      budgets.push(options?.maxTokens)
      efforts.push(options?.reasoning)
      return fauxAssistantMessage([fauxThinking(thinking), fauxToolCall('list_directory', { path: '.' })], { stopReason: 'toolUse' })
    },
    (_, options) => {
      budgets.push(options?.maxTokens)
      efforts.push(options?.reasoning)
      return fauxAssistantMessage(fauxThinking(truncated), { stopReason: 'length' })
    },
    (context, options) => {
      budgets.push(options?.maxTokens)
      efforts.push(options?.reasoning)
      assert.ok(context.messages.some(message => message.role === 'toolResult' && message.toolName === 'list_directory'))
      assert.ok(JSON.stringify(context).includes(thinking))
      assert.ok(!JSON.stringify(context).includes(truncated))
      return fauxAssistantMessage(fauxThinking('second output-limit fixture'), { stopReason: 'length' })
    },
  ])
  const host = new LocalAgentHost({ directory: join(root, 'state'), execution })
  try {
    const conversation = host.createConversation({ requestId: 'create', workspace, workspaceAccess: 'write', route })
    const { taskId } = await host.sendMessage({ conversationId: conversation.id, requestId: 'message', text: 'Inspect the workspace and create demo.html' })
    await host.idle()
    assert.deepEqual(budgets, [16_384, 16_384, 16_384])
    assert.deepEqual(efforts, ['low', 'low', undefined])
    const task = host.getHistory(taskId)
    assert.equal(task.task.status, 'blocked')
    assert.equal(task.task.reason, 'model_output_limit')
    assert.deepEqual(task.operations.map(item => [item.tool, item.status]), [['list_directory', 'succeeded']])
    assert.match(await readFile(task.session!.path, 'utf8'), /thinking fixture kept inside the Pi transcript/u)
    assert.ok(!JSON.stringify(host.getConversationHistory({ conversationId: conversation.id })).includes(thinking))
    assert.ok(!JSON.stringify(host.events(taskId)).includes(thinking))
    assert.deepEqual(host.events(taskId).filter(event => event.type === 'model.output_recovery')
      .map(event => event.payload.trigger), ['automatic'])

    provider.setResponses([
      (context, options) => {
        efforts.push(options?.reasoning)
        assert.ok(context.messages.some(message => message.role === 'toolResult' && message.toolName === 'list_directory'))
        return fauxAssistantMessage(fauxToolCall('create_text_file', { path: 'demo.html', content: '<p>Done</p>' }), { stopReason: 'toolUse' })
      },
      (_, options) => {
        efforts.push(options?.reasoning)
        return fauxAssistantMessage('Done')
      },
    ])
    assert.equal(host.resumeConversation({ conversationId: conversation.id, taskId, requestId: 'resume' }).accepted, true)
    await host.idle()
    assert.equal(host.getTask(taskId).status, 'succeeded')
    const resumed = host.getHistory(taskId)
    assert.equal(resumed.session?.id, task.session?.id)
    assert.deepEqual(resumed.operations.map(item => [item.tool, item.status]).sort(), [
      ['create_text_file', 'succeeded'], ['list_directory', 'succeeded'],
    ])
    assert.equal(await readFile(join(workspace, 'demo.html'), 'utf8'), '<p>Done</p>')
    assert.deepEqual(efforts, ['low', 'low', undefined, undefined, undefined])
    assert.deepEqual(host.events(taskId).filter(event => event.type === 'model.output_recovery')
      .map(event => event.payload.trigger), ['automatic', 'resume'])
  } finally {
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('the DeepSeek wire payload enables low thinking and disables it only for an allowed recovery', async (t) => {
  const route = { provider: 'deepseek', model: 'deepseek-flash' }
  const cwd = await mkdtemp(join(tmpdir(), 'zlo-deepseek-wire-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const requests: Record<string, unknown>[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    assert.equal(String(input), 'https://api.deepseek.com/chat/completions')
    requests.push(JSON.parse(String(init?.body)))
    const finish = requests.length === 2 ? 'stop' : 'length'
    const common = { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: route.model }
    const delta = finish === 'stop' ? { content: 'Done' } : { reasoning_content: 'reasoning-only wire fixture' }
    const chunks = [
      { ...common, choices: [{ index: 0, delta, finish_reason: null }] },
      { ...common, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
      { ...common, choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
    ]
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } })
  })
  const execution = new PiExecution()
  await execution.setProviderKey('deepseek', fixtureKey)
  const config = { cwd, sessionDirectory: join(cwd, 'sessions'), route, tools: [], systemPrompt: 'Use concise output.',
    onEvent: () => {} }
  const session = await execution.open({ ...config, canRecoverModelOutput: () => true })
  try {
    assert.deepEqual(await session.run('Return a short answer.'), { status: 'completed', text: 'Done' })
    assert.deepEqual(requests.map(request => [request.max_tokens, request.thinking, request.reasoning_effort]), [
      [16_384, { type: 'enabled' }, 'low'],
      [16_384, { type: 'disabled' }, undefined],
    ])
    assert.ok(!JSON.stringify(requests[1]).includes('reasoning-only wire fixture'))
  } finally {
    await session.dispose()
  }
  const guarded = await execution.open({ ...config, canRecoverModelOutput: () => false })
  try {
    assert.deepEqual(await guarded.run('Return a short answer.'), { status: 'model_output_limit' })
    assert.equal(requests.length, 3)
  } finally {
    await guarded.dispose()
  }
})

test('the authenticated model catalog uses the fixed provider URL and does not follow redirects', async () => {
  const result = await fetchProviderCatalog('google', fixtureKey, AbortSignal.timeout(2_000), async (url, request) => {
    assert.equal(new URL(String(url)).origin, 'https://generativelanguage.googleapis.com')
    assert.equal(request?.redirect, 'error')
    assert.equal(new Headers(request?.headers).get('x-goog-api-key'), fixtureKey)
    assert.equal(new URL(String(url)).searchParams.get('key'), null)
    return Response.json({ models: [{ name: 'models/gemini-test' }, { name: ['unsafe'] }] })
  })
  assert.deepEqual(result, { connection: 'connected', ids: new Set(['gemini-test']) })
})

test('provider errors and excessive response bodies never cross the management boundary', async () => {
  const unauthorized = await fetchProviderCatalog('openai', fixtureKey, AbortSignal.timeout(2_000), async () =>
    Response.json({ error: `Provider echoed ${fixtureKey}` }, { status: 403 }))
  assert.deepEqual(unauthorized, { connection: 'unauthorized' })
  const oversized = await fetchProviderCatalog('openai', fixtureKey, AbortSignal.timeout(2_000), async () =>
    new Response('X'.repeat(3 * 1024 * 1024)))
  assert.deepEqual(oversized, { connection: 'unavailable' })
})

test('Pi provider key installation, bad update and revocation preserve the credential boundary', async () => {
  const route = { provider: 'deepseek', model: 'deepseek-flash' }
  let probeAuthorized = true
  const pi = new PiExecution(undefined, async (_url, request) => {
    assert.match(new Headers(request?.headers).get('authorization')!, /^Bearer fixture-/u)
    return probeAuthorized ? Response.json({ data: [{ id: route.model }, { id: fixtureKey }] })
      : Response.json({ error: fixtureKey }, { status: 401 })
  })
  const candidate = await pi.validateProviderKey('deepseek', fixtureKey)
  assert.equal(candidate.connection, 'connected')
  assert.deepEqual(candidate.models.map(model => model.route), [route])
  assert.ok(!JSON.stringify(candidate).includes(fixtureKey))
  await pi.setProviderKey('deepseek', fixtureKey)
  await pi.validateRoute(route)
  assert.deepEqual(await pi.discoverModels('deepseek').then(models => models.map(model => model.route)), [route])
  probeAuthorized = false
  assert.equal((await pi.validateProviderKey('deepseek', 'fixture-bad-key')).connection, 'unauthorized')
  await pi.validateRoute(route)
  assert.equal((await pi.testProviderAccount('deepseek')).connection, 'unauthorized')
  await assert.rejects(pi.validateRoute(route), /authorization or model/u)
  await pi.setProviderKey('deepseek', null)
  assert.deepEqual(await pi.discoverModels('deepseek'), [])
  assert.equal((await pi.listProviderAccounts()).find(account => account.id === 'deepseek')?.credential, 'missing')
})

test('the Pi SDK sends ChatGPT plan requests with bounded reservations and official Responses payloads', async () => {
  const profileId = randomUUID()
  const route = { provider: `chatgpt-${profileId}`, model: 'gpt-4.1-mini' }
  const captured: { url: string; init?: RequestInit }[] = []
  const pi = new PiExecution(undefined, async (input, init) => {
    captured.push({ url: String(input), init })
    const output = { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'OK', annotations: [] }] }
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { ...output, content: [] } },
      { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'OK' },
      { type: 'response.output_item.done', output_index: 0, item: output },
      { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [output],
        usage: { input_tokens: 12, output_tokens: 1, total_tokens: 13 } } },
    ]
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    })
  })
  const accessToken = 'fixture-chatgpt-session-token'
  const sessionData = { profileId, accessToken, expiresAt: Date.now() + 3600_000, models: [route.model] }
  assert.deepEqual((await pi.setChatGptSession(sessionData)).map(model => model.route), [route])
  await assert.rejects(pi.validateRoute({ ...route, provider: `chatgpt-${randomUUID()}` }), /unavailable/u)
  const directory = await mkdtemp(join(tmpdir(), 'zlo-chatgpt-plan-'))
  const budgets: number[] = []
  const estimatedCosts: (number | undefined)[] = []
  try {
    const session = await pi.open({ cwd: directory, sessionDirectory: directory, route,
      tools: [{ name: 'inspect_fixture', description: 'Inspect the fixture',
        parameters: { type: 'object', properties: {} }, execute: async () => ({ ok: true }) }],
      systemPrompt: 'Fixture system instructions', onEvent: event => {
        if (event.type === 'model.usage') estimatedCosts.push(event.estimatedCostUsd)
      }, reserveRequest: ({ maxOutputTokens }) => budgets.push(maxOutputTokens),
    })
    try {
      assert.deepEqual(await session.run('Reply with OK.'), { status: 'completed', text: 'OK' })
      assert.equal(captured.length, 1)
      const request = captured[0]!
      const headers = new Headers(request.init?.headers)
      assert.equal(request.url, 'https://api.openai.com/v1/responses')
      assert.equal(request.init?.redirect, 'error')
      assert.equal(headers.get('user-agent'), 'Zlo-Agent')
      assert.equal(headers.get('authorization'), `Bearer ${accessToken}`)
      const body = JSON.parse(String(request.init?.body))
      assert.equal(body.model, route.model)
      assert.equal(body.store, false)
      assert.equal(body.stream, true)
      assert.ok(body.input.some((item: { role: string }) => item.role === 'developer'))
      assert.ok(body.input.every((item: { role: string }) => item.role !== 'system'))
      assert.deepEqual(body.tools.map((tool: { type: string }) => tool.type), ['namespace'])
      assert.equal(body.tools[0].tools[0].name, 'inspect_fixture')
      for (const forbidden of ['max_output_tokens', 'previous_response_id', 'prompt_cache_key', 'prompt_cache_retention']) {
        assert.equal(Object.hasOwn(body, forbidden), false)
      }
      assert.ok(budgets[0]! > 4096)
      assert.deepEqual(estimatedCosts, [undefined])
      await pi.setChatGptSession({ ...sessionData, profileId: randomUUID() })
      assert.notEqual((await session.run('Stay with the original account.')).status, 'completed')
      assert.equal(captured.length, 1)
    } finally { await session.dispose() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
