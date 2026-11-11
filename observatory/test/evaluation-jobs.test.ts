import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { EvaluationEvidence, TelemetryTask } from '../../shared/contracts/observatory.ts'
import { ObservatoryDatabase } from '../src/database.ts'
import { EvaluationJobs } from '../src/evaluation-jobs.ts'
import { Evaluator } from '../src/evaluation.ts'

function taskFinished(at: string): TelemetryTask {
  const rootNodeId = randomUUID()
  return { id: randomUUID(), taskRunId: randomUUID(), rootNodeId, cursor: 1, planVersion: 0, attemptCount: 1, status: 'succeeded',
    attempts: [{ id: randomUUID(), nodeId: rootNodeId, startedAt: at, finishedAt: at, status: 'succeeded' }], nodes: [] }
}

async function waitJob(db: ObservatoryDatabase, id: string) {
  for (let tick = 0; tick < 120; tick++) {
    const job = db.job(id)
    if (job && !['queued', 'running'].includes(job.status)) return job
    await delay(10)
  }
  throw new Error('Evaluation did not settle')
}

test('automatic reviews are deterministic, once per finished run, with immutable sanitized evidence metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zlo-auto-eval-'))
  let db = new ObservatoryDatabase(directory)
  const old = taskFinished('2020-01-01T00:00:00Z')
  let task = old
  let digest = 'fixture-digest-first'
  const snapshot = () => structuredClone(task)
  const source = { snapshot: async () => snapshot(), async evidence(id: string, nodeId?: string): Promise<EvaluationEvidence> {
    return { taskId: id, taskRunId: task.taskRunId, nodeId, capturedAt: new Date().toISOString(), goal: 'PRIVATE_GOAL',
      constraints: ['PRIVATE_CONSTRAINT'], verification: { verdict: 'verified', passed: true, basis: 'workspace_path' },
      artifacts: [{ path: 'demo.html', digest, bytes: 25, excerpt: 'PRIVATE_EXCERPT' }], operations: [], structure: [], limitations: [] }
  } }
  const evaluator = new Evaluator({ fetch: async () => assert.fail('Automatic review cannot invoke a model') })
  let jobs = new EvaluationJobs(db, source, evaluator)
  try {
    db.setAutomatic(true)
    jobs.observe(old)
    assert.equal(db.jobs().length, 0)
    task = taskFinished(new Date().toISOString())
    jobs.observe(task)
    jobs.observe(task)
    assert.equal(db.jobs().length, 1)
    const first = await waitJob(db, db.jobs()[0].id)
    assert.equal(first.status, 'completed')
    assert.equal((first.result as { verdict: string }).verdict, 'pass')
    assert.match(JSON.stringify(first.snapshot), /fixture-digest-first/u)
    assert.doesNotMatch(JSON.stringify(first), /PRIVATE_GOAL|PRIVATE_CONSTRAINT|PRIVATE_EXCERPT/u)
    digest = 'fixture-digest-second'
    const second = await waitJob(db, jobs.start(task, undefined, ['demo.html'], false)!)
    assert.match(JSON.stringify(second.snapshot), /fixture-digest-second/u)
    assert.match(JSON.stringify(db.job(first.id)?.snapshot), /fixture-digest-first/u)
    assert.deepEqual(task, snapshot())
    await jobs.close()
    db.close()
    db = new ObservatoryDatabase(directory)
    jobs = new EvaluationJobs(db, source, evaluator)
    assert.ok(db.automaticSince())
    jobs.observe(task)
    assert.equal(db.jobs().length, 2)
  } finally {
    await jobs.close()
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('cancelled jobs and interrupted records settle locally without an implicit retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zlo-cancel-eval-'))
  const db = new ObservatoryDatabase(directory)
  const task = taskFinished(new Date().toISOString())
  const source = { snapshot: async () => task, async evidence(_id: string, _node: string | undefined, _files: string[], signal: AbortSignal): Promise<EvaluationEvidence> {
    await delay(10_000, undefined, { signal })
    throw new Error('Fixture timed out')
  } }
  const interrupted = { id: randomUUID(), taskId: task.id, taskRunId: task.taskRunId, status: 'running' as const, createdAt: new Date().toISOString(), automatic: false }
  db.addJob(interrupted)
  const jobs = new EvaluationJobs(db, source, new Evaluator())
  try {
    assert.equal(db.job(interrupted.id)?.status, 'failed')
    const id = jobs.start(task, undefined, [], true)!
    await delay(5)
    assert.equal(jobs.cancel(id), true)
    assert.equal((await waitJob(db, id)).status, 'cancelled')
    assert.equal(jobs.cancel(id), false)
  } finally {
    await jobs.close()
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
})
