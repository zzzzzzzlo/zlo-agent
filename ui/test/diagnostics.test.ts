import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { diagnostic, maxDiagnosticLineBytes, parseHostDiagnostic, validateDiagnostic } from '../../shared/diagnostics.ts'
import type { DiagnosticEntry } from '../../shared/diagnostics.ts'
import { collectHostDiagnostics, createDiagnosticLog } from '../electron/main/diagnostic-log.ts'

const secret = 'test-only-private-prompt-and-credential'

async function testDirectory(t: TestContext): Promise<string> {
  // Use an ignored workspace directory so Windows development sandboxes can exercise rename.
  const root = fileURLToPath(new URL('../out/', import.meta.url))
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, 'zlo-diagnostics-'))
  t.after(async () => {
    const name = relative(root, directory)
    assert.match(name, /^zlo-diagnostics-[a-zA-Z0-9]+$/)
    await rm(directory, { recursive: true, force: true })
  })
  return directory
}

test('diagnostic schema rejects private fields and invalid fixed metadata', () => {
  const entry = diagnostic('host.model_failed')
  assert.deepEqual(parseHostDiagnostic(JSON.stringify(entry)), entry)
  assert.match(entry.correlationId, /^[\da-f-]{36}$/)
  assert.equal(validateDiagnostic({ ...entry, credential: secret }), undefined)
  assert.equal(validateDiagnostic({ ...entry, summary: secret }), undefined)
  assert.equal(validateDiagnostic({ ...entry, correlationId: secret }), undefined)
  assert.equal(validateDiagnostic({ ...entry, code: 'constructor' }), undefined)
  assert.equal(validateDiagnostic({ ...entry, time: '2026-02-31T12:00:00.000Z' }), undefined)
  assert.equal(validateDiagnostic({ ...entry, level: 'warn' }), undefined)
  assert.equal(validateDiagnostic({ ...entry, category: 'tool' }), undefined)
  assert.equal(validateDiagnostic({ ...entry, module: 'desktop' }), undefined)
  assert.equal(parseHostDiagnostic(JSON.stringify(diagnostic('desktop.host_ready'))), undefined)
  assert.equal(parseHostDiagnostic(' '.repeat(maxDiagnosticLineBytes) + JSON.stringify(entry)), undefined)
  assert.notEqual(diagnostic('host.model_failed', secret).correlationId, secret)
})

test('diagnostic stderr decoder bounds frames and resumes after raw or forged lines', async () => {
  const stream = new PassThrough()
  const received: DiagnosticEntry[] = []
  let discarded = 0
  collectHostDiagnostics(stream, (item) => received.push(item), () => { discarded++ })
  const entry = diagnostic('host.tool_failed')
  const complete = JSON.stringify(entry)
  stream.write(secret + '\n')
  stream.write(JSON.stringify({ ...entry, summary: secret }) + '\r\n')
  stream.write(JSON.stringify({ ...entry, payload: { token: secret } }) + '\n')
  stream.write('x'.repeat(maxDiagnosticLineBytes + 20))
  stream.write(complete + '\n')
  stream.write(complete.slice(0, 8))
  stream.write(complete.slice(8) + '\r\n')
  stream.end(complete.slice(0, 9))
  await new Promise<void>((resolve) => stream.once('end', resolve))
  assert.equal(discarded, 1)
  assert.deepEqual(received, [entry])
})

test('local diagnostics keep the current file and two bounded archives', async (t) => {
  const directory = await testDirectory(t)
  const entries = Array.from({ length: 8 }, () => diagnostic('desktop.host_starting'))
  const limit = Buffer.byteLength(JSON.stringify(entries[0]) + '\n') + 10
  const log = createDiagnosticLog(directory, limit)
  for (const entry of entries) log.write(entry)
  log.write({ ...entries[0], summary: secret })
  await log.flush()

  const names = (await readdir(directory)).sort()
  assert.deepEqual(names, ['diagnostics.jsonl', 'diagnostics.jsonl.1', 'diagnostics.jsonl.2'])
  for (const [index, name] of names.entries()) {
    const text = await readFile(join(directory, name), 'utf8')
    assert.equal(Buffer.byteLength(text) <= limit, true)
    assert.doesNotMatch(text, /private-prompt/)
    assert.deepEqual(JSON.parse(text), entries.at(-1 - index))
  }
})

test('diagnostic file errors do not escape or overwrite other files', async (t) => {
  const directory = await testDirectory(t)
  const blocked = join(directory, 'file')
  await writeFile(blocked, 'existing')
  const log = createDiagnosticLog(blocked)
  assert.doesNotThrow(() => log.write(diagnostic('desktop.host_ready')))
  await log.flush()
  assert.equal(await readFile(blocked, 'utf8'), 'existing')
})
