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
  assert.deepEqual(workspace.tools('worker').map(({ effect }) => effect), ['read', 'read', 'read', 'read', 'read'])
})

test('write denial preserves existing files and concurrent writes are serialized', async (t) => {
  const { root, workspace } = await fixture(t)
  const create = tool(workspace, 'create_text_file')
  const edit = tool(workspace, 'edit_text_file')
  const path = 'same.txt'
  const results = await Promise.all([create({ path, content: 'x x' }), create({ path, content: 'second' })])
  assert.deepEqual(results, [{ ok: true }, { ok: false, error: 'Another workspace write is active' }])
  assert.deepEqual(await create({ path, content: 'second' }), { ok: false, error: 'Workspace entry already exists' })
  assert.deepEqual(await edit({ path, oldText: 'x', newText: 'changed' }), {
    ok: false, error: 'oldText matches more than once. Include enough context to identify one occurrence.',
    code: 'ambiguous_match', matchLines: [1, 1],
  })
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(await edit({ path, oldText: 'x x', newText: '' }, controller.signal), {
    ok: false, error: 'Tool interrupted before execution',
  })
  assert.equal(await readFile(join(root, path), 'utf8'), 'x x')
})

test('edit recovery points to a unique line range and a scoped read preserves exact whitespace', async (t) => {
  const { root, workspace } = await fixture(t)
  const path = 'bike.html'
  const exact = '      <!-- far arm -->\r\n      <path/>\r\n'
  const original = '<svg>\r\n' + exact + '</svg>\r\n'
  await writeFile(join(root, path), original)
  const edit = tool(workspace, 'edit_text_file')
  const read = tool(workspace, 'read_text_file', 'worker')
  assert.deepEqual(await edit({ path, oldText: '        <!-- far arm -->\n      <path/>', newText: '<g/>' }), {
    ok: false, error: 'oldText not found. Read the current file and retry with exact text.',
    code: 'text_not_found', readRange: { startLine: 2, lineCount: 2 },
  })
  assert.equal(await readFile(join(root, path), 'utf8'), original)
  assert.deepEqual(await read({ path, startLine: 2, lineCount: 2 }), {
    ok: true, text: exact, startLine: 2, endLine: 3, totalLines: 4,
  })
  assert.deepEqual(await read({ path, startLine: 5 }), { ok: false, error: 'Start line is past the end of the file', totalLines: 4 })
  assert.deepEqual(await read({ path, lineCount: 201 }), { ok: false, error: 'Invalid line range' })
  await writeFile(join(root, path), original + exact)
  assert.deepEqual(await edit({ path, oldText: '        <!-- far arm -->', newText: '<g/>' }), {
    ok: false, error: 'oldText not found. Read the current file and retry with exact text.', code: 'text_not_found',
  })
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

test('P0-1: allows auth source modules and safe engineering dotfiles while still blocking real secrets and hidden metadata', async (t) => {
  const { root, workspace } = await fixture(t)
  const mkdirTool = tool(workspace, 'create_directory')
  const create = tool(workspace, 'create_text_file')
  const read = tool(workspace, 'read_text_file')
  const edit = tool(workspace, 'edit_text_file')
  const list = tool(workspace, 'list_directory')

  for (const dir of ['src', 'src/auth', '.github', '.github/workflows']) {
    assert.deepEqual(await mkdirTool({ path: dir }), { ok: true }, dir)
  }

  const allowedFiles: [string, string][] = [
    ['src/auth/login.ts', 'export const login = () => true\n'],
    ['auth.test.ts', 'import "./src/auth/login.ts"\n'],
    ['.gitignore', 'node_modules/\n'],
    ['.github/workflows/desktop-ci.yml', 'name: Desktop CI\n'],
    ['.env.example', 'PUBLIC_PORT=3000\n'],
    ['.prettierrc.json', '{"semi":false}\n'],
  ]
  for (const [path, content] of allowedFiles) {
    assert.deepEqual(await create({ path, content }), { ok: true }, path)
    assert.deepEqual(await read({ path }), { ok: true, text: content }, path)
    assert.equal((await workspace.verify({ path })).passed, true, path)
  }
  assert.deepEqual(await edit({ path: 'src/auth/login.ts', oldText: 'true', newText: 'false' }), { ok: true, changed: true })

  // Seed real secrets & dangerous dot-metadata directly on disk and ensure list_directory hides them and tools reject them
  await mkdir(join(root, '.git'))
  await writeFile(join(root, '.git', 'config'), 'secret')
  await mkdir(join(root, '.husky'))
  await writeFile(join(root, '.husky', 'pre-commit'), 'evil')
  await mkdir(join(root, '.vscode'))
  await writeFile(join(root, '.vscode', 'tasks.json'), '{}')
  await writeFile(join(root, '.env'), 'OPENAI_API_KEY=real')
  await writeFile(join(root, '.env.local'), 'OPENAI_API_KEY=local')
  await writeFile(join(root, '.npmrc'), '//registry.npmjs.org/:_authToken=secret')
  await writeFile(join(root, 'auth.json'), '{"token":"secret"}')

  const rootList = await list({ path: '.' }) as { ok: boolean; entries: { name: string; kind: string }[] }
  assert.equal(rootList.ok, true)
  const names = rootList.entries.map(entry => entry.name).sort()
  assert.deepEqual(names, ['.env.example', '.github', '.gitignore', '.prettierrc.json', 'auth.test.ts', 'src'])

  for (const blocked of [
    '.env', '.env.local', '.env.production', '.npmrc', 'auth.json', 'credentials.json', 'secrets.yaml',
    'id_ed25519', '.git/config', '.husky/pre-commit', '.vscode/tasks.json', '.gitignore/nested.txt',
  ]) {
    assert.deepEqual(await read({ path: blocked }), { ok: false, error: 'Path denied by workspace policy' }, blocked)
    assert.deepEqual(await create({ path: blocked, content: 'x' }), { ok: false, error: 'Path denied by workspace policy' }, blocked)
  }
  assert.deepEqual(await mkdirTool({ path: '.husky/hooks' }), { ok: false, error: 'Path denied by workspace policy' })

  // Codex-aligned protected read-only agent directories (.pi, .agents, .claude, .codex):
  // readable & searchable when present, while all writes & secrets inside them stay blocked.
  for (const dir of ['.pi', '.agents', '.claude', '.codex']) {
    await mkdir(join(root, dir))
    await writeFile(join(root, dir, 'guide.md'), `# ${dir} guide\n`)
    await writeFile(join(root, dir, '.env'), 'SECRET=1')
    assert.deepEqual(await read({ path: `${dir}/guide.md` }), { ok: true, text: `# ${dir} guide\n` })
    const dirList = await list({ path: dir }) as { ok: boolean; entries: { name: string }[] }
    assert.equal(dirList.ok, true)
    assert.deepEqual(dirList.entries.map(item => item.name), ['guide.md'])
    assert.deepEqual(await read({ path: `${dir}/.env` }), { ok: false, error: 'Path denied by workspace policy' })
    assert.deepEqual(await create({ path: `${dir}/new.md`, content: 'x' }), { ok: false, error: 'Path denied by workspace policy' })
    assert.deepEqual(await edit({ path: `${dir}/guide.md`, oldText: 'guide', newText: 'mutated' }), {
      ok: false, error: 'Path denied by workspace policy',
    })
    assert.deepEqual(await mkdirTool({ path: `${dir}/sub` }), { ok: false, error: 'Path denied by workspace policy' })
  }
})
