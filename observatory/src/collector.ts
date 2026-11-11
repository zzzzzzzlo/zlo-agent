import { setTimeout as delay } from 'node:timers/promises'
import type { EvaluationEvidence, TelemetryEvent, TelemetryTask, TelemetryTaskHead } from '../../shared/contracts/observatory.ts'
import { validLocalToken } from '../../shared/loopback-http.ts'
import type { ObservatoryDatabase } from './database.ts'

export const terminal = new Set(['succeeded', 'failed', 'blocked', 'stopped', 'needs_reconciliation'])
const taskIdPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu
export const isTaskId = (id: unknown): id is string => typeof id === 'string' && taskIdPattern.test(id)
const validCursor = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export class TelemetryClient {
  readonly #origin: string
  readonly #token: string
  constructor(port: number, token: string) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535 || !validLocalToken(token)) throw new Error('Invalid Host telemetry settings')
    this.#origin = `http://127.0.0.1:${port}`
    this.#token = token
  }

  async #request<T>(path: string, signal: AbortSignal, body?: object): Promise<T> {
    const response = await fetch(this.#origin + path, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + this.#token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined })
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {})
      throw new Error('Host read-only request failed')
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > 2_000_000) throw new Error('Host response exceeded its size bound')
      chunks.push(Buffer.from(chunk))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
  }

  async heads(before: string | null, signal: AbortSignal) {
    const page = await this.#request<{ schemaVersion: 1; tasks: TelemetryTaskHead[]; next: string | null }>(
      '/v1/tasks' + (before ? '?before=' + before : ''), signal)
    if (page.schemaVersion !== 1 || !Array.isArray(page.tasks) || page.tasks.length > 128 ||
      page.tasks.some(task => !isTaskId(task.id) || !validCursor(task.cursor)) ||
      page.next !== null && (!isTaskId(page.next) || page.next !== page.tasks.at(-1)?.id || (before !== null && page.next >= before))) {
      throw new Error('Invalid Host task page')
    }
    return page
  }

  async snapshot(id: string, signal: AbortSignal): Promise<TelemetryTask> {
    const task = await this.#request<TelemetryTask>('/v1/tasks/' + id, signal)
    if (task.id !== id || !validCursor(task.cursor) || !Array.isArray(task.nodes) || !Array.isArray(task.attempts)) throw new Error('Invalid Host task snapshot')
    return task
  }

  async events(id: string, after: number, signal: AbortSignal): Promise<TelemetryEvent[]> {
    const page = await this.#request<{ schemaVersion: 1; events: TelemetryEvent[] }>(`/v1/tasks/${id}/events?after=${after}`, signal)
    if (page.schemaVersion !== 1 || !Array.isArray(page.events) || page.events.length > 128 || page.events.some(event =>
      event.schemaVersion !== 1 || event.taskId !== id || !isTaskId(event.id) || !validCursor(event.seq) || typeof event.type !== 'string' ||
      typeof event.occurredAt !== 'string' || !Number.isFinite(Date.parse(event.occurredAt)) || !event.payload || typeof event.payload !== 'object')) {
      throw new Error('Invalid Host event page')
    }
    return page.events
  }

  watch(tasks: { id: string; after: number }[], signal: AbortSignal) {
    return this.#request<{ changed: boolean }>('/v1/watch', signal, { tasks })
  }

  async evidence(id: string, nodeId: string | undefined, artifacts: string[], signal: AbortSignal): Promise<EvaluationEvidence> {
    const evidence = await this.#request<EvaluationEvidence>(`/v1/tasks/${id}/evidence`, signal, { nodeId, artifacts })
    if (evidence.taskId !== id || evidence.nodeId !== nodeId || !Array.isArray(evidence.artifacts) || !Array.isArray(evidence.operations)) {
      throw new Error('Evaluation evidence does not match the requested task')
    }
    return evidence
  }
}

export interface CollectorHealth {
  state: 'connecting' | 'online' | 'catching_up' | 'gap' | 'offline'
  lastSuccess?: string
  lastError?: string
  streams?: number
  gapStreams?: number
}

type Source = Pick<TelemetryClient, 'heads' | 'snapshot' | 'events' | 'watch'>

export class Collector {
  #controller = new AbortController()
  #running?: Promise<void>
  #health: CollectorHealth = { state: 'connecting' }
  readonly #database: ObservatoryDatabase
  readonly #source: Source
  readonly #onSnapshot?: (task: TelemetryTask) => void

  constructor(database: ObservatoryDatabase, source: Source, onSnapshot?: (task: TelemetryTask) => void) {
    this.#database = database
    this.#source = source
    this.#onSnapshot = onSnapshot
  }

  health(): CollectorHealth { return { ...this.#health } }
  start() { this.#running ??= this.#run() }
  async close() { this.#controller.abort(); await this.#running }

  async #run() {
    const signal = this.#controller.signal
    let failures = 0
    while (!signal.aborted) {
      try {
        const { watches, gapStreams, streams, behind } = await this.sync(signal)
        this.#health = { state: gapStreams ? 'gap' : behind ? 'catching_up' : 'online', lastSuccess: new Date().toISOString(), streams, gapStreams,
          ...(gapStreams ? { lastError: 'An event sequence has a gap. Waiting for replay.' } : {}) }
        failures = 0
        if (!gapStreams && behind) await delay(25, undefined, { signal })
        else if (!gapStreams && watches.length) await this.#source.watch(watches, signal)
        else await delay(1_500, undefined, { signal })
      } catch {
        if (signal.aborted) break
        this.#health = { ...this.#health, state: 'offline', lastError: 'The local Host telemetry endpoint is unavailable.' }
        await delay(Math.min(10_000, 400 * 2 ** Math.min(failures++, 5)), undefined, { signal }).catch(() => {})
      }
    }
  }

  async sync(signal: AbortSignal = this.#controller.signal) {
    const cursors = this.#database.cursors()
    let before: string | null = null
    let gapStreams = 0, streams = 0, behind = false
    const watches: { id: string; after: number }[] = []
    do {
      const page = await this.#source.heads(before, signal)
      for (const head of page.tasks) {
        signal.throwIfAborted()
        streams++
        let after = cursors.get(head.id) ?? 0
        let gap = after > head.cursor
        let snapshot = this.#database.task(head.id)
        if (!gap && (!snapshot || snapshot.cursor !== head.cursor || after < head.cursor)) {
          snapshot = await this.#source.snapshot(head.id, signal)
          const cutoff = snapshot.cursor
          for (let pass = 0; !gap && after < cutoff && pass < 8; pass++) {
            const batch = (await this.#source.events(head.id, after, signal)).filter(event => event.seq <= cutoff)
            if (!batch.length) { gap = true; break }
            try {
              const next = this.#database.ingest(head.id, batch)
              if (next === after) { gap = true; break }
              after = next
            } catch { gap = true }
          }
          this.#database.saveSnapshot(snapshot)
        }
        if (gap) { gapStreams++; continue }
        if (!snapshot) continue
        if (after < snapshot.cursor) { behind = true; continue }
        if (after === snapshot.cursor) this.#onSnapshot?.(snapshot)
        if (watches.length < 48 && !terminal.has(snapshot.status)) watches.push({ id: head.id, after })
      }
      before = page.next
    } while (before)
    return { watches, gapStreams, streams, behind }
  }
}
