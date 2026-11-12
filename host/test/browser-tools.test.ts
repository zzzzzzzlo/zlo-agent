import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { createBrowserTools } from '../src/browser-tools.ts'
import { previewImageLimits, toolImages } from '../src/execution.ts'
import type { ToolImage } from '../src/execution.ts'
import { createImageTool } from '../src/image-tools.ts'
import type { WebClient } from '../src/web-tools.ts'
import { CodingWorkspace } from '../src/workspace.ts'
import type { ToolInvocationContext } from '../src/workspace.ts'

test('real Edge browser renders, interacts and captures without relaying unapproved navigation or credentials', {
  skip: process.platform !== 'win32',
}, async t => {
  const base = tmpdir()
  const directory = await mkdtemp(join(base, 'zlo-browser-'))
  const cleanups: (() => Promise<void>)[] = []
  let localHits = 0
  const trap = createServer((_request, response) => { localHits++; response.end('Private page') })
  t.after(async () => {
    try { await Promise.all(cleanups.map(cleanup => cleanup())) }
    finally {
      await new Promise<void>(resolve => trap.close(() => resolve()))
      if (dirname(directory) === base) await rm(directory, { recursive: true, force: true })
    }
  })
  await new Promise<void>((resolve, reject) => {
    trap.once('error', reject)
    trap.listen(0, '127.0.0.1', resolve)
  })
  const bound = trap.address()
  assert.ok(bound && typeof bound !== 'string')
  const local = 'http://127.0.0.1:' + bound.port + '/'
  const relay: string[] = []
  const client: WebClient = {
    async get(input, options) {
      const url = new URL(input)
      relay.push(url.href)
      assert.equal(url.origin, 'https://example.com')
      assert.equal(options?.allowedOrigin, 'https://example.com')
      const markup = url.pathname === '/next' ? '<title>Next</title><main>Arrived at the next page</main>' : [
        '<title>Controlled page</title><meta http-equiv="refresh" content="0;url=/unsafe-refresh">',
        '<main><h1>Browser exercise</h1><input id="note" name="note"><input id="pwd" type="password">',
        '<form method="post" action="/write"><button id="submit">Submit</button></form>',
        '<a id="next" href="/next">Next page</a><a id="outside" href="https://example.net/">Outside</a>',
        '<a id="local" href="' + local + '">Local</a>',
        '<script>fetch("' + local + 'script"); new WebSocket("ws://127.0.0.1:' + bound.port + '/ws");',
        'navigator.serviceWorker.register("/sw.js");</script>',
        '<img src="' + local + 'img"><iframe src="' + local + 'frame"></iframe></main>',
      ].join('')
      return { url, status: 200, contentType: 'text/html', body: Buffer.from(markup) }
    },
  }
  const tools = createBrowserTools(new CodingWorkspace(directory), { client })
  const context: ToolInvocationContext = {
    taskId: 'task-a', agentRunId: 'root-a',
    defer() { assert.fail('Browser must not register a process receipt') },
    onCleanup(cleanup) { cleanups.push(cleanup) },
  }
  const call = (name: string, input: unknown, selected = context) => {
    const tool = tools.find(candidate => candidate.name === name)!
    return tool.execute('browser-call', input, undefined, selected) as Promise<Record<string, unknown> & { [toolImages]?: ToolImage[] }>
  }
  const openPolicy = tools.find(tool => tool.name === 'browser_open')!.policy!
  assert.equal(openPolicy.approvalFor?.({ url: 'https://example.com/' }), 'network')
  assert.equal(openPolicy.approvalFor?.({ path: 'index.html' }), undefined)
  assert.equal(tools.find(tool => tool.name === 'browser_click')?.policy?.approval, 'browser_action')
  const launched = await call('browser_open', { url: 'https://example.com/' })
  assert.equal(launched.ok, true, JSON.stringify(launched))
  const { browserId } = launched
  const snapshot = await call('browser_snapshot', { browserId })
  assert.equal(snapshot.untrusted, true)
  assert.equal(snapshot.title, 'Controlled page')
  assert.match(String(snapshot.text), /Browser exercise/)
  assert.equal((await call('browser_snapshot', { browserId }, { ...context, agentRunId: 'other' })).ok, false)
  assert.equal((await call('browser_type', { browserId, selector: '#note', text: 'local text' })).ok, true)
  assert.equal((await call('browser_type', { browserId, selector: '#pwd', text: 'reject' })).ok, false)
  assert.equal((await call('browser_click', { browserId, selector: '#submit' })).ok, false)
  assert.equal((await call('browser_click', { browserId, selector: '#outside' })).ok, false)
  assert.equal((await call('browser_click', { browserId, selector: '#local' })).ok, false)
  assert.equal((await call('browser_wait', { browserId, selector: '#next', timeoutMs: 1200 })).ok, true)
  assert.equal((await call('browser_scroll', { browserId, pixels: 10 })).ok, true)
  const screenshot = await call('browser_screenshot', { browserId, path: 'capture.png' })
  assert.equal(screenshot.ok, true, JSON.stringify(screenshot))
  assert.equal(screenshot[toolImages]?.length, 1)
  assert.ok(screenshot[toolImages]?.[0].bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])))
  assert.equal((await readFile(join(directory, 'capture.png'))).subarray(1, 4).toString(), 'PNG')
  assert.equal((await call('browser_screenshot', { browserId, path: 'capture.png' })).ok, false)
  assert.equal((await call('browser_click', { browserId, selector: '#next' })).ok, true)
  assert.match(String((await call('browser_snapshot', { browserId })).text), /Arrived at the next page/)
  assert.equal((await call('browser_close', { browserId })).ok, true)
  assert.equal((await call('browser_snapshot', { browserId })).ok, false)
  assert.equal(localHits, 0)
  assert.deepEqual(relay, ['https://example.com/', 'https://example.com/next'])

  const reopened = await call('browser_open', { url: 'https://example.com/' })
  assert.equal(reopened.ok, true)
  const abort = new AbortController()
  const wait = tools.find(tool => tool.name === 'browser_wait')!
  const waiting = wait.execute('wait', { browserId: reopened.browserId, selector: '#missing', timeoutMs: 5000 }, abort.signal, context)
  abort.abort()
  assert.equal((await waiting as { ok: boolean }).ok, false)
  assert.equal((await call('browser_snapshot', { browserId: reopened.browserId })).ok, false)

  await writeFile(join(directory, 'allowed.js'), 'document.querySelector("h1").textContent = "Workspace page rendered"')
  await writeFile(join(directory, 'unselected.js'), 'document.querySelector("h1").textContent = "Unexpected asset loaded"')
  await writeFile(join(directory, 'index.html'), `<!doctype html><title>Local check</title><h1>Loading</h1>
    <script src="allowed.js"></script><script src="unselected.js"></script><img src="${local}image">
    <a id="private" href="${local}">Disallowed link</a>`)
  const secondRun = { ...context, agentRunId: 'worker-run' }
  const localPage = await call('browser_open', { path: 'index.html', assets: ['allowed.js'], width: 480, height: 320 }, secondRun)
  assert.equal(localPage.ok, true, JSON.stringify(localPage))
  assert.equal(localPage.mode, 'workspace')
  assert.equal(localPage.path, 'index.html')
  const localHandle = { browserId: localPage.browserId }
  assert.equal((await call('browser_snapshot', localHandle)).ok, false)
  const localSnapshot = await call('browser_snapshot', localHandle, secondRun)
  assert.match(String(localSnapshot.text), /Workspace page rendered/)
  assert.ok(Number(localSnapshot.blockedRequests) >= 1)
  assert.equal((await call('browser_click', { ...localHandle, selector: '#private' }, secondRun)).ok, false)
  const localFrame = await call('browser_screenshot', localHandle, secondRun)
  assert.equal(localFrame.ok, true, JSON.stringify(localFrame))
  assert.equal(localFrame.path, undefined)
  assert.equal(localFrame[toolImages]?.[0].width, 480)
  assert.equal(localFrame[toolImages]?.[0].height, 320)
  assert.equal((await call('browser_close', localHandle, secondRun)).ok, true)
  assert.equal(localHits, 0)
  assert.deepEqual(relay, ['https://example.com/', 'https://example.com/next', 'https://example.com/'])

  const viewImage = createImageTool(new CodingWorkspace(directory))
  await writeFile(join(directory, 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="green"/></svg>')
  const inspected = await viewImage.execute('inspect', { path: 'diagram.svg' }) as Record<string, unknown> & { [toolImages]?: ToolImage[] }
  assert.equal(inspected.ok, true, JSON.stringify(inspected))
  assert.equal(inspected.originalWidth, 1920)
  assert.equal(inspected[toolImages]?.[0].width, previewImageLimits.width)
  assert.ok(inspected[toolImages]?.[0].bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])))
  assert.deepEqual(await viewImage.execute('inspect-outside', { path: '../diagram.svg' }),
    { ok: false, error: 'Expected a workspace PNG, JPEG, WebP, GIF or SVG path.' })
})
