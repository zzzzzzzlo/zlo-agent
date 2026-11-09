import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { CodingWorkspace } from '../src/workspace.ts'

async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'zlo-workspace-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'workspace')
  await mkdir(root)
  return { base, root, workspace: new CodingWorkspace(root) }
}

function tool(workspace: CodingWorkspace, name: string, role: 'root' | 'worker' = 'root') {
  const found = workspace.tools(role).find((item) => item.name === name)
  assert.ok(found)
  return (input: unknown, signal?: AbortSignal) => found.execute(name, input, signal)
}

test('bounded workspace files can be listed, read, created and edited with literal matching', async (t) => {
  const { root, workspace } = await fixture(t)
  await mkdir(join(root, 'src'))
  const create = tool(workspace, 'create_text_file')
  const edit = tool(workspace, 'edit_text_file')
  const read = tool(workspace, 'read_text_file', 'worker')
  const path = 'src/main.ts'
  const original = '\uFEFFexport const answer = "旧";\r\n'
  assert.deepEqual(await create({ path, content: original }), { ok: true })
  assert.deepEqual(await read({ path }), { ok: true, text: original })
  assert.deepEqual(await edit({ path, oldText: '"旧"', newText: '"$& 新"' }), { ok: true, changed: true })
  assert.equal(await readFile(join(root, 'src', 'main.ts'), 'utf8'), '\uFEFFexport const answer = "$& 新";\r\n')
  assert.deepEqual(await tool(workspace, 'list_directory')({ path: '.' }), {
    ok: true, entries: [{ name: 'src', kind: 'directory' }], truncated: false,
  })
  assert.equal(await workspace.verify({ path, contains: '"$& 新"' }).then((result) => result.passed), true)
  assert.equal(await workspace.verify({ path, contains: '旧' }).then((result) => result.passed), false)
  assert.equal(await workspace.verify({ path }).then((result) => result.passed), true)
  assert.equal(await workspace.verify({ path: 'src/missing.ts' }).then((result) => result.passed), false)
  assert.deepEqual(workspace.tools('worker').map(({ effect }) => effect), ['read', 'read'])
})

test('write denial preserves existing files and concurrent writes are serialized', async (t) => {
  const { root, workspace } = await fixture(t)
  const create = tool(workspace, 'create_text_file')
  const edit = tool(workspace, 'edit_text_file')
  const path = 'same.txt'
  const results = await Promise.all([create({ path, content: 'x x' }), create({ path, content: 'second' })])
  assert.deepEqual(results, [{ ok: true }, { ok: false, error: 'Another workspace write is active' }])
  assert.deepEqual(await create({ path, content: 'second' }), { ok: false, error: 'Workspace entry already exists' })
  assert.deepEqual(await edit({ path, oldText: 'x', newText: 'changed' }), { ok: false, error: 'oldText must match exactly once' })
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(await edit({ path, oldText: 'x x', newText: '' }, controller.signal), {
    ok: false, error: 'Tool interrupted before execution',
  })
  assert.equal(await readFile(join(root, path), 'utf8'), 'x x')
})

test('policy rejects traversal, Windows special paths, hidden metadata and credentials', async (t) => {
  const { root, workspace } = await fixture(t)
  await mkdir(join(root, '.git'))
  await writeFile(join(root, '.git', 'config'), 'private')
  await writeFile(join(root, '.env'), 'private')
  await writeFile(join(root, 'key.pem'), 'private')
  await writeFile(join(root, 'public.txt'), 'public')
  const read = tool(workspace, 'read_text_file')
  const create = tool(workspace, 'create_text_file')
  for (const path of [
    '../outside.txt', 'sub/../public.txt', '/outside.txt', 'C:\\outside.txt', 'C:outside.txt',
    '\\\\server\\share', 'public.txt:stream', 'public.txt.', 'NUL.txt', 'COM¹.txt',
    'CONIN$', '.git/config', '.env', 'key.pem', 'credentials.json',
  ]) {
    assert.deepEqual(await read({ path }), { ok: false, error: 'Path denied by workspace policy' }, path)
    assert.deepEqual(await create({ path, content: 'write' }), { ok: false, error: 'Path denied by workspace policy' }, path)
  }
  if (process.platform === 'win32') {
    assert.throws(() => new CodingWorkspace('\\\\server\\share'), /local drive workspace directory/u)
  }
  assert.deepEqual(await tool(workspace, 'list_directory')({ path: '.' }), {
    ok: true, entries: [{ name: 'public.txt', kind: 'file' }], truncated: false,
  })
  assert.equal(await workspace.verify({ path: '.git/config' }).then((result) => result.passed), false)
})

test('directory links and hard-linked files cannot expose files outside the workspace', async (t) => {
  const { base, root, workspace } = await fixture(t)
  const outside = join(base, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'data.txt'), 'outside secret')
  await symlink(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  await link(join(outside, 'data.txt'), join(root, 'hardlink.txt'))
  const read = tool(workspace, 'read_text_file')
  const edit = tool(workspace, 'edit_text_file')
  for (const path of ['link/data.txt', 'hardlink.txt']) {
    assert.deepEqual(await read({ path }), { ok: false, error: 'Workspace entry type or alias denied' })
    assert.deepEqual(await edit({ path, oldText: 'outside secret', newText: 'changed' }), {
      ok: false, error: 'Workspace entry type or alias denied',
    })
  }
  assert.deepEqual(await tool(workspace, 'create_text_file')({ path: 'link/new.txt', content: 'no' }), {
    ok: false, error: 'Workspace entry type or alias denied',
  })
  assert.throws(() => new CodingWorkspace(join(root, 'link')), /real workspace directory/u)
  assert.equal(await readFile(join(outside, 'data.txt'), 'utf8'), 'outside secret')
})

test('binary, malformed and oversized text cannot pass tools or verification', async (t) => {
  const { root, workspace } = await fixture(t)
  await writeFile(join(root, 'binary.txt'), Buffer.from([0, 1, 2]))
  await writeFile(join(root, 'invalid.txt'), Buffer.from([0xc0, 0xaf]))
  await writeFile(join(root, 'large.txt'), 'x'.repeat(128 * 1024 + 1))
  const read = tool(workspace, 'read_text_file')
  for (const path of ['binary.txt', 'invalid.txt', 'large.txt']) {
    assert.equal((await read({ path }) as { ok: boolean }).ok, false)
    assert.deepEqual(await workspace.verify({ path }), { passed: false, evidence: 'workspace_file_unavailable' })
  }
  assert.deepEqual(await tool(workspace, 'create_text_file')({ path: 'new.txt', content: '中'.repeat(50000) }), {
    ok: false, error: 'Expected bounded UTF-8 text',
  })
})
