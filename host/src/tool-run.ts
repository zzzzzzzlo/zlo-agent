import { basename } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { EventDraft } from './contracts/domain.ts'
import type { ExecutionTool } from './execution.ts'
import { toolImages } from './execution.ts'
import type { LocalJudgment } from './judgment.ts'
import type { TaskEngine, ToolFailureReason } from './task-engine.ts'
import type { ToolApprovalBroker } from './tool-approval.ts'
import { workspaceTarget } from './workspace.ts'
import type { CodingWorkspace, DeferredToolOperation, WorkspaceTool } from './workspace.ts'
import { redactProcessOutput } from './workspace-process.ts'
import { prepareFilePostcondition } from './reconciliation.ts'
import { judgeToolResult } from './tool-judgment.ts'
import type { ToolEvidenceArchive } from './tool-judgment.ts'

const unavailable = { ok: false, error: 'Tool work is unavailable' }

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
  readonly #deferred = new Map<string, { stop(): Promise<void>; settled: Promise<void> }>()
  readonly #cleanup = new Set<() => Promise<void>>()
  readonly #tasks: TaskEngine
  readonly #approval: ToolApprovalBroker
  #evidenceReplayAvailable = false
  readonly #judgment?: LocalJudgment
  readonly #archive?: ToolEvidenceArchive
  readonly #evidenceAccess = new Map<string, () => boolean>()
  #closed = false

  constructor(tasks: TaskEngine, approval: ToolApprovalBroker, judgment?: LocalJudgment, archive?: ToolEvidenceArchive) {
    this.#tasks = tasks
    this.#approval = approval
    this.#judgment = judgment
    this.#archive = archive
  }

  wrap(tool: WorkspaceTool, workspace: CodingWorkspace, event: () => EventDraft, signal: AbortSignal,
    authorize: (input: unknown) => boolean, evidence?: Set<string>, artifacts?: Set<string>, goal = ''): ExecutionTool {
    return {
      name: tool.name, description: tool.description, parameters: tool.parameters,
      execute: async (callId, raw, toolSignal) => {
        let input: unknown
        try { input = structuredClone(raw) } catch { return unavailable }
        const combined = toolSignal ? AbortSignal.any([signal, toolSignal]) : signal
        if (this.#closed || combined.aborted) return unavailable
        const ref = event()
        let effect = tool.effect
        const deny = (reason: 'policy' | 'approval_safety') => {
          try { this.#tasks.auditToolDenial(ref, tool.name, effect, reason) } catch { /* A diagnostic cannot change a denial. */ }
        }
        let approvalKind
        try {
          effect = tool.policy?.effectFor?.(input) ?? effect
          approvalKind = tool.policy?.approvalFor?.(input) ?? tool.policy?.approval
        } catch { deny('policy'); return unavailable }
        if (!authorize(input)) { deny('policy'); return unavailable }
        const operationId = ref.agentRunId + ':' + callId
        const target = workspaceTarget(input)
        let destination: string | undefined
        if (approvalKind) {
          const detail = JSON.stringify(input) ?? 'null'
          if (detail.length > 8_000 || redactProcessOutput(detail) !== detail || /[\u202a-\u202e\u2066-\u2069]/u.test(detail)) {
            deny('approval_safety')
            return { ok: false, error: 'The operation cannot be safely displayed for approval' }
          }
          const approval = await this.#approval.request({
            kind: approvalKind, tool: tool.name, detail, workspace: workspace.root,
            ...(approvalKind === 'export' && target ? { suggestedName: basename(target) } : {}),
          }, combined)
          this.#tasks.auditToolApproval(ref, operationId, tool.name, approval.approved && !combined.aborted, approvalKind)
          if (!approval.approved || this.#closed || combined.aborted || !authorize(input)) {
            return { ok: false, error: 'Operation was not authorized' }
          }
          destination = approval.destination
        }
        try {
          const filePostcondition = tool.name === 'create_text_file'
            ? await prepareFilePostcondition(tool.name, workspace, target, input) : undefined
          if (this.#closed || combined.aborted || !authorize(input)) return unavailable
          this.#tasks.beginTool(ref.taskId, ref, operationId, tool.name, effect,
            effect === 'write' ? target : undefined, undefined, tool.policy, filePostcondition)
        } catch {
          return unavailable
        }
        let deferred = false
        let result: unknown
        try {
          result = await tool.execute(callId, input, combined, {
            taskId: ref.taskId, agentRunId: ref.agentRunId!, destination,
            defer: (operation) => {
              if (!tool.policy?.deferred || deferred || this.#closed) throw new Error('Deferred operation not permitted')
              if (operation.pid !== undefined) this.#tasks.attachProcess(ref.taskId, operationId, operation.pid)
              deferred = true
              this.#register(operationId, ref, operation)
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
          evidence?.add(operationId)
          if (target && (tool.name === 'read_text_file' || tool.name === 'view_image' || effect === 'write')) artifacts?.add(target)
        }
        const safeResult = redactResult(result)
        if (!this.#archive || !this.#judgment || !successful || deferred || effect !== 'read') return safeResult
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
    return {
      name: 'read_tool_evidence',
      description: 'Read retained, redacted output for an evidenceId from one of your current run’s authorized tools. Quarantined content stays withheld.',
      parameters: { type: 'object', additionalProperties: false, required: ['evidenceId'],
        properties: { evidenceId: { type: 'string', minLength: 36, maxLength: 36 } } },
      execute: async (_id, input, toolSignal) => {
        if (this.#closed || signal.aborted || toolSignal?.aborted || !input || typeof input !== 'object' ||
          !('evidenceId' in input) || typeof input.evidenceId !== 'string') return unavailable
        const authorized = this.#evidenceAccess.get(input.evidenceId)
        if (!authorized) return unavailable
        try {
          return archive.replay(event(), input.evidenceId, tool => sourceAllowed(tool) && authorized()) ?? unavailable
        } catch { return unavailable }
      },
    }
  }

  #finish(event: EventDraft, id: string, status: 'succeeded' | 'failed' | 'unknown_effect', reason?: ToolFailureReason,
    changedPaths?: readonly string[]) {
    if (this.#tasks.operations(event.taskId).some(operation => operation.id === id && operation.status === 'started')) {
      this.#tasks.finishTool(event, id, status, reason, changedPaths)
    }
  }

  #register(id: string, event: EventDraft, operation: DeferredToolOperation): void {
    const settled = operation.completion.catch(() => 'unknown_effect' as const)
      .then(status => this.#finish(event, id, status)).finally(() => this.#deferred.delete(id))
    this.#deferred.set(id, { stop: () => operation.stop(), settled })
    void settled.catch(() => {})
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#evidenceAccess.clear()
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
