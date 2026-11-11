import { createHash } from 'node:crypto'
import type { EventDraft, VerificationCheck, VerificationResult, WorkspaceAccess } from './contracts/domain.ts'
import type { WorkflowPack } from './policies.ts'
import type { TaskEngine } from './task-engine.ts'
import { workspaceTarget } from './workspace.ts'
import type { CodingWorkspace } from './workspace.ts'

export async function verifyWorkspace(
  tasks: TaskEngine, workflow: WorkflowPack, workspace: CodingWorkspace, event: EventDraft,
  check: VerificationCheck, signal: AbortSignal, access: WorkspaceAccess, phase?: 'verification',
): Promise<VerificationResult> {
  const checked = (result: VerificationResult): VerificationResult => ({
    passed: result.passed, evidence: result.evidence, verdict: result.passed ? 'verified' : 'failed',
    basis: check.command ? 'project_command' : 'workspace_path',
  })
  if (!check.command) return checked(await workflow.verify(workspace, check, signal, access))
  if (access !== 'trusted' || signal.aborted) return checked({ passed: false, evidence: 'project_command_not_authorized' })
  const operations = tasks.operations(event.taskId)
  const version = tasks.get(event.taskId).planVersion
  const writes = operations.filter(item => item.effect === 'write' && item.tool !== 'verify_project_command')
  const versionId = createHash('sha256').update(JSON.stringify([version, check, writes.map(item => item.id)])).digest('hex')
  const id = event.taskAttemptId + ':verification:' + versionId
  const previous = operations.find(item => item.id === id)
  if (previous) return checked({
    passed: previous.status === 'succeeded',
    evidence: previous.status === 'succeeded' ? 'project_command_exit_zero' : 'project_command_previous_result',
  })
  tasks.beginTool(event.taskId, event, id, 'verify_project_command', 'write', workspaceTarget(check.command), phase)
  let result: VerificationResult
  try {
    result = await workflow.verify(workspace, check, signal, access)
  } catch {
    tasks.finishTool(event, id, 'unknown_effect')
    return checked({ passed: false, evidence: 'project_command_effect_unknown' })
  }
  tasks.finishTool(event, id, result.passed ? 'succeeded' : 'failed')
  return checked(result)
}
