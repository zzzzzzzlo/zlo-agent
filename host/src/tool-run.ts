import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { EventDraft } from './contracts/domain.ts'
import type { ToolApprovalMode } from '../../shared/contracts/tool-approval.ts'
import type { ExecutionTool } from './execution.ts'
import { toolImages } from './execution.ts'
import type { LocalJudgment } from './judgment.ts'
import type { TaskEngine, ToolFailureReason } from './task-engine.ts'
import type { ToolApprovalBroker } from './tool-approval.ts'
import { workspaceTarget } from './workspace.ts'
import type { CodingWorkspace, DeferredToolOperation, WorkspaceLease, WorkspaceTool } from './workspace.ts'
import { redactProcessOutput } from './workspace-process.ts'
import { prepareFilePostcondition } from './reconciliation.ts'
import { evaluateToolExecutionPolicy } from './execution-policy.ts'
import { judgeToolResult } from './tool-judgment.ts'
import type { ToolEvidenceArchive } from './tool-judgment.ts'
import type { WorkspaceAccess } from './contracts/domain.ts'

const unavailable = { ok: false, error: 'Tool work is unavailable' }
const failureLimit = 4 // Initial call plus three retries.
const retryAdvice = 'Read the last tool error and correct the arguments or choose another approach. Re-read the current file before retrying an exact text edit.'

function callFingerprint(tool: string, input: unknown): string | undefined {
  try {
    const json = JSON.stringify(input, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)
    return createHash('sha256').update(tool).update('\0').update(json ?? '').digest('hex')
  } catch { return undefined }
}

function normalizedPaths(paths: unknown[]): string[] {
  return paths.flatMap(path => {
    const normalized = workspaceTarget({ path })
    return normalized === undefined ? [] : [process.platform === 'win32' ? normalized.toLowerCase() : normalized]
  })
}

function toolPaths(tool: WorkspaceTool, input: unknown): string[] {
  try { return normalizedPaths(tool.policy?.targets?.(input) ?? [workspaceTarget(input)]) }
  catch { return [] }
}

function writeProgress(tool: WorkspaceTool, input: unknown, result: unknown): string[] {
  if (tool.policy?.approval === 'export') return []
  if (result && typeof result === 'object' && 'changed' in result) {
    if (result.changed === false) return []
    if (Array.isArray(result.changed)) return normalizedPaths(result.changed)
  }
  return toolPaths(tool, input)
}

function redactResult(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactProcessOutput(value).replace(/\boc_sk_[\w-]{16,}/gu, '[redacted]')
  if (!value || typeof value !== 'object') return value
  if (depth > 12) return undefined
  if (Array.isArray(value)) return value.map(item => redactResult(item, depth + 1))
  const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactResult(item, depth + 1)]))
  if (depth === 0 && toolImages in value && value[toolImages]) return { ...result, [toolImages]: value[toolImages] }
  return result
}

export class ToolRun {
  readonly #deferred = new Map<string, { stop(): Promise<void>; settled: DeferredToolOperation['completion'] }>()
  readonly #cleanup = new Set<() => Promise<void>>()
  readonly #tasks: TaskEngine
  readonly #approval: ToolApprovalBroker
  #evidenceReplayAvailable = false
  readonly #judgment?: LocalJudgment
  readonly #archive?: ToolEvidenceArchive
  readonly #onRepeatedFailure: () => void
  readonly #approvalMode: () => ToolApprovalMode
  readonly #approvalContext?: (taskId: string) => { conversationId?: string; conversationTitle?: string } | undefined
  readonly #evidenceAccess = new Map<string, () => boolean>()
  readonly #failures = new Map<string, { count: number; paths: string[] }>()
  #closed = false

  constructor(tasks: TaskEngine, approval: ToolApprovalBroker, judgment?: LocalJudgment, archive?: ToolEvidenceArchive,
    onRepeatedFailure: () => void = () => {}, approvalMode: () => ToolApprovalMode = () => 'ask',
    approvalContext?: (taskId: string) => { conversationId?: string; conversationTitle?: string } | undefined) {
    this.#tasks = tasks
    this.#approval = approval
    this.#judgment = judgment
    this.#archive = archive
    this.#onRepeatedFailure = onRepeatedFailure
    this.#approvalMode = approvalMode
    this.#approvalContext = approvalContext
  }

  guard(tool: ExecutionTool, event: () => EventDraft, signal: AbortSignal, workspaceTool?: WorkspaceTool): ExecutionTool {
    return { ...tool, execute: async (id, input, toolSignal) => {
      if (this.#closed || signal.aborted || toolSignal?.aborted) return unavailable
      const key = callFingerprint(tool.name, input)
      const previous = key ? this.#failures.get(key) : undefined
      if (previous && previous.count >= failureLimit) {
        let effect = workspaceTool?.effect ?? 'read'
        try { effect = workspaceTool?.policy?.effectFor?.(input) ?? effect } catch { /* Use the declared effect. */ }
        try { this.#tasks.auditToolDenial(event(), tool.name, effect, 'repeated_failure') }
        catch { /* A diagnostic cannot re-enable the call. */ }
        this.#onRepeatedFailure()
        return { ok: false, error: 'Repeated tool failure. This unchanged call was blocked.', retryAdvice }
      }
      const result = await tool.execute(id, input, toolSignal)
      if (!key || this.#closed || signal.aborted || toolSignal?.aborted || !result ||
        typeof result !== 'object' || !('ok' in result)) return result
      if (result.ok === true && !workspaceTool?.policy?.deferred) this.#failures.delete(key)
      if (result.ok !== false) return result
      const count = this.#recordFailure(key, workspaceTool ? toolPaths(workspaceTool, input) : [])
      return count === failureLimit ? { ...result, retryAdvice } : result
    } }
  }

  #recordFailure(key: string, paths: string[]): number {
    const count = (this.#failures.get(key)?.count ?? 0) + 1
    this.#failures.delete(key)
    this.#failures.set(key, { count, paths })
    if (this.#failures.size > 256) this.#failures.delete(this.#failures.keys().next().value!)
    return count
  }

  #resetRelatedFailures(changes: string[]) {
    for (const [key, { paths }] of this.#failures) {
      if (changes.some(change => paths.some(path =>
        path === change || path.startsWith(change + '/') || change.startsWith(path + '/')))) this.#failures.delete(key)
    }
  }

  #effectiveAccess(taskId: string, taskNodeId?: string): WorkspaceAccess {
    const taskSnapshot = this.#tasks.getMeta(taskId)
    const node = taskNodeId ? this.#tasks.getNode(taskId, taskNodeId) : undefined
    return taskSnapshot.workspaceAccess === 'trusted' && (!node || node.access === 'trusted')
      ? 'trusted' : (node?.access ?? taskSnapshot.workspaceAccess ?? (taskSnapshot.check ? 'write' : 'read'))
  }

  wrap(tool: WorkspaceTool, workspace: CodingWorkspace, event: () => EventDraft, signal: AbortSignal,
    authorize: (input: unknown) => boolean, evidence?: Set<string>, artifacts?: Set<string>, goal = '', scopePath?: string): ExecutionTool {
    return {
      name: tool.name, description: tool.description, parameters: tool.parameters,
      execute: async (callId, raw, toolSignal) => {
        let input: unknown
        try { input = structuredClone(raw) } catch { return unavailable }
        const combined = toolSignal ? AbortSignal.any([signal, toolSignal]) : signal
        if (this.#closed || combined.aborted) return unavailable
        const ref = event()
        let effect: 'read' | 'write' = 'write'
        const deny = (reason: 'policy' | 'approval_safety' | 'approval_unattended') => {
          try { this.#tasks.auditToolDenial(ref, tool.name, effect, reason) } catch { /* A diagnostic cannot change a denial. */ }
        }
        let approvalKind
        let selectsWorktree = false
        try {
          const rawEffect = tool.policy?.effectFor?.(input) ?? tool.effect
          // Treat any non-'read' or indeterminate effect conservatively as an exclusive write.
          effect = rawEffect === 'read' ? 'read' : 'write'
          approvalKind = tool.policy?.approvalFor?.(input) ?? tool.policy?.approval
          selectsWorktree = tool.policy?.selectsTaskWorkspace?.(input) === true
        } catch { deny('policy'); return unavailable }
        if (!authorize(input)) { deny('policy'); return unavailable }
        const fingerprint = callFingerprint(tool.name, input)
        const target = workspaceTarget(input, effect)
        if (effect === 'write' && this.#tasks.hasUnconfirmedReplay(ref.taskId, tool.name, target, fingerprint)) {
          deny('policy')
          return { ok: false, code: 'REPLAY_BLOCKED', error: 'A previous invocation of this write operation had an unconfirmed effect and cannot be replayed automatically. Inspect current workspace state first or ask the user before making a new change.' }
        }
        if (tool.name === 'shell_exec' && fingerprint && this.#tasks.hasInterruptedShellReplay(ref.taskId, fingerprint)) {
          deny('policy')
          return { ok: false, code: 'REPLAY_BLOCKED', error: 'This shell invocation was interrupted and may have partially changed state. Inspect its output and use a targeted recovery command or a fresh output directory.' }
        }
        const blocked = this.#tasks.toolWorkBlock(ref, tool.name, effect, tool.policy)
        if (blocked) {
          deny('policy')
          return blocked === 'unconfirmed_write'
            ? { ok: false, code: 'UNCONFIRMED_WRITE', error: 'A previous write may have partially completed. Inspect the workspace or captured process output with read-only tools. Do not rerun the operation. If the result remains unknown, direct the user to Reconcile unknown operations in Diagnostics. Sending another message or changing approval mode does not resolve this receipt.' }
            : { ok: false, code: 'ACTIVE_WRITE', error: 'A workspace operation is in progress. For your shell command, read its process status or output before making another change.' }
        }
        const operationId = ref.agentRunId + ':' + callId
        const effectiveAccess = this.#effectiveAccess(ref.taskId, ref.taskNodeId)
        const policyResult = evaluateToolExecutionPolicy({
          tool: tool.name,
          effect,
          approvalKind,
          input,
          effectiveAccess,
          approvalMode: this.#approvalMode(),
          publicRead: tool.policy?.publicRead,
        })
        let destination: string | undefined
        if (policyResult.decision === 'deny') {
          deny(policyResult.reason)
          return policyResult.reason === 'approval_safety'
            ? { ok: false, error: 'The operation cannot be safely displayed for approval' }
            : unavailable
        }
        if (policyResult.decision === 'allow') {
          if (policyResult.automatic && approvalKind) {
            this.#tasks.auditToolApproval(ref, operationId, tool.name, true, approvalKind, true)
          }
        } else {
          if (this.#approvalMode() === 'unattended') {
            deny('approval_unattended')
            return { ok: false, error: 'This operation requires separate user approval. Unattended mode declined it; use an already authorized alternative.' }
          }
          let contextMeta: { conversationId?: string; conversationTitle?: string } | undefined
          try {
            contextMeta = this.#approvalContext?.(ref.taskId) ?? { conversationId: this.#tasks.getMeta(ref.taskId).conversationId }
          } catch { /* Approval metadata is best-effort. */ }
          const approval = await this.#approval.request({
            kind: approvalKind!, tool: tool.name, detail: JSON.stringify(input) ?? 'null', workspace: workspace.root,
            ...(contextMeta?.conversationId ? { conversationId: contextMeta.conversationId } : {}),
            ...(contextMeta?.conversationTitle ? { conversationTitle: contextMeta.conversationTitle } : {}),
            ...(approvalKind === 'export' && target ? { suggestedName: basename(target) } : {}),
          }, combined, ref.taskId)
          const approved = approval.approved && !this.#closed && !combined.aborted && authorize(input)
          this.#tasks.auditToolApproval(ref, operationId, tool.name, approved, approvalKind!)
          if (!approved) return { ok: false, code: 'APPROVAL_NOT_GRANTED', error: 'Operation was not authorized. It did not run. Use an already authorized alternative or explain which step needs approval.' }
          destination = approval.approved ? approval.destination : undefined
        }
        let lease: WorkspaceLease | undefined
        try {
          if (!selectsWorktree) {
            lease = await workspace.acquireLease(effect, { ownerId: ref.agentRunId, signal: combined })
          }
          const postconditionAccess = this.#effectiveAccess(ref.taskId, ref.taskNodeId)
          const filePostcondition = effect === 'write'
            ? await prepareFilePostcondition(tool.name, workspace, target, input, postconditionAccess) : undefined
          if (this.#closed || combined.aborted || !authorize(input)) {
            lease?.release()
            return unavailable
          }
          this.#tasks.beginTool(ref.taskId, ref, operationId, tool.name, effect,
            effect === 'write' ? target : undefined, undefined, tool.policy, filePostcondition, fingerprint)
        } catch {
          lease?.release()
          return unavailable
        }
        let deferred = false
        let result: unknown
        try {
          result = await tool.execute(callId, input, combined, {
            taskId: ref.taskId, agentRunId: ref.agentRunId!, destination,
            ...(scopePath ? { scopePath } : {}),
            defer: (operation) => {
              if (!tool.policy?.deferred || deferred || this.#closed) throw new Error('Deferred operation not permitted')
              if (operation.pid !== undefined) this.#tasks.attachProcess(ref.taskId, operationId, operation.pid)
              deferred = true
              const heldLease = lease
              lease = undefined
              this.#register(operationId, ref, operation, callFingerprint(tool.name, input), toolPaths(tool, input), combined, heldLease)
            },
            onCleanup: (cleanup) => {
              if (this.#closed || this.#cleanup.size >= 32) throw new Error('Tool resource capacity exhausted')
              this.#cleanup.add(cleanup)
            },
          })
        } catch {
          if (!deferred) this.#finish(ref, operationId, effect === 'write' ? 'unknown_effect' : 'failed',
            combined.aborted ? 'tool_cancelled' : 'tool_exception')
          return { ok: false, error: effect === 'write' ? 'Write result requires reconciliation' : 'Tool failed' }
        } finally {
          if (!deferred) lease?.release()
        }
        const successful = Boolean(result && typeof result === 'object' && 'ok' in result && result.ok === true)
        if (!deferred) {
          const reason = successful ? undefined : combined.aborted ? 'tool_cancelled'
            : result && typeof result === 'object' && 'exitCode' in result && typeof result.exitCode === 'number' && result.exitCode !== 0
              ? 'nonzero_exit' : 'tool_result_failed'
          const changedPaths = successful && tool.name === 'apply_patch' && result && typeof result === 'object' &&
            'changed' in result && Array.isArray(result.changed)
            ? result.changed.slice(0, 12).flatMap(path => workspaceTarget({ path }) ?? []) : undefined
          this.#finish(ref, operationId, successful ? 'succeeded' : 'failed', reason, changedPaths)
        }
        if (!deferred && successful) {
          if (effect === 'write') this.#resetRelatedFailures(writeProgress(tool, input, result))
          evidence?.add(operationId)
          if (target && (tool.name === 'read_text_file' || tool.name === 'view_image' || effect === 'write')) artifacts?.add(target)
        }
        const safeResult = redactResult(result)
        if (!this.#archive || !this.#judgment || deferred || (effect !== 'read' && tool.name !== 'run_project_command')) return safeResult
        const judged = await judgeToolResult(this.#judgment, this.#archive, ref, operationId, tool.name, goal, safeResult, combined,
          this.#evidenceReplayAvailable)
        if (this.#closed || combined.aborted || !authorize(input)) return unavailable
        if (judged.archiveId) {
          this.#evidenceAccess.set(judged.archiveId, () => authorize(input))
          if (this.#evidenceAccess.size > 64) this.#evidenceAccess.delete(this.#evidenceAccess.keys().next().value!)
        }
        return judged.value
      },
    }
  }

  replayTool(event: () => EventDraft, signal: AbortSignal, sourceAllowed: (tool: string) => boolean): ExecutionTool | undefined {
    const archive = this.#archive
    if (!archive) return
    this.#evidenceReplayAvailable = true
    const defaultReplayPageChars = 16_000
    const maxReplayPageChars = 32_000
    const maxEvidenceChars = 512_000
    return {
      name: 'read_tool_evidence',
      description: 'Read retained, redacted output for an evidenceId from one of your current run’s authorized tools. Pass optional offset and maxChars to paginate large evidence. Quarantined content stays withheld.',
      parameters: { type: 'object', additionalProperties: false, required: ['evidenceId'],
        properties: {
          evidenceId: { type: 'string', minLength: 36, maxLength: 36 },
          offset: { type: 'integer', minimum: 0, maximum: maxEvidenceChars },
          maxChars: { type: 'integer', minimum: 256, maximum: maxReplayPageChars },
        } },
      execute: async (_id, input, toolSignal) => {
        if (this.#closed || signal.aborted || toolSignal?.aborted || !input || typeof input !== 'object' || Array.isArray(input) ||
          !('evidenceId' in input) || typeof input.evidenceId !== 'string') return unavailable
        if (Object.keys(input).some(key => key !== 'evidenceId' && key !== 'offset' && key !== 'maxChars')) {
          return { ok: false, error: 'Invalid evidence replay arguments' }
        }
        const rawOffset = 'offset' in input ? input.offset : undefined
        const rawMaxChars = 'maxChars' in input ? input.maxChars : undefined
        if (rawOffset !== undefined && (typeof rawOffset !== 'number' || !Number.isSafeInteger(rawOffset) || rawOffset < 0 || rawOffset > maxEvidenceChars)) {
          return { ok: false, error: 'Invalid evidence replay arguments' }
        }
        if (rawMaxChars !== undefined && (typeof rawMaxChars !== 'number' || !Number.isSafeInteger(rawMaxChars) || rawMaxChars < 256 || rawMaxChars > maxReplayPageChars)) {
          return { ok: false, error: 'Invalid evidence replay arguments' }
        }
        const authorized = this.#evidenceAccess.get(input.evidenceId)
        if (!authorized) return unavailable
        try {
          const replayed = archive.replay(event(), input.evidenceId, tool => sourceAllowed(tool) && authorized())
          if (!replayed) return unavailable
          const serialized = JSON.stringify(replayed) ?? 'null'
          if (rawOffset === undefined && rawMaxChars === undefined && serialized.length <= defaultReplayPageChars) {
            return replayed
          }
          const start = rawOffset ?? 0
          const limit = rawMaxChars ?? defaultReplayPageChars
          if (start > serialized.length) {
            return { ok: false, error: 'Offset is past the end of the archived evidence', totalLength: serialized.length }
          }
          let end = Math.min(serialized.length, start + limit)
          if (end < serialized.length && end > start) {
            const code = serialized.charCodeAt(end - 1)
            if (code >= 0xd800 && code <= 0xdbff) end--
          }
          const content = serialized.slice(start, end)
          const hasMore = end < serialized.length
          const truncated = start > 0 || hasMore
          return {
            ok: true,
            ...(replayed.untrusted === true ? { untrusted: true } : {}),
            evidenceId: input.evidenceId,
            offset: start,
            length: content.length,
            totalLength: serialized.length,
            truncated,
            hasMore,
            ...(hasMore ? { nextOffset: end, note: 'Evidence output paginated; pass offset: nextOffset to read the remaining content.' } : {}),
            content,
          }
        } catch { return unavailable }
      },
    }
  }

  #finish(event: EventDraft, id: string, status: Awaited<DeferredToolOperation['completion']>, reason?: ToolFailureReason,
    changedPaths?: readonly string[]) {
    if (this.#tasks.hasOpenOperation(id)) {
      this.#tasks.finishTool(event, id, status, reason, changedPaths)
    }
  }

  #register(id: string, event: EventDraft, operation: DeferredToolOperation, key: string | undefined, paths: string[],
    signal: AbortSignal, lease?: WorkspaceLease): void {
    const settled = operation.completion.catch(() => 'unknown_effect' as const)
      .then(status => {
        this.#finish(event, id, status, status === 'interrupted' ? 'tool_cancelled' : undefined)
        if (key && !this.#closed && !signal.aborted) {
          if (status === 'failed') this.#recordFailure(key, paths)
          if (status === 'succeeded') this.#failures.delete(key)
        }
        return status
      }).finally(() => {
        lease?.release()
        this.#deferred.delete(id)
      })
    this.#deferred.set(id, { stop: () => operation.stop(), settled })
    void settled.catch(() => {})
  }

  async waitForDeferred(signal: AbortSignal): Promise<Awaited<DeferredToolOperation['completion']>[]> {
    if (signal.aborted || !this.#deferred.size) return []
    const aborted = Promise.withResolvers<[]>()
    const abort = () => aborted.resolve([])
    signal.addEventListener('abort', abort, { once: true })
    try {
      const receipts = Promise.all([...this.#deferred.values()].map(resource => resource.settled))
      return await Promise.race([receipts, aborted.promise])
    } finally { signal.removeEventListener('abort', abort) }
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#evidenceAccess.clear()
    this.#failures.clear()
    const work = [...this.#deferred.values()].map(async resource => {
      await resource.stop()
      await resource.settled
    })
    for (const cleanup of this.#cleanup) work.push(Promise.resolve().then(cleanup))
    this.#cleanup.clear()
    const timer = new AbortController()
    try {
      const result = await Promise.race([
        Promise.allSettled(work),
        delay(7_000, undefined, { signal: timer.signal, ref: false }),
      ])
      if (!result || result.some(item => item.status === 'rejected')) throw new Error('Tool resources did not settle')
    } finally {
      timer.abort()
    }
  }
}
