import { basename } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { EventDraft } from './contracts/domain.ts'
import type { ExecutionTool } from './execution.ts'
import type { TaskEngine } from './task-engine.ts'
import type { ToolApprovalBroker } from './tool-approval.ts'
import { workspaceTarget } from './workspace.ts'
import type { CodingWorkspace, DeferredToolOperation, WorkspaceTool } from './workspace.ts'
import { redactProcessOutput } from './workspace-process.ts'

const unavailable = { ok: false, error: 'Tool work is unavailable' }

function redactResult(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactProcessOutput(value)
  if (!value || typeof value !== 'object') return value
  if (depth > 12) return undefined
  if (Array.isArray(value)) return value.map(item => redactResult(item, depth + 1))
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactResult(item, depth + 1)]))
}

export class ToolRun {
  readonly #deferred = new Map<string, { stop(): Promise<void>; settled: Promise<void> }>()
  readonly #cleanup = new Set<() => Promise<void>>()
  readonly #tasks: TaskEngine
  readonly #approval: ToolApprovalBroker
  #closed = false

  constructor(tasks: TaskEngine, approval: ToolApprovalBroker) {
    this.#tasks = tasks
    this.#approval = approval
  }

  wrap(tool: WorkspaceTool, workspace: CodingWorkspace, event: () => EventDraft, signal: AbortSignal,
    authorize: (input: unknown) => boolean, evidence?: Set<string>, artifacts?: Set<string>): ExecutionTool {
    return {
      name: tool.name, description: tool.description, parameters: tool.parameters,
      execute: async (callId, raw, toolSignal) => {
        let input: unknown
        try { input = structuredClone(raw) } catch { return unavailable }
        const combined = toolSignal ? AbortSignal.any([signal, toolSignal]) : signal
        if (this.#closed || combined.aborted || !authorize(input)) return unavailable
        const ref = event()
        const operationId = ref.agentRunId + ':' + callId
        const target = workspaceTarget(input)
        let destination: string | undefined
        if (tool.policy?.approval) {
          const detail = JSON.stringify(input) ?? 'null'
          if (detail.length > 8_000 || redactProcessOutput(detail) !== detail || /[\u202a-\u202e\u2066-\u2069]/u.test(detail)) {
            return { ok: false, error: 'The operation cannot be safely displayed for approval' }
          }
          const approval = await this.#approval.request({
            kind: tool.policy.approval, tool: tool.name, detail, workspace: workspace.root,
            ...(tool.policy.approval === 'export' && target ? { suggestedName: basename(target) } : {}),
          }, combined)
          this.#tasks.auditToolApproval(ref, operationId, tool.name, approval.approved && !combined.aborted)
          if (!approval.approved || this.#closed || combined.aborted || !authorize(input)) {
            return { ok: false, error: 'Operation was not authorized' }
          }
          destination = approval.destination
        }
        try {
          this.#tasks.beginTool(ref.taskId, ref, operationId, tool.name, tool.effect,
            tool.effect === 'write' ? target : undefined, undefined, tool.policy)
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
              deferred = true
              this.#register(operationId, ref, operation)
            },
            onCleanup: (cleanup) => {
              if (this.#closed || this.#cleanup.size >= 32) throw new Error('Tool resource capacity exhausted')
              this.#cleanup.add(cleanup)
            },
          })
        } catch {
          if (!deferred) this.#finish(ref, operationId, tool.effect === 'write' ? 'unknown_effect' : 'failed')
          return { ok: false, error: tool.effect === 'write' ? 'Write result requires reconciliation' : 'Tool failed' }
        }
        const successful = Boolean(result && typeof result === 'object' && 'ok' in result && result.ok === true)
        if (!deferred) this.#finish(ref, operationId, successful ? 'succeeded' : 'failed')
        if (!deferred && successful) {
          evidence?.add(operationId)
          if (target && (tool.name === 'read_text_file' || tool.effect === 'write')) artifacts?.add(target)
        }
        return redactResult(result)
      },
    }
  }

  #finish(event: EventDraft, id: string, status: 'succeeded' | 'failed' | 'unknown_effect') {
    if (this.#tasks.operations(event.taskId).some(operation => operation.id === id && operation.status === 'started')) {
      this.#tasks.finishTool(event, id, status)
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
