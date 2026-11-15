import { randomUUID } from 'node:crypto'
import type { ToolApprovalDecision, ToolApprovalRequest } from '../../shared/contracts/tool-approval.ts'

export type ToolApprover = (request: ToolApprovalRequest, signal: AbortSignal) => Promise<ToolApprovalDecision>

type Notice = { kind: 'tool.approval'; request: ToolApprovalRequest } | { kind: 'tool.approval_cancelled'; approvalId: string }
const denied: ToolApprovalDecision = { approved: false }

export class ToolApprovalBroker {
  readonly #pending = new Map<string, { resolve(result: ToolApprovalDecision): void; scope?: string; cancellation: AbortController }>()
  readonly #subscribers = new Set<(notice: Notice) => void>()
  readonly #approver?: ToolApprover

  constructor(approver?: ToolApprover) { this.#approver = approver }

  subscribe(listener: (notice: Notice) => void): () => void {
    this.#subscribers.add(listener)
    return () => { this.#subscribers.delete(listener) }
  }

  async request(details: Omit<ToolApprovalRequest, 'id'>, stop: AbortSignal, scope?: string): Promise<ToolApprovalDecision> {
    if (stop.aborted || this.#pending.size >= 8 || (!this.#approver && !this.#subscribers.size)) return denied
    const request = { ...details, id: randomUUID() }
    const cancellation = new AbortController()
    const signal = AbortSignal.any([stop, cancellation.signal, AbortSignal.timeout(60_000)])
    const result = Promise.withResolvers<ToolApprovalDecision>()
    const abort = () => {
      if (this.resolve(request.id, denied)) this.#notify({ kind: 'tool.approval_cancelled', approvalId: request.id })
    }
    this.#pending.set(request.id, { resolve: result.resolve, scope, cancellation })
    signal.addEventListener('abort', abort, { once: true })
    try {
      if (this.#approver) void Promise.resolve().then(() => this.#approver!(request, signal))
        .then(value => this.resolve(request.id, value), abort)
      else this.#notify({ kind: 'tool.approval', request })
      return await result.promise
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  cancelScope(scope: string): void {
    for (const pending of this.#pending.values()) {
      if (pending.scope === scope) pending.cancellation.abort()
    }
  }

  resolve(id: string, value: unknown): boolean {
    const pending = this.#pending.get(id)
    if (!pending) return false
    this.#pending.delete(id)
    const choice = value as Partial<{ approved: boolean; destination: string }> | null
    const destination = choice?.destination
    const valid = destination === undefined ||
      (typeof destination === 'string' && destination.length <= 4096 && !destination.includes('\0'))
    pending.resolve(choice?.approved === true && valid ? { approved: true, destination } : denied)
    return true
  }

  #notify(notice: Notice): void {
    for (const listener of this.#subscribers) {
      try { listener(notice) } catch { /* A disconnected approval client cannot authorize execution. */ }
    }
  }
}
