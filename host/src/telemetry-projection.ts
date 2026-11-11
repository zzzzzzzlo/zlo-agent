import { createHash } from 'node:crypto'
import { verificationVerdict } from '../../shared/contracts/domain.ts'
import type { VerificationResult } from '../../shared/contracts/domain.ts'
import type { TelemetryEvent, TelemetryTask, TelemetryVerification } from '../../shared/contracts/observatory.ts'
import { approvalKinds } from '../../shared/contracts/tool-approval.ts'
import type { AgentEvent } from './contracts/domain.ts'
import type { Attempt, TaskSnapshot } from './task-engine.ts'
import { redactProcessOutput } from './workspace-process.ts'

const states = 'ready running verifying succeeded failed blocked stop_requested stopping stopped needs_reconciliation interrupted unknown_effect started completed active idle released settled uncertain verified unresolved'.split(' ')
const reasons = 'user_stop host_shutdown process_interrupted model_error model_interrupted runtime_error verification_failed unknown_effect checkpoint_error stop_timeout budget_exhausted model_output_limit'.split(' ')
const roles = ['root', 'team', 'worker'] as const
const accessLevels = ['read', 'write', 'trusted'] as const
const verificationEvidence = 'workspace_text_file_exists workspace_file_contains_expected_text workspace_command_passed project_command_exit_zero project_command_not_authorized project_command_previous_result project_command_effect_unknown workspace_command_not_authorized workspace_write_active verification_interrupted workspace_command_unavailable workspace_command_failed workspace_file_unavailable workspace_file_missing_expected_text node_unknown_effect'.split(' ')
const points = 'collaboration.mode delegation.worth model.task_fit context.relevance handoff.sufficiency task.replan'.split(' ')
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu
const hashPattern = /^sha256:[0-9a-f]{64}$/u

export function telemetryDigest(value: string): string {
  return 'sha256:' + createHash('sha256').update(value).digest('hex')
}

export function isTaskId(value: unknown): value is string { return typeof value === 'string' && uuid.test(value) }
const ref = (value: unknown) => typeof value === 'string' && value.length <= 512
  ? uuid.test(value) || hashPattern.test(value) ? value : telemetryDigest(value) : undefined
const list = (value: unknown, limit = 128): unknown[] => Array.isArray(value) ? value.slice(0, limit) : []
const refs = (value: unknown) => list(value).map(ref).filter((value): value is string => value !== undefined)
const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined
const bool = (value: unknown) => typeof value === 'boolean' ? value : undefined
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]) => allowed.includes(value as T) ? value as T : undefined

function label(value: unknown) {
  if (typeof value !== 'string' || !/^[a-z\d][a-z\d._:/-]{0,127}$/iu.test(value)) return undefined
  if (/^(?:eyJ|sk[-_]|gh[pousr]_|github_pat_|AKIA)/u.test(value) || redactProcessOutput(value) !== value) return undefined
  return value
}

function route(value: unknown) {
  const record = obj(value)
  const provider = label(record.provider), model = label(record.model)
  return provider && model ? { provider, model } : undefined
}

export function telemetryVerification(value: unknown): TelemetryVerification | undefined {
  const p = obj(value)
  if (typeof p.passed !== 'boolean') return undefined
  const evidence = oneOf(p.evidence, verificationEvidence)
  const verdict = verificationVerdict({ passed: p.passed, evidence: evidence ?? '', verdict: p.verdict } as VerificationResult)
  return { verdict, passed: verdict === 'verified', basis: oneOf(p.basis, ['workspace_path', 'project_command', 'handoff', 'none']), evidence }
}

export function telemetryTask(task: TaskSnapshot, cursor: number, attempts: Attempt[]): TelemetryTask {
  return {
    id: task.id, taskRunId: task.taskRunId, rootNodeId: task.rootNodeId, status: task.status,
    reason: oneOf(task.reason, reasons), route: route(task.route), verification: telemetryVerification(task.verification),
    attemptCount: task.attemptCount, planVersion: task.planVersion, cursor,
    nodes: [...(task.worker ? [task.worker] : []), ...(task.nodes ?? [])].map(node => ({
      id: node.id, parentNodeId: node.parentNodeId, dependencies: node.dependencies ?? [], status: node.status,
      attemptId: node.attemptId, role: node.role ?? 'worker', route: route(node.route), verification: telemetryVerification(node.verification), replans: node.replans,
    })),
    attempts: attempts.map(attempt => ({ id: attempt.id, nodeId: attempt.nodeId, startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt, status: attempt.status, reason: oneOf(attempt.reason, reasons), recoveries: attempt.recoveries })),
  }
}

function judgment(p: Record<string, unknown>) {
  const choice = (value: unknown) => (value === -1 ? value : num(value)) ?? bool(value) ?? oneOf(value, ['worker', 'team']) ??
    (typeof value === 'string' && /^opaque:\d{1,2}$/u.test(value) ? value : undefined)
  const input = obj(p.features)
  const features: Record<string, unknown> = {}
  for (const key of ['nodeCount', 'nodeOrdinal', 'goalLength', 'evidenceCount', 'artifactCount', 'completedChildren', 'replanCount']) features[key] = num(input[key])
  for (const key of ['teamCandidate', 'hasDependencies', 'nonEmptyGoal', 'independent', 'requested', 'checked', 'checkPassed', 'hasWrite', 'isRootChild']) features[key] = bool(input[key])
  features.role = oneOf(input.role, roles)
  features.access = oneOf(input.access, accessLevels)
  features.status = oneOf(input.status, ['missing', ...states])
  if (Array.isArray(input.candidates)) features.candidates = list(input.candidates, 8).map(value => {
    const c = obj(value)
    return { index: num(c.index), providerKey: ref(c.providerKey), modelKey: ref(c.modelKey), contextWindow: num(c.contextWindow),
      supportsText: bool(c.supportsText), estimatedCost: num(c.estimatedCost), kind: oneOf(c.kind, ['fact', 'experience']),
      rank: num(c.rank), evidenceCount: num(c.evidenceCount), estimatedBytes: num(c.estimatedBytes) }
  })
  const link = obj(p.resultLink), usage = obj(p.usage)
  return { id: oneOf(p.id, points), schemaVersion: 1, featureSchemaVersion: num(p.featureSchemaVersion),
    mode: oneOf(p.mode, ['off', 'shadow', 'active']), baseline: choice(p.baseline), output: choice(p.output), shadow: choice(p.shadow),
    candidates: list(p.candidates, 16).map(choice).filter(value => value !== undefined), features, evidenceRefs: refs(p.evidenceRefs),
    resultLink: { taskRunId: ref(link.taskRunId), taskNodeId: ref(link.taskNodeId), taskAttemptId: ref(link.taskAttemptId),
      agentRunId: ref(link.agentRunId), planRequestId: ref(link.planRequestId), delegationReceiptKey: ref(link.delegationReceiptKey) },
    elapsedMs: num(p.elapsedMs), judgeStatus: oneOf(p.judgeStatus, ['baseline', 'valid', 'invalid', 'failed', 'timed_out', 'busy']),
    usage: p.usage === undefined ? undefined : { input: num(usage.input), output: num(usage.output), estimatedCostUsd: num(usage.estimatedCostUsd) } }
}

function safePayload(type: string, p: Record<string, unknown>): Record<string, unknown> | undefined {
  const status = oneOf(p.status, states), reason = oneOf(p.reason, reasons)
  switch (type) {
    case 'task.created': case 'task.state_changed': case 'task.stop_requested': case 'task.stopped': case 'task.resumed':
      return { previous: oneOf(p.previous, states), status, reason }
    case 'task.plan_changed': return {
      version: num(p.version), workerNodeId: ref(p.workerNodeId), replannedNodeId: ref(p.replannedNodeId), dependencies: refs(p.dependencies),
      nodes: list(p.nodes).map(value => {
        const node = obj(value)
        return { id: ref(node.id), parentNodeId: ref(node.parentNodeId), dependencies: refs(node.dependencies),
          role: oneOf(node.role, roles), access: oneOf(node.access, accessLevels) }
      }),
    }
    case 'task.node_started': case 'task.node_settled': case 'task.worker_settled': return {
      status, parentNodeId: ref(p.parentNodeId), role: oneOf(p.role, roles), worktreeId: ref(p.worktreeId),
      attemptStatus: oneOf(p.attemptStatus, states), executionStatus: oneOf(p.executionStatus, ['completed', 'failed']),
      evidenceRefs: refs(p.evidenceRefs), verification: telemetryVerification(p.verification),
    }
    case 'agent.started': case 'agent.finished': return { status, reason, role: oneOf(p.role, roles), route: route(p.route),
      parentAgentId: ref(p.parentAgentId), lifecycle: oneOf(p.lifecycle, states), evidenceCount: num(p.evidenceCount) }
    case 'model.request_started': return {}
    case 'model.output_recovery': return { trigger: oneOf(p.trigger, ['automatic', 'resume']) }
    case 'model.route_changed': case 'model.switch_requested': return { route: route(p.route) }
    case 'model.reserved': case 'model.reservation_settled': return { status, route: route(p.route), kind: oneOf(p.kind, ['prompt', 'compaction']),
      estimatedTokens: num(p.estimatedTokens), actualTokens: num(p.actualTokens), estimatedCostUsd: num(p.estimatedCostUsd),
      estimatedInputTokens: num(p.estimatedInputTokens), maxOutputTokens: num(p.maxOutputTokens), taskTokenLimit: num(p.taskTokenLimit), durationMs: num(p.durationMs) }
    case 'model.usage': return { input: num(p.input), output: num(p.output), cacheRead: num(p.cacheRead), cacheWrite: num(p.cacheWrite), estimatedCostUsd: num(p.estimatedCostUsd) }
    case 'tool.started': case 'tool.finished': case 'tool.approval_resolved': case 'tool.denied':
      return { id: ref(p.id), tool: label(p.tool), effect: oneOf(p.effect, ['read', 'write']), status, managed: bool(p.managed), approved: bool(p.approved),
        reason: oneOf(p.reason, ['policy', 'approval_safety', 'tool_result_failed', 'tool_exception', 'nonzero_exit', 'tool_cancelled']),
        approvalKind: oneOf(p.approvalKind, approvalKinds) }
    case 'task.permissions_changed': return { access: oneOf(p.access, accessLevels), previousAccess: oneOf(p.previousAccess, accessLevels) }
    case 'operation.reconciliation_required': case 'operation.reconciliation_checked': return { status, reason,
      operationId: ref(p.operationId), operationIds: refs(p.operationIds), changedEntries: num(p.changedEntries), truncated: bool(p.truncated) }
    case 'verification.finished': return { ...telemetryVerification(p), executionStatus: oneOf(p.executionStatus, ['completed', 'failed']) }
    case 'context.compacted': return { tokensBefore: num(p.tokensBefore), estimatedTokensAfter: num(p.estimatedTokensAfter) }
    case 'memory.captured': case 'memory.recalled': return { count: num(p.count), elapsedMs: num(p.elapsedMs),
      contextBytes: num(p.contextBytes), budgetBytes: num(p.budgetBytes), entries: list(p.entries).map(value => {
      const entry = obj(value)
      return { memoryId: ref(entry.memoryId), version: num(entry.version), kind: oneOf(entry.kind, ['fact', 'experience']) }
    }) }
    case 'judgment.evaluated': return judgment(p)
  }
}

export function telemetryEvent(event: AgentEvent): TelemetryEvent {
  const payload = safePayload(event.type, event.payload)
  return { schemaVersion: 1, id: event.id, seq: event.seq, occurredAt: event.occurredAt, taskId: event.taskId,
    type: payload ? event.type : 'telemetry.redacted', payload: payload ?? {}, taskRunId: ref(event.taskRunId),
    taskNodeId: ref(event.taskNodeId), taskAttemptId: ref(event.taskAttemptId), agentId: ref(event.agentId),
    agentRunId: ref(event.agentRunId), parentAgentRunId: ref(event.parentAgentRunId),
    correlationId: ref(event.correlationId), causationId: ref(event.causationId) }
}
