import assert from 'node:assert/strict'
import { once } from 'node:events'
import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { toolImages } from '../src/execution.ts'
import { createPreviewTools } from '../src/preview-tools.ts'
import { CodingWorkspace } from '../src/workspace.ts'

test('isolated preview executes JS, CSS and SVG on a virtual clock and denies network and unselected files', {
  skip: process.platform !== 'win32', timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zlo-preview-'))
  let requests = 0
  const trap = createServer((_, response) => { requests++; response.end('private fixture') }).listen(0, '127.0.0.1')
  try {
    await once(trap, 'listening')
    const address = trap.address()
    assert.ok(address && typeof address !== 'string')
    const workspace = join(directory, 'workspace')
    await mkdir(workspace)
    const remote = `http://127.0.0.1:${address.port}`
    const privatePath = join(directory, 'outside.js')
    await writeFile(privatePath, 'document.body.style.minWidth = "2000px"')
    await link(privatePath, join(workspace, 'alias.js'))
    await writeFile(join(workspace, 'not-selected.js'), 'document.body.style.minWidth = "2000px"')
    await writeFile(join(workspace, 'style.css'), 'body{margin:0;min-height:680px} .wheel{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(180deg)}}')
    await writeFile(join(workspace, 'anim.js'), 'setTimeout(() => { document.body.style.minWidth="950px" }, 200); setTimeout(() => { throw new RangeError("PRIVATE_MESSAGE") }, 350);')
    await writeFile(join(workspace, 'scene.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="green"/></svg>')
    await writeFile(join(workspace, 'index.html'), `<!doctype html><link rel="stylesheet" href="style.css"><body>
      <svg width="150" height="150"><rect class="wheel" width="30" height="30"/><circle cx="30" cy="30" r="10"><animate attributeName="cx" from="30" to="130" dur="1s" repeatCount="indefinite"/></circle></svg>
      <img src="scene.svg"><img src="${remote}/image"><img src="file:///C:/Windows/win.ini">
      <script src="not-selected.js"></script><script src="anim.js"></script><script>
      fetch('${remote}/fetch').catch(() => {});
      try { new WebSocket('ws://127.0.0.1:${address.port}/socket') } catch {}
      window.open('${remote}/popup');
      </script></body>`)
    const [tool] = createPreviewTools(new CodingWorkspace(workspace))
    const call = (input: unknown, signal?: AbortSignal) => tool.execute('preview', input, signal) as Promise<{
      ok: boolean; error?: string; samples: { timeMs: number; overflowX: number; overflowY: number; animations: number; svgAnimations: number }[];
      runtimeErrors: number; errorKinds: string[]; [toolImages]: { bytes: Buffer }[]
    }>
    assert.equal((await call({ path: '../outside.js' })).ok, false)
    assert.equal((await call({ path: 'index.html', assets: ['alias.js'] })).ok, false)
    assert.equal((await call({ path: 'index.html', timesMs: [0, 0] })).ok, false)
    assert.equal((await call({ path: 'index.html' }, AbortSignal.abort())).ok, false)
    const result = await call({ path: 'index.html', width: 640, height: 360, assets: ['style.css', 'anim.js', 'scene.svg'], timesMs: [0, 300, 700] })
    assert.equal(result.ok, true, result.error)
    assert.deepEqual(result.samples.map(sample => sample.timeMs), [0, 300, 700])
    assert.deepEqual(result.samples.map(sample => sample.overflowX), [0, 310, 310])
    assert.ok(result.samples.every(sample => sample.overflowY === 320 && sample.svgAnimations === 1 && sample.animations === 1))
    assert.equal(result.runtimeErrors, 1)
    assert.deepEqual(result.errorKinds, ['RangeError'])
    assert.ok(!JSON.stringify(result).includes('PRIVATE_MESSAGE'))
    assert.equal(result[toolImages].length, 3)
    assert.ok(result[toolImages].every(image => image.bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))))
    assert.ok(!result[toolImages][0].bytes.equals(result[toolImages][2].bytes))
    assert.equal(requests, 0)
  } finally {
    await new Promise<void>(resolve => trap.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
