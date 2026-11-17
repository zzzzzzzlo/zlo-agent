import type { VerificationResult } from './contracts/domain.ts'
import type { WorkerNode, WorkerResult } from './task-engine.ts'

export interface NodeCompletionNotification {
  eventKey: string
  nodeId: string
  parentNodeId: string
  role: 'team' | 'worker'
  goal: string
  status: WorkerNode['status']
  attemptId?: string
  failureReason?: string
  result?: WorkerResult
  verification?: VerificationResult
}

export function nodeEventKey(node: Pick<WorkerNode, 'id' | 'attemptId' | 'status'>): string {
  return `${node.id}:${node.attemptId ?? ''}:${node.status}`
}

export function nodeFailureReason(node: Pick<WorkerNode, 'status' | 'result' | 'verification'>): string | undefined {
  if (node.status !== 'failed') return undefined
  if (node.verification && !node.verification.passed && node.verification.evidence) return node.verification.evidence
  return node.result?.remainingRisks[0] ?? 'worker_failed'
}

export function notificationFromNode(node: WorkerNode): NodeCompletionNotification {
  const failureReason = nodeFailureReason(node)
  return {
    eventKey: nodeEventKey(node),
    nodeId: node.id,
    parentNodeId: node.parentNodeId,
    role: node.role ?? 'worker',
    goal: node.goal,
    status: node.status,
    ...(node.attemptId ? { attemptId: node.attemptId } : {}),
    ...(failureReason ? { failureReason } : {}),
    ...(node.result ? { result: node.result } : {}),
    ...(node.verification ? { verification: node.verification } : {}),
  }
}

export function formatMailboxPrompt(notifications: readonly NodeCompletionNotification[], scopeNodes: readonly WorkerNode[]): string {
  const settled = notifications.map(({ nodeId, parentNodeId, role, status, failureReason, result, verification }) => ({
    nodeId,
    parentNodeId,
    role,
    status,
    ...(failureReason ? { failureReason } : {}),
    result,
    verification,
  }))
  const dag = scopeNodes.map(({ id, parentNodeId, role, status, dependencies, verification }) => ({
    nodeId: id,
    parentNodeId,
    role: role ?? 'worker',
    status,
    ...(dependencies.length ? { dependencies } : {}),
    ...(verification ? { verdict: verification.verdict, evidence: verification.evidence } : {}),
  }))
  return [
    'Child node completion events (event-driven update):',
    JSON.stringify(settled).slice(0, 8000),
    'Latest DAG status in scope:',
    JSON.stringify(dag).slice(0, 4000),
    'Decide your next step based on the latest DAG state and evidence (delegate/replan/fix/continue/deliver).',
  ].join('\n')
}

interface MailboxBucket {
  queue: NodeCompletionNotification[]
  enqueued: Set<string>
  consumed: Set<string>
  waiters: Set<() => void>
}

export class AgentMailbox {
  readonly #buckets = new Map<string, MailboxBucket>()

  #bucket(ownerNodeId: string): MailboxBucket {
    let bucket = this.#buckets.get(ownerNodeId)
    if (!bucket) {
      bucket = { queue: [], enqueued: new Set(), consumed: new Set(), waiters: new Set() }
      this.#buckets.set(ownerNodeId, bucket)
    }
    return bucket
  }

  enqueue(ownerNodeId: string, notification: NodeCompletionNotification): boolean {
    const bucket = this.#bucket(ownerNodeId)
    if (bucket.enqueued.has(notification.eventKey)) return false
    bucket.enqueued.add(notification.eventKey)
    bucket.queue.push(notification)
    this.wake(ownerNodeId)
    return true
  }

  wake(ownerNodeId: string): void {
    const bucket = this.#buckets.get(ownerNodeId)
    if (!bucket) return
    for (const notify of [...bucket.waiters]) notify()
  }

  wakeAll(): void {
    for (const ownerNodeId of this.#buckets.keys()) this.wake(ownerNodeId)
  }

  hasUnread(ownerNodeId: string): boolean {
    const bucket = this.#buckets.get(ownerNodeId)
    return Boolean(bucket && bucket.queue.some(item => !bucket.consumed.has(item.eventKey)))
  }

  peekUnread(ownerNodeId: string): NodeCompletionNotification[] {
    const bucket = this.#buckets.get(ownerNodeId)
    if (!bucket) return []
    return bucket.queue.filter(item => !bucket.consumed.has(item.eventKey))
  }

  drainUnread(ownerNodeId: string): NodeCompletionNotification[] {
    const bucket = this.#buckets.get(ownerNodeId)
    if (!bucket) return []
    const items = bucket.queue.filter(item => !bucket.consumed.has(item.eventKey))
    for (const item of items) bucket.consumed.add(item.eventKey)
    bucket.queue = []
    return items
  }

  acknowledge(ownerNodeId: string, eventKeys: Iterable<string>): void {
    const bucket = this.#bucket(ownerNodeId)
    const keys = new Set(eventKeys)
    if (!keys.size) return
    for (const key of keys) {
      bucket.enqueued.add(key)
      bucket.consumed.add(key)
    }
    bucket.queue = bucket.queue.filter(item => !bucket.consumed.has(item.eventKey))
  }

  async waitForActivity(
    ownerNodeId: string,
    hasPendingWork: () => boolean,
    signal?: AbortSignal,
    options?: { wakeOnUnread?: boolean },
  ): Promise<void> {
    const wakeOnUnread = options?.wakeOnUnread ?? true
    const shouldWake = () => Boolean(signal?.aborted || (wakeOnUnread && this.hasUnread(ownerNodeId)) || !hasPendingWork())
    if (shouldWake()) return
    const bucket = this.#bucket(ownerNodeId)
    await new Promise<void>((resolve) => {
      const done = () => {
        bucket.waiters.delete(check)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const check = () => {
        if (shouldWake()) done()
      }
      bucket.waiters.add(check)
      signal?.addEventListener('abort', done, { once: true })
      // Guard against synchronous settlement occurring between the initial check and waiter registration.
      check()
    })
  }

  async waitForNodes(
    ownerNodeId: string,
    targetIds: readonly string[] | undefined,
    mode: 'any' | 'all',
    state: () => { nodes: readonly WorkerNode[]; activeIds: ReadonlySet<string>; runnableIds?: ReadonlySet<string> },
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<{ timedOut: boolean; matched: NodeCompletionNotification[] }> {
    const bucket = this.#bucket(ownerNodeId)
    const isFinished = () => {
      if (signal?.aborted) return true
      const { nodes, activeIds, runnableIds } = state()
      const scoped = targetIds?.length ? nodes.filter(node => targetIds.includes(node.id)) : nodes
      if (!scoped.length) return true
      if (mode === 'any') {
        const unreadMatches = this.peekUnread(ownerNodeId).some(item =>
          !targetIds?.length || targetIds.includes(item.nodeId))
        if (unreadMatches) return true
        return scoped.some(node => node.status === 'succeeded' || node.status === 'failed') ||
          scoped.every(node => node.status !== 'running' && !activeIds.has(node.id) && !(runnableIds?.has(node.id)))
      }
      return scoped.every(node =>
        (node.status === 'succeeded' || node.status === 'failed' || (node.status === 'ready' && !(runnableIds?.has(node.id)))) &&
        !activeIds.has(node.id)) &&
        !scoped.some(node => activeIds.has(node.id) || node.status === 'running' || Boolean(runnableIds?.has(node.id)))
    }

    let timedOut = false
    if (!isFinished()) {
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | undefined
        const done = (expired = false) => {
          if (expired) timedOut = true
          bucket.waiters.delete(check)
          signal?.removeEventListener('abort', onAbort)
          if (timer) clearTimeout(timer)
          resolve()
        }
        const onAbort = () => done(false)
        const check = () => {
          if (isFinished()) done(false)
        }
        bucket.waiters.add(check)
        signal?.addEventListener('abort', onAbort, { once: true })
        if (timeoutMs !== undefined && Number.isSafeInteger(timeoutMs) && timeoutMs > 0) {
          timer = setTimeout(() => done(true), timeoutMs)
          timer.unref()
        }
        check()
      })
    }

    const unread = this.peekUnread(ownerNodeId)
    const matched = targetIds?.length ? unread.filter(item => targetIds.includes(item.nodeId)) : unread
    if (matched.length) this.acknowledge(ownerNodeId, matched.map(item => item.eventKey))
    return { timedOut, matched }
  }
}
