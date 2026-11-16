import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { TelemetryEvent, TelemetryTask } from '../../shared/contracts/observatory.ts'
import { Collector, TelemetryClient } from '../src/collector.ts'
import { ObservatoryDatabase } from '../src/database.ts'
import { buildMetrics } from '../src/metrics.ts'
import { startDashboard } from '../src/server.ts'

const token = 'fixture-collector-authorization-token'
const timeout = () => AbortSignal.timeout(10_000)

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>(resolve => server.close(() => resolve()))
  return address.port
}

async function until<T>(query: () => T | Promise<T>, match: (value: T) => boolean) {
  const signal = timeout()
  while (true) {
    signal.throwIfAborted()
    try { const value = await query(); if (match(value)) return value } catch { /* May reconnect. */ }
    await delay(50, undefined, { signal })
  }
}

test('real Host JSONL execution, live watch, durable cursor, scoped evidence, and offline restart', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'zlo-observatory-'))
  const workspace = join(root, 'workspace'), state = join(root, 'host'), collected = join(root, 'observatory')
  await mkdir(workspace)
  const port = await freePort()
  const client = new TelemetryClient(port, token)
  const cli = fileURLToPath(new URL('../../host/src/cli.ts', import.meta.url))
  let child: ReturnType<typeof start> | undefined
  let db: ObservatoryDatabase | undefined
  let collector: Collector | undefined
  function start() {
    const handle = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', cli, '--fake', '--data', state], {
      env: { ...process.env, ZLO_TELEMETRY_TOKEN: token, ZLO_TELEMETRY_PORT: String(port), ZLO_AGENT_MODEL_PROVIDER: '', ZLO_AGENT_MODEL_ID: '' },
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    })
    const done = once(handle, 'exit')
    const lines = createInterface({ input: handle.stdout })
    const replies: Record<string, unknown>[] = []
    lines.on('line', line => { replies.push(JSON.parse(line)) })
    const send = (command: object) => handle.stdin.write(JSON.stringify({ schemaVersion: 1, ...command }) + '\n')
    return { send, replies, async close() {
      if (handle.exitCode === null) send({ type: 'exit' })
      await done
    } }
  }
  try {
    const secret = 'sk-fixture-secret-value-for-observatory'
    await writeFile(join(workspace, 'demo.txt'), 'verified by zlo agent\nCookie: private-fixture\n')
    await writeFile(join(workspace, '.env'), 'PRIVATE_SECRET=fixture\n')
    child = start()
    await until(() => client.heads(null, timeout()), () => true)
    const origin = `http://127.0.0.1:${port}`
    assert.equal((await fetch(origin + '/v1/tasks')).status, 401)
    assert.equal((await fetch(origin + '/v1/tasks', { headers: { authorization: 'Bearer ' + token, origin: 'http://example.test' } })).status, 403)
    assert.equal((await fetch(origin + '/v1/command', { headers: { authorization: 'Bearer ' + token } })).status, 404)
    child.send({ type: 'createTask', commandId: 'create', requestId: secret, goal: `inspect ${secret} delegate slow`, cwd: workspace,
      workspaceAccess: 'write', check: { path: 'demo.txt', contains: 'verified by zlo agent' } })
    const { result } = await until(() => child!.replies.find(reply => reply.commandId === 'create'), Boolean) as { result: { taskId: string } }
    const id = result.taskId
    assert.ok(id)
    assert.equal((await client.watch([{ id, after: 0 }], timeout())).changed, true)
    db = new ObservatoryDatabase(collected)
    collector = new Collector(db, client)
    await collector.sync()
    const cursor = db.cursor(id)
    assert.ok(cursor > 0)
    db.close()
    db = new ObservatoryDatabase(collected)
    assert.equal(db.cursor(id), cursor)
    collector = new Collector(db, client)
    collector.start()
    const completed = await until(() => db!.task(id), task => task?.status === 'succeeded')
    assert.equal(completed?.verification?.verdict, 'verified')
    const events = db.events(id)
    assert.ok(events.length > cursor)
    assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index + 1))
    assert.ok(events.some(event => event.type === 'tool.finished'))
    assert.ok(events.some(event => event.type === 'model.usage' && events.some(other => other.type === 'model.reserved' && other.correlationId === event.correlationId)))
    assert.ok(!JSON.stringify({ completed, events }).includes(secret))
    assert.ok(!JSON.stringify({ completed, events }).includes('demo.txt'))
    const evidence = await client.evidence(id, undefined, ['demo.txt', '.env', '../outside.txt'], timeout())
    assert.equal(evidence.artifacts.length, 1)
    assert.equal(evidence.artifacts[0].path, 'demo.txt')
    assert.ok(evidence.artifacts[0].excerpt?.includes('verified by zlo agent'))
    assert.ok(!JSON.stringify(evidence).includes('private-fixture'))
    assert.ok(!JSON.stringify(evidence).includes(secret))
    assert.equal(evidence.snapshotVerification?.passed, true)
    await writeFile(join(workspace, 'demo.txt'), 'Current content no longer satisfies the check.')
    const changed = await client.evidence(id, undefined, ['demo.txt'], timeout())
    assert.equal(changed.verification?.passed, true)
    assert.equal(changed.snapshotVerification?.verdict, 'failed')
    await rm(join(workspace, 'demo.txt'))
    const missing = await client.evidence(id, undefined, ['demo.txt'], timeout())
    assert.equal(missing.snapshotVerification?.verdict, 'unverified')
    const worker = completed?.nodes.find(node => node.role === 'worker')
    assert.ok(worker)
    const nodeEvidence = await client.evidence(id, worker.id, [], timeout())
    assert.equal(nodeEvidence.nodeId, worker.id)
    assert.deepEqual(nodeEvidence.operations.map(operation => operation.tool), ['read_text_file'])
    await child.close()
    await until(() => collector!.health().state, state => state === 'offline')
    assert.equal(db.cursor(id), events.length)
    child = start()
    await until(() => collector!.health().state, state => state === 'online')
    assert.deepEqual(db.events(id), events)
  } finally {
    await collector?.close()
    await child?.close()
    db?.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('a sequence gap rolls back the batch; replay repairs it and exact duplicates remain idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zlo-observatory-gap-'))
  const db = new ObservatoryDatabase(root)
  try {
    assert.throws(() => new ObservatoryDatabase(root))
    const id = randomUUID(), now = new Date().toISOString()
    const task: TelemetryTask = { id, taskRunId: randomUUID(), rootNodeId: randomUUID(), status: 'succeeded',
      attemptCount: 1, planVersion: 0, cursor: 3, nodes: [], attempts: [] }
    const event = (seq: number): TelemetryEvent => ({ id: randomUUID(), taskId: id, schemaVersion: 1,
      seq, occurredAt: now, type: 'task.state_changed', payload: {} })
    const first = event(1), second = event(2), third = event(3)
    let supplied = [first, third]
    const requested: number[] = []
    const collector = new Collector(db, {
      async heads() { return { schemaVersion: 1, tasks: [{ id, cursor: task.cursor }], next: null } },
      async snapshot() { return task },
      async events(_, after) { requested.push(after); return supplied },
      async watch() { return { changed: false } },
    })
    assert.equal((await collector.sync()).gapStreams, 1)
    assert.equal(db.cursor(id), 0)
    assert.deepEqual(db.events(id), [])
    supplied = [first, second, third]
    assert.equal((await collector.sync()).gapStreams, 0)
    assert.deepEqual(requested, [0, 0])
    assert.equal(db.ingest(id, [first, third]), 3)
    assert.throws(() => db.ingest(id, [{ ...second, id: randomUUID() }]), /identity conflict/u)
    assert.deepEqual(db.events(id), supplied)
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('P2-1: multi-pass catching_up does not inflate missing_events and /api/overview reuses cached streams', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zlo-observatory-catchup-'))
  const db = new ObservatoryDatabase(root)
  let server: Awaited<ReturnType<typeof startDashboard>> | undefined
  try {
    const id = randomUUID(), now = new Date().toISOString()
    const total = 1100
    const fullTask: TelemetryTask = {
      id, taskRunId: randomUUID(), rootNodeId: randomUUID(), status: 'succeeded',
      attemptCount: 1, planVersion: 0, cursor: total, nodes: [], attempts: [],
    }
    const allEvents: TelemetryEvent[] = Array.from({ length: total }, (_, index) => ({
      id: randomUUID(), taskId: id, schemaVersion: 1, seq: index + 1, occurredAt: now,
      type: index === 0 ? 'task.created' : 'task.state_changed', payload: { status: index + 1 === total ? 'succeeded' : 'running' },
    }))
    const collector = new Collector(db, {
      async heads() { return { schemaVersion: 1, tasks: [{ id, cursor: fullTask.cursor }], next: null } },
      async snapshot() { return fullTask },
      async events(_, after) { return allEvents.slice(after, after + 128) },
      async watch() { return { changed: false } },
    })

    // First sync ingests 8 * 128 = 1024 events and reports behind=true without false missing_events!
    const firstPass = await collector.sync()
    assert.equal(firstPass.behind, true)
    assert.equal(firstPass.gapStreams, 0)
    assert.equal(db.cursor(id), 1024)
    const midMetrics = buildMetrics(db.tasks(), db.events(id))
    assert.equal(midMetrics.domains.reliability.find(m => m.id === 'reliability.missing_events')?.value, 0)

    // Second sync catches up the remaining 76 events cleanly.
    const secondPass = await collector.sync()
    assert.equal(secondPass.behind, false)
    assert.equal(db.cursor(id), total)

    let eventReads = 0
    const originalEvents = db.events.bind(db)
    db.events = (taskId: string) => {
      eventReads++
      return originalEvents(taskId)
    }
    const port = await freePort()
    server = await startDashboard({
      port, token, database: db, collector,
      jobs: { start() { return 'job' }, cancel() { return false } } as never,
    })
    const headers = { authorization: 'Bearer ' + token }
    const res1 = await fetch(`http://127.0.0.1:${port}/api/overview`, { headers })
    assert.equal(res1.status, 200)
    assert.equal(eventReads, 1)
    const res2 = await fetch(`http://127.0.0.1:${port}/api/overview`, { headers })
    assert.equal(res2.status, 200)
    assert.equal(eventReads, 1)
  } finally {
    await server?.close()
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})
