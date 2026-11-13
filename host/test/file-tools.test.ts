import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { createFileTools } from '../src/file-tools.ts'
import { CodingWorkspace } from '../src/workspace.ts'

async function fixture(context: TestContext) {
  const parent = await mkdtemp(join(tmpdir(), 'zlo-file-plugin-'))
  context.after(() => rm(parent, { recursive: true, force: true }))
  const root = join(parent, 'repo')
  await mkdir(root)
  const workspace = new CodingWorkspace(root)
  const tools = createFileTools(workspace)
  return {
    root, parent, workspace, tools,
    run: (name: string, args: unknown, signal?: AbortSignal) => tools.find(tool => tool.name === name)!.execute(name, args, signal),
  }
}

test('file and regex searches are rooted, redact matches and skip private names and junctions', async context => {
  const { root, parent, run } = await fixture(context)
  const src = join(root, 'src')
  const outside = join(parent, 'outside')
  await mkdir(src)
  await mkdir(outside)
  await writeFile(join(src, 'worker.ts'), 'const data = 1\r\nAuthorization: Bearer privatevalue\r\n')
  await writeFile(join(root, '.env'), 'Authorization: Bearer hidden')
  await writeFile(join(outside, 'secret-note.ts'), 'outside workspace')
  await symlink(outside, join(root, 'linked'), 'junction')
  assert.deepEqual(await run('search_files', { glob: '**/*.ts' }), { ok: true, paths: ['src/worker.ts'], truncated: false })
  assert.deepEqual(await run('search_files', { path: 'src', glob: 'worker.ts' }), { ok: true, paths: ['src/worker.ts'], truncated: false })
  assert.deepEqual(await run('search_files', { glob: '../*.ts' }), { ok: false, error: 'Invalid search path or glob' })
  assert.deepEqual(await run('search_content', { query: 'authorization:\\s+Bearer', regex: true }), {
    ok: true, truncated: false, matches: [{ path: 'src/worker.ts', line: 2, column: 1, text: 'Authorization: Bearer [redacted]' }],
  })
  assert.deepEqual(await run('search_content', { query: '(', regex: true }), { ok: false, error: 'Invalid regular expression' })
})

test('a pathological regular expression is cancelled without blocking the Host event loop', { timeout: 7_000 }, async context => {
  const { root, run } = await fixture(context)
  await writeFile(join(root, 'large.txt'), 'a'.repeat(30_000) + '!')
  let callback = false
  setTimeout(() => { callback = true }, 20)
  const result = await run('search_content', { query: '(a+)+$', regex: true })
  assert.deepEqual(result, { ok: false, error: 'Content search timed out or was interrupted' })
  assert.equal(callback, true)
})

test('exact multi-file patches preflight every file and preserve a concurrent edit after a partial result', async context => {
  const { root, run } = await fixture(context)
  const one = join(root, 'one.txt')
  const two = join(root, 'two.txt')
  await writeFile(one, 'old one')
  await writeFile(two, 'old two')
  const invalid = { edits: [
    { path: 'one.txt', oldText: 'old', newText: 'new' },
    { path: 'two.txt', oldText: 'absent', newText: 'new' },
  ] }
  assert.deepEqual(await run('apply_patch', invalid), {
    ok: false, error: 'Patch edit 2: oldText not found. Read the current file and retry with exact text.',
  })
  assert.equal(await readFile(one, 'utf8'), 'old one')
  const valid = { edits: invalid.edits.map(edit => ({ ...edit, oldText: 'old' })) }
  assert.deepEqual(await run('apply_patch', valid), { ok: true, changed: ['one.txt', 'two.txt'] })
  assert.equal(await readFile(one, 'utf8'), 'new one')
  assert.equal(await readFile(two, 'utf8'), 'new two')
  await writeFile(one, 'old one')
  await writeFile(two, 'old two')

  let reads = 0
  class RacingWorkspace extends CodingWorkspace {
    override async readTextSnapshot(path: unknown, signal?: AbortSignal) {
      if (path === 'two.txt' && ++reads === 2) await writeFile(two, 'user edit')
      return super.readTextSnapshot(path, signal)
    }
  }
  const patch = createFileTools(new RacingWorkspace(root)).find(tool => tool.name === 'apply_patch')!
  await assert.rejects(patch.execute('race', valid), /partially applied/u)
  assert.equal(await readFile(one, 'utf8'), 'new one')
  assert.equal(await readFile(two, 'utf8'), 'user edit')
})

test('one patch applies four disjoint edits in the same HTML file against the original snapshot', async context => {
  const { root, run, tools } = await fixture(context)
  const path = 'bike.html'
  const file = join(root, path)
  const original = '<svg>\r\n  <!-- far arm -->\r\n  <path id="near-arm"/>\r\n  <g id="mouth"/>\r\n  <g id="head"/>\r\n</svg>\r\n'
  await writeFile(file, original)
  const edits = [
    { path, oldText: 'id="head"', newText: 'id="head" transform="translate(0 -28)"' },
    { path, oldText: '  <!-- far arm -->\r\n', newText: '  <path id="far-arm"/>\r\n' },
    { path, oldText: '<path id="near-arm"/>', newText: '<path id="near-arm" stroke="green"/>' },
    { path, oldText: '<g id="mouth"/>', newText: '<g id="mouth" fill="red"/>' },
  ]
  const invalid = edits.map((edit, index) => index === 1 ? { ...edit, oldText: '    <!-- far arm -->\r\n' } : edit)
  assert.deepEqual(await run('apply_patch', { edits: invalid }), {
    ok: false, error: 'Patch edit 2: oldText not found. Read the current file and retry with exact text.',
  })
  assert.equal(await readFile(file, 'utf8'), original)
  assert.deepEqual(tools.find(tool => tool.name === 'apply_patch')?.policy?.targets?.({ edits }), [path])
  assert.deepEqual(await run('apply_patch', { edits }), { ok: true, changed: [path] })
  assert.equal(await readFile(file, 'utf8'), '<svg>\r\n  <path id="far-arm"/>\r\n  <path id="near-arm" stroke="green"/>\r\n' +
    '  <g id="mouth" fill="red"/>\r\n  <g id="head" transform="translate(0 -28)"/>\r\n</svg>\r\n')
})

test('a patch rejects overlapping or ambiguous matches without writing earlier edits', async context => {
  const { root, run } = await fixture(context)
  const path = 'segments.txt'
  const original = 'first:abc\nsecond:abc\nlast:done'
  const file = join(root, path)
  await writeFile(file, original)
  const earlier = { path, oldText: 'last:done', newText: 'last:changed' }
  assert.deepEqual(await run('apply_patch', { edits: [earlier, { path, oldText: 'abc', newText: 'changed' }] }), {
    ok: false, error: 'Patch edit 2: oldText matches more than once. Include enough context to identify one occurrence.',
  })
  assert.equal(await readFile(file, 'utf8'), original)
  assert.deepEqual(await run('apply_patch', { edits: [earlier,
    { path, oldText: 'first:abc', newText: 'first:changed' },
    { path, oldText: ':abc\nsecond', newText: ':changed\nsecond' },
  ] }), { ok: false, error: 'Patch edits 2 and 3 overlap. Merge them into one edit.' })
  assert.equal(await readFile(file, 'utf8'), original)
  assert.deepEqual(await run('apply_patch', { edits: [earlier, { path, oldText: 'last:changed', newText: 'last:again' }] }), {
    ok: false, error: 'Patch edit 2: oldText not found. Read the current file and retry with exact text.',
  })
  assert.equal(await readFile(file, 'utf8'), original)
})

test('move, rename and delete affect only checked regular files and never overwrite', async context => {
  const { root, run, tools } = await fixture(context)
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'old.txt'), 'move me')
  await writeFile(join(root, 'src', 'existing.txt'), 'keep me')
  assert.deepEqual(await run('move_file', { path: 'old.txt', destination: 'src/existing.txt' }), {
    ok: false, error: 'Move source or destination unavailable',
  })
  assert.equal(await readFile(join(root, 'old.txt'), 'utf8'), 'move me')
  assert.equal(await readFile(join(root, 'src', 'existing.txt'), 'utf8'), 'keep me')
  assert.deepEqual(await run('move_file', { path: 'old.txt', destination: 'src/new.txt' }), { ok: true, path: 'src/new.txt' })
  await assert.rejects(readFile(join(root, 'old.txt')), { code: 'ENOENT' })
  assert.deepEqual(await run('rename_file', { path: 'src/new.txt', newName: 'renamed.txt' }), { ok: true, path: 'src/renamed.txt' })
  assert.deepEqual(tools.find(tool => tool.name === 'rename_file')?.policy?.targets?.({ path: 'src\\new.txt', newName: 'renamed.txt' }), ['src/new.txt', 'src/renamed.txt'])
  assert.equal(tools.find(tool => tool.name === 'delete_file')?.policy?.approval, 'destructive')
  assert.deepEqual(await run('delete_file', { path: 'src' }), { ok: false, error: 'File unavailable or deletion interrupted' })
  assert.deepEqual(await run('delete_file', { path: 'src/renamed.txt' }), { ok: true })
  await assert.rejects(readFile(join(root, 'src', 'renamed.txt')), { code: 'ENOENT' })
})
