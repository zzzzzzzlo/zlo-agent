import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import type { FilePostcondition, Operation } from './task-engine.ts'
import type { CodingWorkspace } from './workspace.ts'

async function identity(workspace: CodingWorkspace): Promise<string> {
  const stat = await lstat(workspace.root, { bigint: true })
  if (!stat.isDirectory() || stat.ino === 0n) throw new Error('Workspace identity is unavailable')
  return stat.dev + ':' + stat.ino
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export async function prepareFilePostcondition(
  tool: string, workspace: CodingWorkspace, target: string | undefined, input: unknown,
): Promise<FilePostcondition | undefined> {
  if (tool !== 'create_text_file' || !target || !input || typeof input !== 'object' || !('content' in input) ||
    typeof input.content !== 'string' || !input.content.isWellFormed() || Buffer.byteLength(input.content) > 128 * 1024) return
  try {
    await workspace.checkedTarget(target, 'new')
    return { kind: 'created_text', workspaceIdentity: await identity(workspace), digest: digest(input.content) }
  } catch { return undefined }
}

export async function probeOperation(
  workspace: CodingWorkspace, operation: Operation,
): Promise<NonNullable<Operation['reconciliation']>> {
  const unresolved = (evidence: string) => ({ status: 'unresolved' as const, evidence })
  const signal = AbortSignal.timeout(2500)
  if (operation.worktreeId) return unresolved('isolated_worktree_requires_manual_review')
  if (operation.tool.startsWith('git_')) {
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
  if (!operation.target) return unresolved('no_read_only_probe_available')
  try {
    if (operation.filePostcondition && await identity(workspace) !== operation.filePostcondition.workspaceIdentity) {
      return unresolved('workspace_identity_changed')
    }
    const { text } = await workspace.readTextSnapshot(operation.target, signal)
    if (!operation.filePostcondition) return unresolved('file_observed_without_expected_digest')
    if (digest(text) !== operation.filePostcondition.digest) return unresolved('file_content_differs')
    return { status: 'verified', evidence: 'file_content_matches_recorded_postcondition' }
  } catch {
    return unresolved('file_missing_or_unreadable')
  }
}
