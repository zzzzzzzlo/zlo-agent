import type { EvaluationEvidence } from '../../shared/contracts/observatory.ts'
import type { Attempt, Operation, TaskSnapshot } from './task-engine.ts'
import { telemetryDigest, telemetryVerification } from './telemetry-projection.ts'
import { CodingWorkspace, workspaceTarget } from './workspace.ts'
import { redactProcessOutput } from './workspace-process.ts'

const inactive = new Set(['succeeded', 'failed', 'blocked', 'stopped', 'needs_reconciliation'])

function clean(text: string, limit: number): string {
  return redactProcessOutput(text)
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/gu, '[redacted]')
    .replace(/\b(?:set-cookie|cookie|api[_ -]?key|access[_ -]?token|password|secret)\s*[=:]\s*[^\r\n]+/giu, '[redacted]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/gu, '[redacted]')
    .slice(0, limit)
}

export async function evaluationEvidence(history: { task: TaskSnapshot; attempts: Attempt[]; operations: Operation[] },
  nodeId: string | undefined, selectedFiles: string[], signal: AbortSignal): Promise<EvaluationEvidence> {
  const { task } = history
  const node = nodeId && nodeId !== task.rootNodeId
    ? task.worker?.id === nodeId ? task.worker : task.nodes?.find(node => node.id === nodeId) : undefined
  if (nodeId && nodeId !== task.rootNodeId && !node) throw new Error('Evaluation target unavailable')
  if (node ? node.status !== 'succeeded' && node.status !== 'failed' : !inactive.has(task.status)) {
    throw new Error('Evaluation target is still active')
  }
  const check = node ? node.check : task.check
  const checkPath = workspaceTarget({ path: check?.path })
  const verification = telemetryVerification(node ? node.verification : task.verification)
  let snapshotVerification: EvaluationEvidence['snapshotVerification']
  const selectedOperations = history.operations.filter(operation => !node || operation.taskNodeId === node.id)
  const limitations: string[] = []
  const selected = new Set(selectedFiles)
  if (checkPath && [...selected].some(path => workspaceTarget({ path }) === checkPath)) {
    snapshotVerification = { passed: false, verdict: 'unverified', basis: 'workspace_path', evidence: 'workspace_file_unavailable' }
  }
  // The declared file check is a task-scoped evidence reference. Only fetch it when explicitly selected.
  const nodeFiles = new Set([check?.path, ...(node?.result?.artifactRefs ?? []), ...selectedOperations.map(op => op.target)]
    .flatMap(value => workspaceTarget({ path: value }) ?? []))
  const artifacts: EvaluationEvidence['artifacts'] = []
  const structure: string[] = []
  if (!selected.size) limitations.push('No workspace files were selected for inspection.')
  if (selected.size && node?.worktreeId) limitations.push('This node used a separate worktree; file snapshots are unavailable.')
  if (selected.size && !node?.worktreeId) {
    let workspace: CodingWorkspace | undefined
    try { workspace = new CodingWorkspace(task.cwd) } catch { limitations.push('The workspace is unavailable.') }
    if (workspace) {
      const scopes = new Set<string>()
      for (const input of selected) {
        signal.throwIfAborted()
        const path = workspaceTarget({ path: input })
        const inScope = !node?.scopePath || path === node.scopePath || path?.startsWith(node.scopePath + '/')
        if (!path || clean(path, 512) !== path || !inScope || node && !nodeFiles.has(path)) {
          limitations.push('A selected file was outside the available evidence scope.')
          continue
        }
        try {
          const { text } = await workspace.readTextSnapshot(path, signal)
          if (checkPath === path) {
            const passed = check?.contains === undefined || text.includes(check.contains)
            snapshotVerification = { passed, verdict: passed ? 'verified' : 'failed', basis: 'workspace_path',
              evidence: !passed ? 'workspace_file_missing_expected_text' : check?.contains === undefined
                ? 'workspace_text_file_exists' : 'workspace_file_contains_expected_text' }
          }
          const excerpt = clean(text, 4_000)
          const diffs = []
          for (const staged of [true, false]) {
            const diff = await workspace.gitDiffSnapshot(path, staged, signal).catch(() => undefined)
            if (diff?.ok && 'stdout' in diff && diff.stdout) diffs.push(diff.stdout)
          }
          const diff = clean(diffs.join('\n'), 4_000)
          artifacts.push({ path, digest: telemetryDigest(text), bytes: Buffer.byteLength(text), excerpt, ...(diff ? { diff } : {}) })
          if (excerpt.length < text.length || diff.length === 4_000) limitations.push('A file or diff excerpt was redacted or shortened.')
          scopes.add(path.split('/').slice(0, -1).join('/') || '.')
        } catch {
          limitations.push('A selected file could not be read as workspace text.')
        }
      }
      // A node may inspect only the names it delivered. Root can inspect adjacent structure.
      const list = workspace.tools('root', 'read').find(tool => tool.name === 'list_directory')!
      if (!node) for (const scope of scopes) {
        signal.throwIfAborted()
        const listing = await list.execute('evaluation-read', { path: scope }, signal).catch(() => undefined) as
          { entries?: { name: string; kind: string }[] } | undefined
        for (const entry of listing?.entries?.slice(0, 12) ?? []) {
          if (structure.length >= 40 || entry.name.length > 120 || clean(entry.name, 120) !== entry.name) continue
          structure.push((scope === '.' ? '' : scope + '/') + entry.name + (entry.kind === 'directory' ? '/' : ''))
        }
      }
    }
  }
  signal.throwIfAborted()
  if (artifacts.length) limitations.push('Files and local diffs reflect the workspace at capture time. Committed or historical versions may differ.')
  if (selectedOperations.length > 96) limitations.push('The operation receipt list was limited to 96 records.')
  const constraints = [check?.path ? `Declared file verification: ${clean(check.path, 256)}` : check?.command ? 'Declared project command verification.' : undefined,
    ...(!node ? task.instructions.filter(instruction => instruction.delivered).slice(-8).map(instruction => clean(instruction.text, 500)) : [])]
    .filter((value): value is string => value !== undefined)
  return { taskId: task.id, taskRunId: task.taskRunId, nodeId, capturedAt: new Date().toISOString(), goal: clean(node?.goal ?? task.goal, 8_000),
    constraints, verification, snapshotVerification, artifacts, operations: selectedOperations.slice(-96).map(({ id, tool, status, effect }) => ({
      id: telemetryDigest(id), tool: clean(tool, 128), status, effect,
    })), structure: [...new Set(structure)], limitations: [...new Set(limitations)] }
}
