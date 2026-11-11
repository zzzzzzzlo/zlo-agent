import { createHash, randomUUID } from 'node:crypto'
import type { EvaluationEvidence, TelemetryTask } from '../../shared/contracts/observatory.ts'
import { HttpError } from '../../shared/loopback-http.ts'
import { terminal } from './collector.ts'
import type { TelemetryClient } from './collector.ts'
import type { EvaluationJob, ObservatoryDatabase } from './database.ts'
import type { Evaluator } from './evaluation.ts'

const digest = (input: string) => 'sha256:' + createHash('sha256').update(input).digest('hex')

function snapshotOf(evidence: EvaluationEvidence, cursor: number) {
  return { version: 1, capturedAt: evidence.capturedAt, taskId: evidence.taskId, taskRunId: evidence.taskRunId,
    nodeId: evidence.nodeId, cursor, goalDigest: digest(evidence.goal), constraintsDigest: digest(JSON.stringify(evidence.constraints)),
    verification: evidence.verification, snapshotVerification: evidence.snapshotVerification, operations: evidence.operations, limitations: evidence.limitations,
    artifacts: evidence.artifacts.map(({ path, digest: contentDigest, bytes, excerpt, diff }) => ({
      path, digest: contentDigest, bytes, excerptDigest: excerpt ? digest(excerpt) : undefined, diffDigest: diff ? digest(diff) : undefined,
    })), structureDigest: digest(JSON.stringify(evidence.structure)) }
}

export class EvaluationJobs {
  readonly #database: ObservatoryDatabase
  readonly #source: Pick<TelemetryClient, 'evidence' | 'snapshot'>
  readonly #evaluator: Pick<Evaluator, 'evaluate'>
  readonly #active = new Map<string, { controller: AbortController; work: Promise<void> }>()
  #closed = false

  constructor(database: ObservatoryDatabase, source: Pick<TelemetryClient, 'evidence' | 'snapshot'>, evaluator: Pick<Evaluator, 'evaluate'>) {
    this.#database = database
    this.#source = source
    this.#evaluator = evaluator
    for (const job of database.jobs(true)) database.saveJob({ ...job, status: 'failed', error: 'Evaluation was interrupted by a service restart.' })
  }

  observe(task: TelemetryTask) {
    const since = this.#database.automaticSince()
    if (!since || this.#closed || this.#active.size >= 2 || !['succeeded', 'failed'].includes(task.status)) return
    const finishedAt = task.attempts.filter(attempt => attempt.nodeId === task.rootNodeId && attempt.finishedAt)
      .map(attempt => attempt.finishedAt!).sort().at(-1)
    if (!finishedAt || finishedAt < since) return
    this.start(task, undefined, [], false, `${task.taskRunId}:${task.attemptCount}`)
  }

  start(task: TelemetryTask, nodeId: string | undefined, artifacts: string[], useModel: boolean, automaticKey?: string): string | undefined {
    if (this.#closed || this.#active.size >= 2) throw new HttpError(409, 'Evaluation capacity is busy')
    const node = nodeId && nodeId !== task.rootNodeId ? task.nodes.find(node => node.id === nodeId) : undefined
    if (nodeId && nodeId !== task.rootNodeId && !node) throw new HttpError(404, 'Task node unavailable')
    if (node ? !['succeeded', 'failed'].includes(node.status) : !terminal.has(task.status)) {
      throw new HttpError(409, 'Evaluation requires a settled task or node')
    }
    const job: EvaluationJob = { id: randomUUID(), taskId: task.id, taskRunId: task.taskRunId, nodeId,
      status: 'queued', createdAt: new Date().toISOString(), automatic: !!automaticKey }
    if (!this.#database.addJob(job, automaticKey)) return undefined
    const controller = new AbortController()
    const work = Promise.resolve().then(() => this.#run(job, task.cursor, artifacts, useModel, controller.signal))
      .finally(() => { this.#active.delete(job.id) })
    this.#active.set(job.id, { controller, work })
    return job.id
  }

  cancel(id: string): boolean {
    const running = this.#active.get(id)
    if (!running) return false
    running.controller.abort()
    return true
  }

  async close() {
    this.#closed = true
    for (const job of this.#active.values()) job.controller.abort()
    await Promise.allSettled([...this.#active.values()].map(job => job.work))
  }

  async #run(job: EvaluationJob, cursor: number, artifacts: string[], useModel: boolean, signal: AbortSignal) {
    try {
      signal.throwIfAborted()
      job.status = 'running'
      this.#database.saveJob(job)
      const before = await this.#source.snapshot(job.taskId, signal)
      if (before.taskRunId !== job.taskRunId || before.cursor !== cursor) throw new Error('Task changed before evidence capture')
      const evidence = await this.#source.evidence(job.taskId, job.nodeId, artifacts, signal)
      const after = await this.#source.snapshot(job.taskId, signal)
      if (after.cursor !== cursor || evidence.taskRunId !== job.taskRunId) throw new Error('Task changed during evidence capture')
      job.snapshot = snapshotOf(evidence, cursor)
      this.#database.saveJob(job)
      const result = await this.#evaluator.evaluate(evidence, { useModel, signal })
      job.result = result
      job.status = result.status === 'cancelled' || signal.aborted ? 'cancelled' : result.status === 'completed' ? 'completed' : 'failed'
    } catch {
      job.status = signal.aborted ? 'cancelled' : 'failed'
      if (!signal.aborted) job.error = 'Could not capture evaluation evidence. Check the Host connection and refresh the task.'
    }
    this.#database.saveJob(job)
  }
}
