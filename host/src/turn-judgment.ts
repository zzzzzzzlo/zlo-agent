import type { EventDraft } from './contracts/domain.ts'
import type { LocalJudgment } from './judgment.ts'
import type { Operation } from './task-engine.ts'

export type TurnFollowUp = { id: 'turn.completion' | 'turn.continue'; nudge: string }

interface TurnEvidence {
  goal: string
  summary: string
  checkConfigured: boolean
  operations: Operation[]
  completedReceipts: readonly string[]
  attempted: Set<TurnFollowUp['id']>
  signal: AbortSignal
}

const verificationTools = new Set(['run_project_command', 'preview_page', 'browser_snapshot', 'read_text_file', 'git_diff'])
const followUpRead = new Set(['read_text_file', 'list_directory', 'search_files', 'search_content', 'git_status', 'git_diff', 'view_image'])
const followUpWrite = new Set(['create_text_file', 'edit_text_file'])

export function followUpAllows(followUp: TurnFollowUp | undefined, tool: string): boolean {
  return !followUp || followUpRead.has(tool) || (followUp.id === 'turn.continue' && followUpWrite.has(tool))
}

export async function reviewTurn(judgment: LocalJudgment, event: EventDraft, evidence: TurnEvidence): Promise<TurnFollowUp | undefined> {
  if (evidence.signal.aborted) return
  const operations = evidence.operations.filter(operation => operation.taskNodeId === event.taskNodeId &&
    operation.attemptId === event.taskAttemptId)
  if (operations.some(operation => operation.status === 'started' || operation.status === 'unknown_effect')) return
  const isWorkspaceWrite = (operation: Operation) => operation.effect === 'write' && operation.status === 'succeeded' &&
    Boolean(operation.target || ['apply_patch', 'rename_file', 'move_file', 'delete_file'].includes(operation.tool))
  const byId = new Map(operations.map(operation => [operation.id, operation]))
  const completed = evidence.completedReceipts.map(id => byId.get(id)).filter(operation => operation !== undefined)
  const lastWrite = completed.findLastIndex(isWorkspaceWrite)
  const writeCount = operations.filter(isWorkspaceWrite).length
  const evidenceCount = completed.slice(lastWrite + 1)
    .filter(operation => operation.status === 'succeeded' && verificationTools.has(operation.tool)).length
  const input = {
    goal: evidence.goal, summary: evidence.summary.slice(0, 2000), checkConfigured: evidence.checkConfigured,
    evidenceCount, writeCount, failedCount: operations.filter(operation => operation.status === 'failed').length,
  }
  const points = [
    { id: 'turn.completion', eligible: !evidence.checkConfigured && lastWrite >= 0 && evidenceCount === 0,
      nudge: 'Before closing, verify the existing changes with an available local read or a check already authorized by the user. Keep the original requirements, including any instruction to skip tests. Do not add changes, seek approvals, or perform external actions in this verification pass. Report any remaining uncertainty.' },
    { id: 'turn.continue', eligible: true,
      nudge: 'Continue any unfinished work that the user already requested and the existing scope permits. Respect all original constraints. Use this continuation for local, reversible steps only and do not request new approvals, publish, push, delete, or perform external actions. If no such work remains, report the outcome.' },
  ] as const
  for (const point of points) {
    if (evidence.signal.aborted || evidence.attempted.has(point.id) || !point.eligible ||
      judgment.mode(point.id, event.taskId) === 'off') continue
    evidence.attempted.add(point.id)
    const followUp = await judgment.decide(event, point.id, input, false, [false, true],
      operations.slice(-8).map(operation => operation.id), { signal: evidence.signal })
    if (followUp && !evidence.signal.aborted) return point
  }
}
