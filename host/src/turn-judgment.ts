import type { EventDraft } from './contracts/domain.ts'
import type { LocalJudgment } from './judgment.ts'
import { isUnresolvedEffect } from './task-engine.ts'
import type { Operation } from './task-engine.ts'

export type TurnFollowUp = { id: 'turn.completion' | 'turn.continue'; nudge: string; allowEdits?: boolean }

export interface TurnEvidence {
  goal: string
  summary: string
  checkConfigured: boolean
  operations: Operation[]
  completedReceipts: readonly string[]
  attemptCount: number
  maxFollowUps?: number
  signal: AbortSignal
  role?: 'root' | 'team' | 'worker'
  access?: string
  parentGoal?: string
  evidenceCount?: number
  artifactCount?: number
  completedChildren?: number
  checked?: boolean
  checkPassed?: boolean
  successfulTools?: string[]
  allowed?: boolean[]
  evidenceRefs?: string[]
}

const verificationTools = new Set(['run_project_command', 'preview_page', 'browser_snapshot', 'read_text_file', 'git_diff'])
const followUpRead = new Set([
  'read_text_file', 'list_directory', 'search_files', 'search_content', 'git_status', 'git_diff', 'git_log',
  'view_image', 'preview_page', 'browser_snapshot', 'run_project_command', 'read_tool_evidence', 'read_skill',
])
const followUpWrite = new Set(['create_text_file', 'edit_text_file', 'apply_patch', 'rename_file', 'move_file'])
const completionNudge = 'Before closing, finish any remaining requested work, resolve any defects, and run required local verification with permitted tools while respecting all original constraints (including any instruction to skip tests). Do not seek new approvals or perform external actions. Report verified results or remaining uncertainty.'

export function followUpAllows(followUp: TurnFollowUp | undefined, tool: string): boolean {
  if (!followUp) return true
  if (followUpRead.has(tool)) return true
  const editable = followUp.allowEdits ?? (followUp.id === 'turn.continue')
  return editable && followUpWrite.has(tool)
}

export async function reviewCompletion(judgment: LocalJudgment, event: EventDraft, evidence: TurnEvidence):
Promise<{ insufficient: boolean; followUp?: TurnFollowUp }> {
  if (evidence.signal.aborted || judgment.mode('turn.completion', event.taskId) === 'off') return { insufficient: false }
  const operations = evidence.operations.filter(operation => operation.taskNodeId === event.taskNodeId &&
    operation.attemptId === event.taskAttemptId)
  if (operations.some(operation => operation.status === 'started' || isUnresolvedEffect(operation))) {
    return { insufficient: false }
  }
  const isWorkspaceWrite = (operation: Operation) => operation.effect === 'write' && operation.status === 'succeeded' &&
    Boolean(operation.target || ['apply_patch', 'rename_file', 'move_file', 'delete_file'].includes(operation.tool))
  const byId = new Map(operations.map(operation => [operation.id, operation]))
  const completed = evidence.completedReceipts.map(id => byId.get(id)).filter(operation => operation !== undefined)
  const lastWrite = completed.findLastIndex(isWorkspaceWrite)
  const writeCount = operations.filter(isWorkspaceWrite).length
  const postWriteEvidence = completed.slice(lastWrite + 1)
    .filter(operation => operation.status === 'succeeded' && verificationTools.has(operation.tool)).length
  const localTools = [...new Set(operations.filter(operation => operation.status === 'succeeded').map(operation => operation.tool))]
  const input = {
    goal: evidence.goal,
    parentGoal: evidence.parentGoal,
    summary: evidence.summary.slice(0, 8000),
    role: evidence.role ?? 'root',
    access: evidence.access,
    checkConfigured: evidence.checkConfigured,
    checked: evidence.checked,
    checkPassed: evidence.checkPassed,
    evidenceCount: evidence.evidenceCount ?? postWriteEvidence,
    artifactCount: evidence.artifactCount,
    completedChildren: evidence.completedChildren,
    successfulTools: evidence.successfulTools ?? localTools.slice(0, 24),
    writeCount,
    failedCount: operations.filter(operation => operation.status === 'failed').length,
    attemptCount: evidence.attemptCount,
  }
  const allowed = evidence.allowed ?? [false, true]
  const refs = evidence.evidenceRefs ?? operations.slice(-8).map(operation => operation.id)
  const insufficient = await judgment.decide(event, 'turn.completion', input, false, allowed, refs, { signal: evidence.signal })
  if (evidence.signal.aborted || !insufficient) return { insufficient: false }
  const maxFollowUps = evidence.maxFollowUps ?? 1
  return evidence.attemptCount < maxFollowUps
    ? { insufficient: true, followUp: { id: 'turn.completion', nudge: completionNudge, allowEdits: true } }
    : { insufficient: true }
}

export async function reviewTurn(judgment: LocalJudgment, event: EventDraft, evidence: TurnEvidence): Promise<TurnFollowUp | undefined> {
  return (await reviewCompletion(judgment, event, evidence)).followUp
}
