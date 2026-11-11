import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { workspaceTarget, CodingWorkspace } from './workspace.ts'
import type { ToolInvocationContext, WorkspaceTool } from './workspace.ts'
import { containsPath, gitInvocation, redactProcessOutput, runWorkspaceProcess } from './workspace-process.ts'

const maxWorktrees = 8
const taskPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u
const worktreePattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const branchSchema = { type: 'string', minLength: 1, maxLength: 96 }
const idSchema = { type: 'string', minLength: 36, maxLength: 36 }

interface WorktreeRecord { version: 1; taskId: string; worktreeId: string; repository: string; branch: string }

function rejected(error: string) { return { ok: false, error } }

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function branchName(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,95}$/u.test(value) || value.includes('..') ||
    value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.toLowerCase().endsWith('.lock'))) return undefined
  return value
}

function samePath(left: string, right: string): boolean { return relative(left, right) === '' }

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT' }

async function canonicalDirectory(path: string): Promise<boolean> {
  try { return (await lstat(path)).isDirectory() && samePath(path, await realpath(path)) } catch { return false }
}

async function hasPrimaryRepository(workspace: CodingWorkspace): Promise<boolean> {
  const cwd = await workspace.checkedTarget('.', 'directory').catch(() => undefined)
  return Boolean(cwd && await canonicalDirectory(join(cwd, '.git')))
}

async function git(workspace: string, args: string[], signal?: AbortSignal) {
  const invocation = gitInvocation(workspace, args)
  if (!invocation) return undefined
  const result = await runWorkspaceProcess(invocation, workspace, workspace, signal)
  return result.state === 'exited' ? result : undefined
}

async function validBranch(workspace: string, name: string, signal?: AbortSignal): Promise<boolean> {
  return (await git(workspace, ['check-ref-format', '--branch', name], signal))?.code === 0
}

async function commitId(workspace: string, rev: string, signal?: AbortSignal): Promise<string | undefined> {
  const result = await git(workspace, ['rev-parse', '--verify', rev], signal)
  const id = result?.stdout.trim()
  return result?.code === 0 && id && commitPattern.test(id) ? id : undefined
}

async function cleanIndex(workspace: string, signal?: AbortSignal): Promise<boolean> {
  const result = await git(workspace, ['diff', '--cached', '--name-only', '--no-ext-diff', '--no-textconv', '-z'], signal)
  return result?.code === 0 && !result.truncated && result.stdout === ''
}

async function operationInProgress(workspace: string, signal?: AbortSignal): Promise<boolean> {
  const dir = await git(workspace, ['rev-parse', '--path-format=absolute', '--absolute-git-dir'], signal)
  if (dir?.code !== 0 || dir.truncated || !dir.stdout.trim()) return true
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_START']) {
    try { await lstat(join(dir.stdout.trim(), name)); return true } catch (error) {
      if (!missing(error)) return true
    }
  }
  return false
}

async function commitIdentity(workspace: string, signal?: AbortSignal): Promise<boolean> {
  return (await git(workspace, ['var', 'GIT_AUTHOR_IDENT'], signal))?.code === 0 &&
    (await git(workspace, ['var', 'GIT_COMMITTER_IDENT'], signal))?.code === 0
}

/** Manages worktrees created by an approved task under the Host's private data directory. */
export class ManagedGitWorktrees {
  readonly directory: string

  constructor(directory: string) { this.directory = resolve(directory) }

  #separateFrom(workspace: CodingWorkspace): boolean {
    return !containsPath(workspace.root, this.directory) && !containsPath(this.directory, workspace.root)
  }

  async #taskDirectory(taskId: string, create: boolean): Promise<string | undefined> {
    if (!taskPattern.test(taskId) || !await canonicalDirectory(dirname(this.directory))) return undefined
    const taskDirectory = join(this.directory, taskId)
    for (const path of [this.directory, taskDirectory]) {
      if (create) {
        try { await mkdir(path) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
      if (!await canonicalDirectory(path)) return undefined
    }
    return taskDirectory
  }

  async create(workspace: CodingWorkspace, taskId: string, branch: string, signal?: AbortSignal) {
    if (!this.#separateFrom(workspace) || !branchName(branch) || !await hasPrimaryRepository(workspace) ||
      !await validBranch(workspace.root, branch, signal)) {
      return rejected('A valid branch and local primary Git repository are required')
    }
    const head = await commitId(workspace.root, 'HEAD^{commit}', signal)
    if (!head || signal?.aborted) return rejected('No confirmed commit for the worktree')
    if (await commitId(workspace.root, 'refs/heads/' + branch, signal)) return rejected('The local branch already exists')
    const taskDirectory = await this.#taskDirectory(taskId, true)
    if (!taskDirectory) return rejected('Worktree storage is unavailable')
    const names = await readdir(taskDirectory)
    if (names.filter(name => worktreePattern.test(name.slice(0, -5)) && name.endsWith('.json')).length >= maxWorktrees) {
      return rejected('The task worktree limit was reached')
    }
    if (signal?.aborted) return rejected('Worktree creation was interrupted')
    const worktreeId = randomUUID()
    const path = join(taskDirectory, worktreeId)
    const metadata = join(taskDirectory, worktreeId + '.json')
    const record: WorktreeRecord = { version: 1, taskId, worktreeId, repository: workspace.root, branch }
    // Save ownership before Git can create a branch or populate a worktree.
    const file = await open(metadata, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(record), 'utf8'); await file.sync() } finally { await file.close() }
    const result = await git(workspace.root, ['worktree', 'add', '--no-guess-remote', '-b', branch, '--', path, head], signal)
    if (result?.code !== 0 || !await this.resolve(workspace, taskId, worktreeId, signal)) {
      throw new Error('Worktree creation requires reconciliation')
    }
    return { ok: true, worktreeId, branch: redactProcessOutput(branch), baseCommit: head }
  }

  async resolve(workspace: CodingWorkspace, taskId: string, worktreeId: string, signal?: AbortSignal): Promise<string | undefined> {
    if (!this.#separateFrom(workspace) || !worktreePattern.test(worktreeId) || !await hasPrimaryRepository(workspace)) return undefined
    const taskDirectory = await this.#taskDirectory(taskId, false)
    if (!taskDirectory) return undefined
    const path = join(taskDirectory, worktreeId)
    const metadata = join(taskDirectory, worktreeId + '.json')
    try {
      const stat = await lstat(metadata)
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4_096 || !samePath(metadata, await realpath(metadata)) ||
        !await canonicalDirectory(path)) return undefined
      const file = await open(metadata, 'r')
      let record: WorktreeRecord
      try {
        const current = await file.stat()
        if (current.ino !== stat.ino || current.dev !== stat.dev || current.size !== stat.size || current.nlink !== 1) return undefined
        const bytes = Buffer.alloc(4_097)
        const { bytesRead } = await file.read(bytes)
        if (bytesRead !== stat.size) return undefined
        record = JSON.parse(bytes.toString('utf8', 0, bytesRead)) as WorktreeRecord
      } finally { await file.close() }
      if (record.version !== 1 || record.taskId !== taskId || record.worktreeId !== worktreeId ||
        typeof record.repository !== 'string' || !samePath(record.repository, workspace.root) || !branchName(record.branch)) return undefined
      const listed = await git(workspace.root, ['worktree', 'list', '--porcelain', '-z'], signal)
      if (listed?.code !== 0 || listed.truncated || !listed.stdout.split('\0\0').some(entry => {
        const fields = entry.split('\0')
        return fields.some(field => field.startsWith('worktree ') && samePath(field.slice(9), path)) &&
          fields.includes('branch refs/heads/' + record.branch)
      })) return undefined
      const linkedGit = join(path, '.git')
      const linkedStat = await lstat(linkedGit)
      if (!linkedStat.isFile() || linkedStat.nlink !== 1 || linkedStat.size > 4_096 || !samePath(linkedGit, await realpath(linkedGit))) return undefined
      const shared = await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)
      return shared?.code === 0 && !shared.truncated && samePath(shared.stdout.trim(), join(workspace.root, '.git')) ? path : undefined
    } catch { return undefined }
  }
}

function commitPaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 24) return undefined
  const paths = value.map(path => workspaceTarget({ path }))
  if (paths.some(path => !path)) return undefined
  const unique = new Set(paths.map(path => process.platform === 'win32' ? path!.toLowerCase() : path))
  return unique.size === paths.length ? paths as string[] : undefined
}

async function commitFiles(workspace: CodingWorkspace, input: Record<string, unknown>, signal?: AbortSignal) {
  const paths = commitPaths(input.paths)
  const message = input.message
  if (!paths || typeof message !== 'string' || !message.trim() || !message.isWellFormed() || message.length > 300 || /[\u0000-\u001f\u007f]/u.test(message)) {
    return rejected('Commit needs a single-line message and exact file paths')
  }
  if (await operationInProgress(workspace.root, signal) || !await cleanIndex(workspace.root, signal)) {
    return rejected('Complete pending Git operations and clear existing staged changes before committing')
  }
  if (!await commitIdentity(workspace.root, signal)) return rejected('Configure Git author identity in the local repository')
  for (const path of paths) {
    const existing = await workspace.checkedTarget(path, 'file').catch(() => undefined)
    if (existing) continue
    const absent = await workspace.checkedTarget(path, 'new').catch(() => undefined)
    if (!absent || (await git(workspace.root, ['ls-files', '--error-unmatch', '--', path], signal))?.code !== 0) {
      return rejected('A commit path is missing, unsupported, or outside the workspace policy')
    }
  }
  if (signal?.aborted) return rejected('Commit was interrupted before staging')
  const staged = await git(workspace.root, ['add', '--', ...paths], signal)
  if (staged?.code !== 0) throw new Error('Git staging result requires reconciliation')
  const diff = await git(workspace.root, ['diff', '--cached', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', '-z'], signal)
  if (diff?.code !== 0 || diff.truncated || !diff.stdout.split('\0').filter(Boolean).every(path => paths.includes(path))) {
    throw new Error('Git index changed while preparing the commit')
  }
  if (!diff.stdout) return rejected('The selected files have no changes to commit')
  // --only re-reads the selected files, so reject edits that appeared after staging.
  const refreshed = await git(workspace.root, ['diff', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', '-z', '--', ...paths], signal)
  if (refreshed?.code !== 0 || refreshed.truncated || refreshed.stdout) throw new Error('Selected files changed after staging')
  if (signal?.aborted) throw new Error('Git staging completed before interruption')
  const result = await git(workspace.root, ['commit', '--no-gpg-sign', '--no-verify', '--only', '-m', message, '--', ...paths], signal)
  const id = result?.code === 0 ? await commitId(workspace.root, 'HEAD^{commit}', signal) : undefined
  if (!id) throw new Error('Git commit result requires reconciliation')
  return { ok: true, commit: id }
}

export function createGitTools(workspace: CodingWorkspace, worktrees?: ManagedGitWorktrees): WorkspaceTool[] {
  function tool(name: string, description: string, properties: Record<string, unknown>, required: string[],
    execute: (input: Record<string, unknown>, signal?: AbortSignal, context?: ToolInvocationContext) => Promise<unknown>): WorkspaceTool {
    return {
      name, description, effect: 'write', policy: { minimumAccess: 'trusted', rootOnly: true, approval: 'git' },
      parameters: { type: 'object', properties, required, additionalProperties: false },
      async execute(_id, raw, signal, context) {
        const input = object(raw)
        if (!input || Object.keys(input).some(key => !Object.hasOwn(properties, key)) ||
          required.some(key => !Object.hasOwn(input, key)) || signal?.aborted) return rejected('Invalid or interrupted Git request')
        const release = workspace.acquireWrite()
        if (!release) return rejected('Another workspace write is active')
        try {
          if (!await hasPrimaryRepository(workspace)) return rejected('A local primary Git repository is required')
          return await execute(input, signal, context)
        } finally { release() }
      },
    }
  }

  const tools = [
    tool('git_branch', 'Create a new local branch at HEAD without switching branches.', { branch: branchSchema }, ['branch'], async (input, signal) => {
      const branch = branchName(input.branch)
      if (!branch || !await validBranch(workspace.root, branch, signal)) return rejected('Invalid local Git branch')
      const head = await commitId(workspace.root, 'HEAD^{commit}', signal)
      if (!head || signal?.aborted) return rejected('No confirmed commit for the branch')
      if (await commitId(workspace.root, 'refs/heads/' + branch, signal)) return rejected('The local branch already exists')
      if (signal?.aborted) return rejected('Branch creation was interrupted')
      const result = await git(workspace.root, ['branch', '--no-track', '--', branch, head], signal)
      if (result?.code !== 0) throw new Error('Git branch creation requires reconciliation')
      return { ok: true, branch: redactProcessOutput(branch), commit: head }
    }),
    tool('git_commit', 'Commit exactly the listed workspace files. Requires a clean index. Use worktreeId for an approved task worktree.',
      { message: { type: 'string', minLength: 1, maxLength: 300 }, paths: { type: 'array', minItems: 1, maxItems: 24,
        items: { type: 'string', minLength: 1, maxLength: 512 } }, ...(worktrees ? { worktreeId: idSchema } : {}) }, ['message', 'paths'],
      async (input, signal, context) => {
        if (input.worktreeId === undefined) return commitFiles(workspace, input, signal)
        const path = worktrees && typeof input.worktreeId === 'string' && context &&
          await worktrees.resolve(workspace, context.taskId, input.worktreeId, signal)
        if (!path) return rejected('Worktree is unavailable to this task')
        const linked = new CodingWorkspace(path)
        const release = linked.acquireWrite()
        if (!release) return rejected('Another worktree write is active')
        try { return await commitFiles(linked, input, signal) } finally { release() }
      }),
    tool('git_merge', 'Merge an exact local branch into the current clean primary workspace. Conflicts require reconciliation.',
      { branch: branchSchema }, ['branch'], async (input, signal) => {
        const branch = branchName(input.branch)
        if (!branch || !await validBranch(workspace.root, branch, signal)) return rejected('Invalid local Git branch')
        const id = await commitId(workspace.root, 'refs/heads/' + branch + '^{commit}', signal)
        if (!id) return rejected('No such local Git branch')
        const status = await git(workspace.root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--no-renames', '--ignore-submodules=none'], signal)
        if (status?.code !== 0 || status.truncated || status.stdout || await operationInProgress(workspace.root, signal)) {
          return rejected('Merge requires a clean worktree and no unfinished Git operation')
        }
        if (!await commitIdentity(workspace.root, signal)) return rejected('Configure Git author identity in the local repository')
        if (signal?.aborted) return rejected('Merge was interrupted before execution')
        const result = await git(workspace.root, ['merge', '--no-edit', '--no-gpg-sign', '--no-overwrite-ignore', id], signal)
        const head = result?.code === 0 ? await commitId(workspace.root, 'HEAD^{commit}', signal) : undefined
        if (!head) throw new Error('Git merge result requires reconciliation')
        return { ok: true, commit: head }
      }),
  ]
  if (worktrees) tools.push(tool('git_worktree', 'Create an isolated local Git worktree and branch for this task at the current commit.',
    { branch: branchSchema }, ['branch'], async (input, signal, context) => {
      const branch = branchName(input.branch)
      if (!branch || !context) return rejected('A task and local branch are required')
      return worktrees.create(workspace, context.taskId, branch, signal)
    }))
  return tools
}
