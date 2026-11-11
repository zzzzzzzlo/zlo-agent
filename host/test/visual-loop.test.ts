import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { closeDenyProxy, launchIsolatedBrowser } from '../src/browser-runtime.ts'
import { previewImageLimits, toolImages } from '../src/execution.ts'
import { LocalAgentHost } from '../src/host.ts'
import { PiExecution } from '../src/pi.ts'
import { telemetryEvent } from '../src/telemetry-projection.ts'
import type { AgentEvent } from '../src/contracts/domain.ts'
import { VisualWorkflow, visualMode } from '../src/visual-workflow.ts'

const route = { provider: 'deepseek', model: 'deepseek-flash' }
const obstruction = 'id="foreground" fill="#ee2222"'
const correction = 'id="foreground" fill="#ee2222" visibility="hidden"'

function draft(animal: '鹈鹕' | '鳄鱼') {
  const body = animal === '鹈鹕' ? '<path d="M190 150Q170 109 245 98Q283 72 279 48Q281 27 307 35L356 47L305 63Q300 143 255 161Z" fill="#f2efe0"/>'
    : '<path d="M175 151L130 126Q165 136 193 115Q220 88 287 94L335 80L367 105L323 122Q283 154 245 162Z" fill="#4d9254"/>'
  return `<!doctype html><meta charset="utf-8"><title>${animal}骑自行车</title><style>body{margin:0;background:#e7f4f4}</style>
<svg width="640" height="360" viewBox="0 0 640 360"><path d="M0 280H640" stroke="#a3c8bd" stroke-width="4"/>
<circle cx="226" cy="236" r="44" fill="none" stroke="#172a35" stroke-width="8"/>
<circle cx="426" cy="236" r="44" fill="none" stroke="#172a35" stroke-width="8"/>
<path d="M226 236l52-85 40 85-92 0m92 0l68-91-108 6m108-6 40 91m-40-91-10-25h22" fill="none" stroke="#23707c" stroke-width="7"/>
${body}<polyline id="leg" points="252,144 276,193 318,236" fill="none" stroke="#dfab50" stroke-width="8"/>
<circle id="pedal" cx="318" cy="236" r="6" fill="#1c3841"/><circle id="marker" cx="100" cy="70" r="15" fill="#ffbb00"/>
<rect ${obstruction} x="390" y="190" width="115" height="95"/></svg>
<script>const pedal=document.getElementById('pedal'),leg=document.getElementById('leg'),marker=document.getElementById('marker');
let start;function spin(now){start??=now;const ms=now-start,a=ms*Math.PI/450,x=318+17*Math.cos(a),y=236+17*Math.sin(a);
pedal.setAttribute('cx',x);pedal.setAttribute('cy',y);leg.setAttribute('points','252,144 '+(277+10*Math.cos(a))+',194 '+x+','+y);
marker.setAttribute('fill',ms>400?'#008888':'#ffbb00');requestAnimationFrame(spin);}requestAnimationFrame(spin);</script>`
}

function modelReply(step: number, action?: { name: string; args: object }): Response {
  const common = { id: `chatcmpl-visual-${step}`, object: 'chat.completion.chunk', created: 1, model: route.model }
  const delta = action ? { tool_calls: [{ index: 0, id: `call_${step}`, type: 'function', function: {
    name: action.name, arguments: JSON.stringify(action.args),
  } }] } : { content: '已确认前轮可见，动画可继续循环。' }
  const frames = [
    { ...common, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...common, choices: [{ index: 0, delta: {}, finish_reason: action ? 'tool_calls' : 'stop' }] },
    { ...common, choices: [], usage: { prompt_tokens: 200, completion_tokens: 32, total_tokens: 232 } },
  ]
  return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } })
}

test('pelican and crocodile feedback moves real browser pixels through the DeepSeek wire and corrects an occluded wheel', {
  skip: process.platform !== 'win32', timeout: 40_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'zlo-visual-loop-'))
  const decoder = await launchIsolatedBrowser(5_500)
  try {
    const page = await decoder.browser.newPage({ offline: true })
    for (const animal of ['鹈鹕', '鳄鱼'] as const) await t.test(animal, async sub => {
      const directory = join(root, animal), workspace = join(directory, 'workspace')
      await mkdir(workspace, { recursive: true })
      const execution = new PiExecution()
      await execution.setProviderKey('deepseek', 'fixture-credential-not-sent-to-network')
      const host = new LocalAgentHost({ directory: join(directory, 'state'), execution })
      let step = 0
      const failures: unknown[] = []
      const preview = { path: 'index.html', width: 640, height: 360, timesMs: [0, 300, 800] }
      sub.mock.method(globalThis, 'fetch', async (url: string | URL, options?: RequestInit) => {
        try {
          assert.equal(String(url), 'https://api.deepseek.com/chat/completions')
          const body = JSON.parse(String(options?.body))
          assert.equal(body.model, route.model)
          const images: string[] = body.messages.flatMap((message: { role: string; content?: unknown }) =>
            message.role === 'user' && Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url').map(part => part.image_url.url) : [])
          step++
          if (step !== 3 && step !== 5) assert.deepEqual(images, [], 'old screenshots must never be resent')
          if (step === 1) return modelReply(step, { name: 'create_text_file', args: { path: 'index.html', content: draft(animal) } })
          if (step === 2 || step === 4) return modelReply(step, { name: 'preview_page', args: preview })
          assert.ok(step === 3 || step === 5)
          assert.equal(images.length, 3)
          assert.ok(images.every(image => image.startsWith('data:image/jpeg;base64,')))
          const pixels = []
          for (const src of images) pixels.push(await page.evaluate(async url => {
            const image = new Image()
            image.src = url
            await image.decode()
            const canvas = document.createElement('canvas')
            canvas.width = image.width
            canvas.height = image.height
            const ctx = canvas.getContext('2d')!
            ctx.drawImage(image, 0, 0)
            return { wheel: [...ctx.getImageData(470, 236, 1, 1).data], marker: [...ctx.getImageData(100, 70, 1, 1).data] }
          }, src))
          assert.ok(pixels[0].marker[0] > 210 && pixels[2].marker[0] < 30, 'actual animation changed the sampled pixels')
          if (step === 3) {
            assert.ok(pixels.every(pixel => pixel.wheel[0] > 190 && pixel.wheel[1] < 70), 'front wheel is visually occluded')
            return modelReply(step, { name: 'edit_text_file', args: { path: 'index.html', oldText: obstruction, newText: correction } })
          }
          assert.ok(pixels.every(pixel => pixel.wheel[0] < 55 && pixel.wheel[1] < 65), 'front wheel is visible after the correction')
          return modelReply(step)
        } catch (error) { failures.push(error); return Response.json({ error: 'Visual fixture failed' }, { status: 400 }) }
      })
      try {
        const { taskId } = await host.createTask({ requestId: 'visual-test', goal: `创建${animal}骑自行车的 HTML 动画`, cwd: workspace,
          workspaceAccess: 'write', route, check: { path: 'index.html' } })
        await host.idle()
        assert.deepEqual(failures, [])
        assert.equal(step, 5)
        assert.equal(host.getTask(taskId).status, 'succeeded')
        const events = host.events(taskId)
        assert.deepEqual(events.filter(event => event.type === 'visual.frames_sent').map(event => event.payload),
          [{ frames: 3, estimatedImageTokens: 3 * previewImageLimits.estimatedTokens }, { frames: 3, estimatedImageTokens: 3 * previewImageLimits.estimatedTokens }])
        const rounds = events.filter(event => event.type === 'visual.round_finished')
        assert.deepEqual(rounds.map(event => [event.payload.modified, event.payload.tokens, event.payload.usageComplete]), [[true, 464, true], [false, 232, true]])
        assert.equal(telemetryEvent(rounds[0]).payload.modified, true)
        assert.equal(events.filter(event => event.type === 'agent.started').length, 1)
        assert.match(await readFile(join(workspace, 'index.html'), 'utf8'), /visibility="hidden"/u)
        const transcript = await readFile(host.getHistory(taskId).session!.path, 'utf8')
        assert.doesNotMatch(transcript, /data:image|"type":"image"/u)
        assert.match(transcript, /attached_for_next_request/u)
      } finally { await host.close() }
    })
  } finally {
    await decoder.browser.close()
    await closeDenyProxy(decoder.proxy)
    await rm(root, { recursive: true, force: true })
  }
})

test('text-only Pi model receives an explicit downgrade without pixels', async t => {
  const root = await mkdtemp(join(tmpdir(), 'zlo-visual-text-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const provider = fauxProvider({ models: [{ id: 'text-only', input: ['text'] }] })
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('preview_page', {}), { stopReason: 'toolUse' }),
    (context) => {
      const result = context.messages.findLast(message => message.role === 'toolResult')
      assert.ok(result?.role === 'toolResult')
      assert.equal(result.content.length, 1)
      assert.match(JSON.stringify(result.content), /unavailable_on_selected_model/u)
      assert.match(JSON.stringify(result.content), /runtimeErrors/u)
      return fauxAssistantMessage('Only checked structural diagnostics.')
    },
  ])
  const execution = new PiExecution(async () => {
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false })
    runtime.registerNativeProvider(provider.provider)
    return runtime
  })
  let imagesSent = false
  const session = await execution.open({ cwd: root, sessionDirectory: join(root, 'sessions'), systemPrompt: 'Use the tool',
    route: { provider: provider.getModel().provider, model: 'text-only' }, onEvent: event => { imagesSent ||= event.type === 'visual.frames_sent' },
    tools: [{ name: 'preview_page', description: 'Fixture preview', parameters: { type: 'object', properties: {} },
      async execute() { return { ok: true, runtimeErrors: 0, [toolImages]: [{ width: 640, height: 360, bytes: Buffer.from([255, 216, 255, 1, 255, 217]) }] } } }] })
  try {
    assert.equal((await session.run('Preview the page.')).status, 'completed')
    assert.equal(imagesSent, false)
  } finally { await session.dispose() }
})

test('visual modes bound frames, previews and estimated feedback tokens', () => {
  assert.equal(visualMode('Repair the API schema.'), undefined)
  assert.equal(visualMode('创建 SVG 动画，不要预览'), undefined)
  const budget = new VisualWorkflow('HTML 动画，快速模式', [], () => {}, () => {})
  try {
    assert.equal(budget.mode, 'quick')
    assert.match(budget.beginPreview({ timesMs: [0, 200] })!, /one frame/u)
    assert.equal(budget.beginPreview({ timesMs: [200] }), undefined)
    assert.equal(budget.reserve({ route, estimatedInputTokens: 59_000, maxOutputTokens: 5000, kind: 'prompt' }), true)
    assert.equal(budget.reserve({ route, estimatedInputTokens: 1, maxOutputTokens: 1, kind: 'prompt' }), false)
    budget.observe({ type: 'model.usage', input: 100, output: 50, cacheRead: 100, cacheWrite: 0 })
    assert.equal(budget.reserve({ route, estimatedInputTokens: 60_000, maxOutputTokens: 2_000, kind: 'prompt' }), true)
    assert.equal(budget.beginPreview({}), undefined)
    budget.previewResult({ path: 'index.html' }, { ok: true, samples: [{ frame: 1 }] })
    assert.deepEqual(budget.feedback(), { quick: true, final: true, maxOutputTokens: 2048 })
    assert.equal(budget.acceptsEdit('edit_text_file', { path: 'index.html' }), false)
    assert.equal(budget.acceptsEdit('apply_patch', { edits: [{ path: 'style.css' }] }), false)
    assert.equal(budget.acceptsEdit('edit_text_file', { path: 'README.md' }), true)
    assert.match(budget.beginPreview({})!, /exhausted/u)
  } finally { budget.finish() }
  const event = (seq: number, type: string, payload: Record<string, unknown>, correlationId?: string): AgentEvent => ({
    schemaVersion: 1, id: 'event-' + seq, seq, occurredAt: new Date().toISOString(), taskId: 'task', taskNodeId: 'root', type, payload, correlationId,
  })
  const history = [event(1, 'visual.preview_started', {}), event(2, 'model.reserved', { estimatedTokens: 63_900 }, 'receipt')]
  const resumed = new VisualWorkflow('HTML 快速模式', history, () => {}, () => {})
  try {
    assert.equal(resumed.beginPreview({}), undefined)
    assert.equal(resumed.reserve({ route, estimatedInputTokens: 100, maxOutputTokens: 1, kind: 'prompt' }), false)
  } finally { resumed.finish() }
})
