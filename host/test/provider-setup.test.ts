import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseCustomProvider } from '../../shared/contracts/provider-setup.ts'
import { PiExecution } from '../src/pi.ts'
import { GrokLogin } from '../src/provider-setup.ts'

const config = { id: 'local-models', name: 'Local Models', baseUrl: 'http://127.0.0.1:11434/v1', models: ['example-model'] }
const route = { provider: 'custom-local-models', model: 'example-model' }
const key = 'example-api-key-for-test-only'

test('custom provider URL and model validation preserves the explicit endpoint', () => {
  assert.deepEqual(parseCustomProvider({ ...config, baseUrl: config.baseUrl + '/' }), config)
  for (const baseUrl of ['http://example.com/v1', 'https://user:pass@example.com/v1', 'https://example.com/v1?key=x', 'file:///v1']) {
    assert.equal(parseCustomProvider({ ...config, baseUrl }), undefined)
  }
  assert.equal(parseCustomProvider({ ...config, models: ['bad id'] }), undefined)
})

test('registered custom provider performs Pi requests, binds credentials to its endpoint and can be removed', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'zlo-custom-provider-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const observed: { url: string; authorization: string | null; redirect?: RequestRedirect }[] = []
  const request: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString()
    observed.push({ url, authorization: new Headers(init?.headers).get('authorization'), redirect: init?.redirect })
    if (url.endsWith('/models')) return Response.json({ data: [{ id: route.model }, { id: 'second-model' }, { id: 'bad id' }] })
    assert.equal(url, config.baseUrl + '/chat/completions')
    assert.equal(JSON.parse(String(init?.body)).model, route.model)
    const chunk = { id: 'local-1', object: 'chat.completion.chunk', created: 1, model: route.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Local provider succeeded.' }, finish_reason: 'stop' }] }
    return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    })
  }
  const execution = new PiExecution(undefined, request)
  await execution.applyCustomProvider(config.id, { ...config, models: [], key: null })
  assert.equal((await execution.discoverModels(route.provider)).length, 0)
  await execution.applyCustomProvider(config.id, { ...config, key })
  await execution.validateRoute(route)
  assert.equal((await execution.discoverModels(route.provider))[0]?.route.model, route.model)
  assert.deepEqual(await execution.testCustomProvider(config.id), { state: 'connected', models: [route.model, 'second-model'] })
  assert.ok(!JSON.stringify(await execution.listProviderAccounts()).includes(key))
  const open = () => execution.open({ cwd, sessionDirectory: join(cwd, 'sessions'), route,
    systemPrompt: 'Complete the task.', tools: [], onEvent() {} })
  const session = await open()
  try { assert.equal((await session.run('Say hello.')).status, 'completed') } finally { await session.dispose() }
  assert.deepEqual(observed, [config.baseUrl + '/models', config.baseUrl + '/chat/completions'].map(url =>
    ({ url, authorization: 'Bearer ' + key, redirect: 'error' })))
  await execution.applyCustomProvider(config.id, { ...config, key: null })
  const local = await open()
  try { assert.equal((await local.run('Say hello without an API key.')).status, 'completed') } finally { await local.dispose() }
  assert.equal(observed.at(-1)?.authorization, null)
  await execution.applyCustomProvider(config.id, null)
  await assert.rejects(execution.validateRoute(route))
})

test('Grok OAuth reports device instructions, accepts refresh, and discards a cancelled attempt', async () => {
  const credential = { type: 'oauth' as const, access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 60_000 }
  let signal: AbortSignal | undefined
  let complete: ((value: typeof credential) => void) | undefined
  const flow = new GrokLogin({
    name: 'Grok fixture', isSubscription: true,
    login: interaction => {
      signal = interaction.signal
      interaction.notify({ type: 'device_code', verificationUri: 'https://auth.x.ai/device', userCode: 'ABCD-1234',
        intervalSeconds: 1, expiresInSeconds: 60 })
      return new Promise(resolve => { complete = resolve })
    },
    refresh: async input => ({ ...input, access: 'fixture-refreshed' }),
    toAuth: async input => ({ apiKey: input.access }),
  })
  flow.start()
  assert.deepEqual(flow.poll(), { state: 'pending', verification: { url: 'https://auth.x.ai/device', code: 'ABCD-1234' } })
  flow.cancel()
  assert.equal(signal?.aborted, true)
  complete?.(credential)
  await Promise.resolve()
  assert.deepEqual(flow.poll(), { state: 'failed' })
  flow.start()
  complete?.(credential)
  await Promise.resolve()
  assert.deepEqual(flow.poll(), { state: 'complete', credential })
  assert.equal((await flow.refresh(credential)).access, 'fixture-refreshed')
})

test('Grok account enables the Pi Responses route with separate cost reporting and removes it on sign-out', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'zlo-grok-provider-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const credential = { type: 'oauth' as const, access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 60_000 }
  const route = { provider: 'xai', model: 'grok-4.3' }
  const observed: { url: string; authorization: string | null; redirect?: RequestRedirect }[] = []
  const execution = new PiExecution(undefined, async (input, init) => {
    observed.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization'), redirect: init?.redirect })
    const item = { type: 'message', id: 'msg_grok', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Grok fixture.', annotations: [] }] }
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Grok fixture.' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'resp_grok', status: 'completed', output: [item],
        usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } },
    ]
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    })
  })
  await assert.rejects(execution.validateRoute(route))
  assert.ok((await execution.setGrokSession(credential)).some(({ route: model }) => model.model === route.model))
  assert.equal((await execution.discoverModels('xai')).find(model => model.route.model === route.model)?.estimatedCost, undefined)
  const usage: (number | undefined)[] = []
  const session = await execution.open({ cwd, sessionDirectory: join(cwd, 'sessions'), route, systemPrompt: 'Complete the task.',
    tools: [], onEvent(event) { if (event.type === 'model.usage') usage.push(event.estimatedCostUsd) } })
  try { assert.deepEqual(await session.run('Say hello.'), { status: 'completed', text: 'Grok fixture.' }) }
  finally { await session.dispose() }
  assert.deepEqual(observed, [{ url: 'https://api.x.ai/v1/responses', authorization: 'Bearer fixture-access', redirect: 'error' }])
  assert.deepEqual(usage, [undefined])
  await execution.setGrokSession(null)
  await assert.rejects(execution.validateRoute(route))
})
