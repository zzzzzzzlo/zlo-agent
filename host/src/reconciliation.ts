import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import type { FilePostcondition, Operation } from './task-engine.ts'
import { workspaceTarget } from './workspace.ts'
import type { CodingWorkspace, WorkspaceAccess } from './workspace.ts'

const maxTextBytes = 128 * 1024
const maxPatchEdits = 16
const branchPattern = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,95}$/u

async function identity(workspace: CodingWorkspace): Promise<string> {
  const stat = await lstat(workspace.root, { bigint: true })
  if (!stat.isDirectory() || stat.ino === 0n) throw new Error('Workspace identity is unavailable')
  return stat.dev + ':' + stat.ino
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.isWellFormed() && Buffer.byteLength(value) <= maxTextBytes &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
}

function validBranchName(value: unknown): string | undefined {
  if (typeof value !== 'string' || !branchPattern.test(value) || value.includes('..') ||
    value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.toLowerCase().endsWith('.lock'))) {
    return undefined
  }
  return value
}

async function fileIdentity(path: string): Promise<string> {
  const stat = await lstat(path, { bigint: true })
  if (!stat.isFile()) throw new Error('Expected regular file')
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`
}

async function confirmedAbsent(workspace: CodingWorkspace, target: string): Promise<boolean> {
  try {
    const absent = await workspace.checkedTarget(target, 'new')
    await lstat(absent)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
  }
}

function computePatchAfter(original: string, edits: { oldText: string; newText: string }[]): string | undefined {
  const matched: { start: number; end: number; newText: string }[] = []
  for (const { oldText, newText } of edits) {
    const start = original.indexOf(oldText)
    if (start < 0 || original.indexOf(oldText, start + 1) >= 0) return undefined
    matched.push({ start, end: start + oldText.length, newText })
  }
  matched.sort((a, b) => a.start - b.start)
  const parts: string[] = []
  let cursor = 0
  for (const edit of matched) {
    if (edit.start < cursor) return undefined
    parts.push(original.slice(cursor, edit.start), edit.newText)
    cursor = edit.end
  }
  parts.push(original.slice(cursor))
  const result = parts.join('')
  return validText(result) ? result : undefined
}

export async function prepareFilePostcondition(
  tool: string, workspace: CodingWorkspace, target: string | undefined, input: unknown, access: WorkspaceAccess = 'read',
): Promise<FilePostcondition | undefined> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const record = input as Record<string, unknown>
  const signal = AbortSignal.timeout(2000)
  try {
    if (tool === 'create_text_file') {
      if (!target || !validText(record.content)) return undefined
      await workspace.checkedTarget(target, 'new')
      return { kind: 'created_text', workspaceIdentity: await identity(workspace), digest: digest(record.content) }
    }
    if (tool === 'edit_text_file') {
      if (!target || !validText(record.oldText) || !record.oldText || !validText(record.newText)) return undefined
      const { text } = await workspace.readTextSnapshot(target, signal)
      const after = computePatchAfter(text, [{ oldText: record.oldText, newText: record.newText }])
      if (after === undefined) return undefined
      return { kind: 'edited_text', workspaceIdentity: await identity(workspace), beforeDigest: digest(text), afterDigest: digest(after) }
    }
    if (tool === 'delete_file') {
      if (!target) return undefined
      const existing = await workspace.checkedTarget(target, 'file')
      return { kind: 'deleted_file', workspaceIdentity: await identity(workspace), fileIdentity: await fileIdentity(existing) }
    }
    if (tool === 'apply_patch') {
      if (!Array.isArray(record.edits) || record.edits.length < 1 || record.edits.length > maxPatchEdits) return undefined
      const groups = new Map<string, { path: string; edits: { oldText: string; newText: string }[] }>()
      for (const item of record.edits) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined
        const entry = item as Record<string, unknown>
        const path = workspaceTarget({ path: entry.path })
        if (!path || !validText(entry.oldText) || !entry.oldText || !validText(entry.newText)) return undefined
        const key = process.platform === 'win32' ? path.toLowerCase() : path
        const group = groups.get(key)
        if (group && group.path !== path) return undefined
        if (group) group.edits.push({ oldText: entry.oldText, newText: entry.newText })
        else groups.set(key, { path, edits: [{ oldText: entry.oldText, newText: entry.newText }] })
      }
      const files: { path: string; beforeDigest: string; afterDigest: string }[] = []
      for (const { path, edits } of groups.values()) {
        const { text } = await workspace.readTextSnapshot(path, signal)
        const after = computePatchAfter(text, edits)
        if (after === undefined) return undefined
        files.push({ path, beforeDigest: digest(text), afterDigest: digest(after) })
      }
      return { kind: 'patched_files', workspaceIdentity: await identity(workspace), files }
    }
    if (tool === 'git_branch' && access === 'trusted') {
      const branch = validBranchName(record.branch)
      if (!branch) return undefined
      const head = await workspace.gitRevisionSnapshot('HEAD^{commit}', signal)
      if (!head || await workspace.gitRevisionSnapshot('refs/heads/' + branch, signal)) return undefined
      return { kind: 'git_branch', workspaceIdentity: await identity(workspace), branch, expectedCommit: head }
    }
    if (tool === 'git_commit' && access === 'trusted' && record.worktreeId === undefined && Array.isArray(record.paths)) {
      if (await workspace.gitIndexCleanSnapshot(signal) !== true) return undefined
      const headBefore = await workspace.gitRevisionSnapshot('HEAD^{commit}', signal)
      return { kind: 'git_commit', workspaceIdentity: await identity(workspace), ...(headBefore ? { headBefore } : {}) }
    }
    return undefined
  } catch {
    return undefined
  }
}

export async function probeOperation(
  workspace: CodingWorkspace, operation: Operation, access: WorkspaceAccess = 'read',
): Promise<NonNullable<Operation['reconciliation']>> {
  const unresolved = (evidence: string) => ({ status: 'unresolved' as const, evidence })
  const signal = AbortSignal.timeout(2500)
  if (operation.worktreeId) return unresolved('isolated_worktree_requires_manual_review')
  const postcondition = operation.filePostcondition
  if (postcondition) {
    try {
      if (await identity(workspace) !== postcondition.workspaceIdentity) return unresolved('workspace_identity_changed')
    } catch {
      return unresolved('workspace_identity_changed')
    }
  }
  if (operation.tool.startsWith('git_')) {
    if (access !== 'trusted') return unresolved('git_probe_requires_trusted_workspace')
    if (postcondition?.kind === 'git_branch') {
      const refCommit = await workspace.gitRevisionSnapshot('refs/heads/' + postcondition.branch, signal)
      if (refCommit === postcondition.expectedCommit) {
        return { status: 'verified', evidence: 'git_branch_matches_recorded_postcondition' }
      }
      const headNow = await workspace.gitRevisionSnapshot('HEAD^{commit}', signal)
      if (!refCommit && headNow === postcondition.expectedCommit) {
        return { status: 'verified', evidence: 'git_branch_absent_matches_precondition' }
      }
    }
    if (postcondition?.kind === 'git_commit') {
      const indexClean = await workspace.gitIndexCleanSnapshot(signal)
      const headNow = await workspace.gitRevisionSnapshot('HEAD^{commit}', signal)
      if (indexClean === true && headNow === postcondition.headBefore) {
        return { status: 'verified', evidence: 'git_head_unchanged_and_index_clean' }
      }
      if (indexClean === true && headNow && headNow !== postcondition.headBefore) {
        const parent = await workspace.gitRevisionSnapshot('HEAD^1', signal)
        if (postcondition.headBefore ? parent === postcondition.headBefore : !parent) {
          return { status: 'verified', evidence: 'git_commit_matches_recorded_postcondition' }
        }
      }
    }
    const git = workspace.tools('root', 'trusted').find(tool => tool.name === 'git_status')!
    const result = await git.execute('reconciliation', {}, signal).catch(() => undefined)
    if (result && typeof result === 'object' && 'ok' in result && result.ok &&
      'entries' in result && Array.isArray(result.entries)) {
      return { ...unresolved('git_status_observed_without_expected_revision'),
        changedEntries: result.entries.length, truncated: 'truncated' in result && result.truncated === true }
    }
    return unresolved('git_status_unavailable')
  }
  if (operation.managed) {
    const pid = operation.processId
    if (pid === undefined || !Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fff_ffff) return unresolved('original_process_identity_not_available')
    try {
      process.kill(pid, 0)
      return unresolved('recorded_pid_exists_identity_unconfirmed')
    } catch (error) {
      return unresolved((error as NodeJS.ErrnoException).code === 'ESRCH'
        ? 'recorded_pid_absent_effect_unconfirmed' : 'recorded_pid_status_unavailable')
    }
  }
  if (postcondition?.kind === 'patched_files') {
    const observed: { currentDigest: string; beforeDigest: string; afterDigest: string }[] = []
    for (const file of postcondition.files) {
      const snapshot = await workspace.readTextSnapshot(file.path, signal).catch(() => undefined)
      if (!snapshot) return unresolved('file_missing_or_unreadable')
      observed.push({ currentDigest: digest(snapshot.text), beforeDigest: file.beforeDigest, afterDigest: file.afterDigest })
    }
    if (observed.every(item => item.currentDigest === item.afterDigest)) {
      return { status: 'verified', evidence: 'patch_matches_recorded_postcondition' }
    }
    if (observed.every(item => item.currentDigest === item.beforeDigest)) {
      return { status: 'verified', evidence: 'patch_matches_recorded_precondition' }
    }
    return unresolved('patch_partially_applied_or_modified')
  }
  if (!operation.target) return unresolved('no_read_only_probe_available')
  if (postcondition?.kind === 'deleted_file') {
    const existing = await workspace.checkedTarget(operation.target, 'file').catch(() => undefined)
    if (existing) {
      const current = await fileIdentity(existing).catch(() => undefined)
      return current === postcondition.fileIdentity
        ? { status: 'verified', evidence: 'file_intact_matches_precondition' }
        : unresolved('file_content_differs')
    }
    return await confirmedAbsent(workspace, operation.target)
      ? { status: 'verified', evidence: 'file_deleted_matches_postcondition' }
      : unresolved('file_missing_or_unreadable')
  }
  try {
    const { text } = await workspace.readTextSnapshot(operation.target, signal)
    if (!postcondition) return unresolved('file_observed_without_expected_digest')
    const currentDigest = digest(text)
    if (postcondition.kind === 'edited_text') {
      if (currentDigest === postcondition.afterDigest) {
        return { status: 'verified', evidence: 'file_content_matches_recorded_postcondition' }
      }
      if (currentDigest === postcondition.beforeDigest) {
        return { status: 'verified', evidence: 'file_content_matches_recorded_precondition' }
      }
      return unresolved('file_content_differs')
    }
    if (postcondition.kind !== 'created_text' || currentDigest !== postcondition.digest) return unresolved('file_content_differs')
    return { status: 'verified', evidence: 'file_content_matches_recorded_postcondition' }
  } catch {
    if (postcondition?.kind === 'created_text' && await confirmedAbsent(workspace, operation.target)) {
      return { status: 'verified', evidence: 'file_absent_matches_precondition' }
    }
    return unresolved('file_missing_or_unreadable')
  }
}
