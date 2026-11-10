import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { CodingWorkspace } from '../src/workspace.ts'
import type { WorkspaceAccess } from '../src/workspace.ts'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'zlo-workspace-process-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, workspace: new CodingWorkspace(root) }
}

function tool(workspace: CodingWorkspace, name: string, access: WorkspaceAccess = 'trusted') {
  const spec = workspace.tools('root', access).find((item) => item.name === name)
  assert.ok(spec)
  return (input: unknown, signal?: AbortSignal) => spec.execute(name, input, signal)
}

test('read, write and trusted grants govern each role and reject overlapping workspace writes', async (t) => {
  const { root, workspace } = await fixture(t)
  for (const role of ['root', 'team', 'worker'] as const) {
    const names = (access: WorkspaceAccess) => workspace.tools(role, access).map((item) => item.name)
    assert.deepEqual(names('read'), ['list_directory', 'read_text_file'])
    assert.ok(names('write').includes('create_directory'))
    assert.ok(!names('write').includes('run_project_command'))
    assert.ok(names('trusted').includes('run_project_command'))
    assert.ok(names('trusted').includes('git_status'))
  }
  await mkdir(join(root, 'existing'))
  const child = new CodingWorkspace(join(root, 'existing'))
  const first = tool(workspace, 'create_directory', 'write')({ path: 'new' })
  const overlapping = tool(child, 'create_directory', 'write')({ path: 'nested' })
  assert.deepEqual(await overlapping, { ok: false, error: 'Another workspace write is active' })
  assert.deepEqual(await first, { ok: true })
  assert.deepEqual(await tool(child, 'create_directory', 'write')({ path: 'nested' }), { ok: true })
  assert.deepEqual(await tool(workspace, 'create_directory', 'write')({ path: '../outside' }), {
    ok: false, error: 'Path denied by workspace policy',
  })
})

test('real Node scripts receive literal arguments and a bounded environment without inherited credentials', async (t) => {
  const { root, workspace } = await fixture(t)
  t.after(() => { delete process.env.ZLO_WORKSPACE_TEST_API_KEY })
  process.env.ZLO_WORKSPACE_TEST_API_KEY = 'synthetic-workspace-secret'
  await writeFile(join(root, 'script with spaces.cjs'), `
    console.log(JSON.stringify({
      args: process.argv.slice(2),
      inherited: Object.hasOwn(process.env, 'ZLO_WORKSPACE_TEST_API_KEY'),
    }));
    process.stderr.write('x'.repeat(20000));
  `)
  const args = ['space " quote', 'x & whoami | %PATH%', '尾\\', '--flag']
  const run = tool(workspace, 'run_project_command')
  const result = await run({ command: 'node_script', path: 'script with spaces.cjs', args }) as {
    ok: boolean; exitCode: number; stdout: string; stderr: string; truncated: boolean
  }
  assert.equal(result.ok, true)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(JSON.parse(result.stdout), { args, inherited: false })
  assert.equal(result.stderr.length, 16 * 1024)
  assert.equal(result.truncated, true)
  assert.deepEqual(await run({ command: 'powershell', path: '.' }), { ok: false, error: 'Invalid project command' })
  assert.deepEqual(await run({ command: 'node_script', path: '../outside.cjs' }), {
    ok: false, error: 'Path denied by workspace policy',
  })
  assert.deepEqual(await run({ command: 'npm_test', path: '.', args: ['--not-authorized'] }), {
    ok: false, error: 'Invalid project command',
  })
})

test('process results redact known secrets, standard auth headers and a secret cut off by the output cap', async (t) => {
  const { root, workspace } = await fixture(t)
  const original = process.env.ZLO_WORKSPACE_OUTPUT_SECRET
  t.after(() => {
    if (original === undefined) delete process.env.ZLO_WORKSPACE_OUTPUT_SECRET
    else process.env.ZLO_WORKSPACE_OUTPUT_SECRET = original
  })
  const value = 'synthetic-test-secret-value'
  process.env.ZLO_WORKSPACE_OUTPUT_SECRET = value
  await writeFile(join(root, 'output.cjs'), `
    const value = ${JSON.stringify(value)};
    const auth = JSON.stringify({ Authorization: 'Bearer synthetic-authorization-value' });
    process.stdout.write(value + '\\n' + auth + '\\n');
    process.stderr.write('x'.repeat(16 * 1024 - 12) + value);
  `)
  const run = tool(workspace, 'run_project_command')
  const result = await run({ command: 'node_script', path: 'output.cjs' }) as {
    ok: boolean; stdout: string; stderr: string; truncated: boolean
  }
  assert.equal(result.ok, true)
  assert.equal(result.stdout, '[redacted]\n{"Authorization":"Bearer [redacted]"}\n')
  assert.equal(result.stderr, 'x'.repeat(16 * 1024 - 12) + '[redacted]')
  assert.equal(result.truncated, true)
})

test('npm test and build use real package scripts and trusted exit-code acceptance', async (t) => {
  const { root, workspace } = await fixture(t)
  await writeFile(join(root, 'package.json'), JSON.stringify({
    scripts: { test: 'node test.cjs', build: 'node build.cjs' },
  }))
  await writeFile(join(root, 'test.cjs'), "console.log('real project test')")
  await writeFile(join(root, 'build.cjs'), 'process.exitCode = 3')
  const testCommand = { command: 'npm_test', path: '.' } as const
  assert.deepEqual(await workspace.verify({ command: testCommand }, undefined, 'write'), {
    passed: false, evidence: 'workspace_command_not_authorized',
  })
  assert.deepEqual(await workspace.verify({ command: testCommand }, undefined, 'trusted'), {
    passed: true, evidence: 'workspace_command_passed',
  })
  assert.deepEqual(await workspace.verify({ command: { command: 'npm_build', path: '.' } }, undefined, 'trusted'), {
    passed: false, evidence: 'workspace_command_failed',
  })
  const result = await tool(workspace, 'run_project_command')(testCommand) as { stdout: string }
  assert.match(result.stdout, /real project test/u)
})

test('cancelling an active process propagates an unknown effect and releases the write lease', async (t) => {
  const { root, workspace } = await fixture(t)
  await writeFile(join(root, 'active.cjs'), `
    const { spawn } = require('node:child_process');
    const { join } = require('node:path');
    spawn(process.execPath, [join(process.cwd(), 'descendant.cjs')], {
      stdio: 'ignore', windowsHide: true,
    });
    setInterval(() => {}, 1000);
  `)
  await writeFile(join(root, 'descendant.cjs'), `
    require('node:fs').writeFileSync('started.txt', 'started');
    setTimeout(() => require('node:fs').writeFileSync('late.txt', 'late'), 1500);
  `)
  const controller = new AbortController()
  t.after(() => controller.abort())
  const command = { command: 'node_script', path: 'active.cjs' } as const
  const running = workspace.verify({ command }, controller.signal, 'trusted')
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await readFile(join(root, 'started.txt'), 'utf8').catch(() => '') === 'started') break
    await delay(20)
  }
  try {
    assert.equal(await readFile(join(root, 'started.txt'), 'utf8'), 'started')
  } finally {
    controller.abort()
  }
  await assert.rejects(running, /without a confirmed result/u)
  await delay(1550)
  await assert.rejects(readFile(join(root, 'late.txt')), { code: 'ENOENT' })
  assert.deepEqual(await tool(workspace, 'create_directory', 'write')({ path: 'after' }), { ok: true })
})

test('Git status, staged diff and commit metadata inspect a real local repository', async (t) => {
  const { root, workspace } = await fixture(t)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore', windowsHide: true })
  git('init', '-q')
  await writeFile(join(root, 'source.txt'), 'first\n')
  git('add', '--', 'source.txt')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
  await writeFile(join(root, 'source.txt'), 'updated\n')
  await writeFile(join(root, '.env'), 'omitted')
  assert.deepEqual(await tool(workspace, 'git_status')({}), {
    ok: true, entries: [{ status: ' M', path: 'source.txt' }], truncated: false,
  })
  const diff = tool(workspace, 'git_diff')
  const unstaged = await diff({ path: 'source.txt' }) as { stdout: string }
  assert.match(unstaged.stdout, /^\+updated$/mu)
  git('add', '--', 'source.txt')
  const staged = await diff({ path: 'source.txt', staged: true }) as { stdout: string }
  assert.match(staged.stdout, /^\+updated$/mu)
  assert.deepEqual(await diff({ path: '.env' }), { ok: false, error: 'Path denied by workspace policy' })
  const history = await tool(workspace, 'git_log')({}) as { stdout: string }
  assert.match(history.stdout, /^[a-f\d]+\t\d{4}-\d{2}-\d{2}\s*$/u)
})

test('Git inspection ignores workspace executables and disables the repository fsmonitor hook', async (t) => {
  const { root, workspace } = await fixture(t)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore', windowsHide: true })
  git('init', '-q')
  await writeFile(join(root, 'source.txt'), 'file')
  git('add', '--', 'source.txt')
  const hook = join(root, 'fsmonitor-hook')
  await writeFile(hook, '#!/bin/sh\nprintf triggered > fsmonitor-triggered.txt\n')
  await chmod(hook, 0o700)
  git('config', 'core.fsmonitor', './fsmonitor-hook')
  git('status', '--short')
  const marker = join(root, 'fsmonitor-triggered.txt')
  assert.equal(await readFile(marker, 'utf8'), 'triggered')
  await unlink(marker)
  const fakeBin = join(root, 'node_modules')
  await mkdir(fakeBin)
  const fakeGit = join(fakeBin, process.platform === 'win32' ? 'git.exe' : 'git')
  await writeFile(fakeGit, 'This is intentionally not the real Git executable.')
  await chmod(fakeGit, 0o700)
  const originalPath = process.env.PATH!
  t.after(() => { process.env.PATH = originalPath })
  process.env.PATH = fakeBin + delimiter + originalPath
  const result = await tool(workspace, 'git_status')({}) as { ok: boolean }
  assert.equal(result.ok, true)
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
})
