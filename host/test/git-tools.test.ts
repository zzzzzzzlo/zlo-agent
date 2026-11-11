import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { createGitTools, ManagedGitWorktrees } from '../src/git-tools.ts'
import { CodingWorkspace } from '../src/workspace.ts'
import type { ToolInvocationContext } from '../src/workspace.ts'

const options = { encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'pipe'] as const, windowsHide: true }

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { ...options, stdio: [...options.stdio] }).trim()
}

async function fixture(context: TestContext) {
  const temp = await mkdtemp(join(tmpdir(), 'zlo-git-plugin-'))
  context.after(() => rm(temp, { recursive: true, force: true }))
  const root = join(temp, 'repo')
  const state = join(temp, 'state')
  await mkdir(root)
  await mkdir(state)
  git(root, ['init', '-b', 'main'])
  git(root, ['config', 'user.email', 'test@example.invalid'])
  git(root, ['config', 'user.name', 'Zlo test'])
  await writeFile(join(root, 'base.txt'), 'base\n')
  git(root, ['add', '--', 'base.txt'])
  git(root, ['commit', '-m', 'initial'])
  const workspace = new CodingWorkspace(root)
  const worktrees = new ManagedGitWorktrees(join(state, 'worktrees'))
  const tools = createGitTools(workspace, worktrees)
  const toolContext: ToolInvocationContext = { taskId: 'task-one', agentRunId: 'root-run', defer() {}, onCleanup() {} }
  const run = async (name: string, input: unknown) => await tools.find(tool => tool.name === name)!.execute(name, input, undefined, toolContext) as {
    ok: boolean; error?: string; worktreeId?: string; branch?: string; commit?: string
  }
  return { root, workspace, worktrees, tools, run }
}

test('approved Git tools use durable task-owned worktrees, commit specific files and integrate a clean root', async context => {
  const { root, workspace, worktrees, tools, run } = await fixture(context)
  assert.ok(tools.every(tool => tool.effect === 'write' && tool.policy?.rootOnly && tool.policy.approval === 'git'))
  assert.equal((await run('git_branch', { branch: '--force' })).ok, false)
  assert.equal((await run('git_branch', { branch: 'local/proof' })).ok, true)
  assert.equal(git(root, ['branch', '--show-current']), 'main')
  assert.ok(git(root, ['branch', '--list']).includes('local/proof'))

  const result = await run('git_worktree', { branch: 'zlo/isolated' })
  assert.equal(result.ok, true)
  assert.ok(result.worktreeId)
  const reopened = new ManagedGitWorktrees(worktrees.directory)
  const path = await reopened.resolve(workspace, 'task-one', result.worktreeId)
  assert.ok(path)
  assert.equal(await reopened.resolve(workspace, 'other-task', result.worktreeId), undefined)
  assert.equal(await reopened.resolve(workspace, 'task-one', '../../repo'), undefined)
  assert.equal(git(path, ['branch', '--show-current']), 'zlo/isolated')

  await writeFile(join(path, 'artifact.txt'), 'isolated change\n')
  await assert.rejects(access(join(root, 'artifact.txt')), { code: 'ENOENT' })
  const commit = await run('git_commit', { message: 'Add artifact', paths: ['artifact.txt'], worktreeId: result.worktreeId })
  assert.equal(commit.ok, true)
  assert.equal(commit.commit, git(path, ['rev-parse', 'HEAD']))
  assert.equal(git(path, ['status', '--porcelain']), '')

  await writeFile(join(root, 'base.txt'), 'user edit\n')
  assert.equal((await run('git_merge', { branch: 'zlo/isolated' })).ok, false)
  assert.equal(await readFile(join(root, 'base.txt'), 'utf8'), 'user edit\n')
  await writeFile(join(root, 'base.txt'), 'base\n')
  const merged = await run('git_merge', { branch: 'zlo/isolated' })
  assert.equal(merged.ok, true)
  assert.equal(await readFile(join(root, 'artifact.txt'), 'utf8'), 'isolated change\n')
})

test('Git commit rejects an unrelated staged file and a merge conflict remains observable', async context => {
  const { root, workspace, worktrees, run } = await fixture(context)
  const result = await run('git_worktree', { branch: 'zlo/conflict' })
  assert.ok(result.worktreeId)
  const linked = await worktrees.resolve(workspace, 'task-one', result.worktreeId)
  assert.ok(linked)
  await writeFile(join(linked, 'base.txt'), 'worker edit\n')
  assert.equal((await run('git_commit', { message: 'Worker edit', paths: ['base.txt'], worktreeId: result.worktreeId })).ok, true)
  await writeFile(join(root, 'base.txt'), 'root edit\n')
  assert.equal((await run('git_commit', { message: 'Root edit', paths: ['base.txt'] })).ok, true)
  await assert.rejects(run('git_merge', { branch: 'zlo/conflict' }), /requires reconciliation/u)
  assert.ok((await readFile(join(root, 'base.txt'), 'utf8')).includes('<<<<<<<'))
  assert.equal(git(root, ['rev-parse', 'MERGE_HEAD']), git(linked, ['rev-parse', 'HEAD']))
})

test('Git commit neither touches nor includes pre-existing staged changes', async context => {
  const { root, run } = await fixture(context)
  await writeFile(join(root, 'user.txt'), 'staged by user\n')
  git(root, ['add', '--', 'user.txt'])
  await writeFile(join(root, 'agent.txt'), 'created by agent\n')
  const before = git(root, ['rev-parse', 'HEAD'])
  assert.equal((await run('git_commit', { message: 'Agent change', paths: ['agent.txt'] })).ok, false)
  assert.equal(git(root, ['rev-parse', 'HEAD']), before)
  assert.equal(git(root, ['diff', '--cached', '--name-only']), 'user.txt')
})
