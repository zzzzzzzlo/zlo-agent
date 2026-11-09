import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

interface Message {
  kind: string
  commandId?: string
  result?: { taskId?: string; accepted?: boolean; status?: string }
  event?: { taskId: string; seq: number; type: string; payload: Record<string, unknown> }
}

test('JSONL CLI returns command acks, streams output, stops, resumes, and reopens by cursor', { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zlo-cli-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  const directory = join(root, 'data')
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
  function start() {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', cli, '--fake', '--data', directory])
    t.after(() => { if (child.exitCode === null) child.kill() })
    const messages: Message[] = []
    let errors = ''
    child.stderr.on('data', (chunk) => { errors += chunk.toString() })
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => { messages.push(JSON.parse(line)) })
    const exited = once(child, 'exit')
    return {
      async receive(predicate: (message: Message) => boolean): Promise<Message> {
        for (let tick = 0; tick < 650; tick++) {
          const found = messages.find(predicate)
          if (found) return found
          if (child.exitCode !== null) break
          await delay(10)
        }
        throw new Error('CLI message missing. ' + JSON.stringify(messages.slice(-4)) + ' ' + errors)
      },
      send(command: object) { child.stdin.write(JSON.stringify({ schemaVersion: 1, ...command }) + '\n') },
      async close() {
        this.send({ type: 'exit' })
        assert.deepEqual(await exited, [0, null], errors)
      },
    }
  }
  const cliRun = start()
  await cliRun.receive(({ kind }) => kind === 'ready')
  const command = {
    type: 'createTask', requestId: 'cli-demo', goal: 'demo delegate slow', cwd,
    check: { path: 'demo.txt', contains: 'verified by zlo agent' },
  }
  cliRun.send({ ...command, commandId: 'create' })
  const { result } = await cliRun.receive(({ commandId }) => commandId === 'create')
  assert.ok(result?.taskId)
  const taskId = result.taskId
  cliRun.send({ ...command, commandId: 'duplicate' })
  assert.deepEqual((await cliRun.receive(({ commandId }) => commandId === 'duplicate')).result, result)
  cliRun.send({ type: 'subscribe', taskId, after: 0 })
  await cliRun.receive(({ event }) => event?.type === 'model.request_started')
  cliRun.send({ type: 'stop', taskId, requestId: 'cli-stop', commandId: 'stop' })
  const acknowledged = await cliRun.receive(({ commandId }) => commandId === 'stop')
  assert.equal(acknowledged.result?.status, 'stop_requested')
  const stopped = await cliRun.receive(({ event }) => event?.type === 'task.stopped')
  await cliRun.close()

  const reopened = start()
  await reopened.receive(({ kind }) => kind === 'ready')
  reopened.send({ type: 'subscribe', taskId, after: stopped.event!.seq })
  reopened.send({ type: 'resume', taskId, requestId: 'cli-resume', commandId: 'resume' })
  assert.equal((await reopened.receive(({ commandId }) => commandId === 'resume')).result?.accepted, true)
  const resumed = await reopened.receive(({ event }) => event?.type === 'task.resumed')
  assert.equal(resumed.event!.seq, stopped.event!.seq + 1)
  await reopened.receive(({ kind }) => kind === 'output')
  await reopened.receive(({ event }) => event?.payload.status === 'succeeded')
  await reopened.close()
})
