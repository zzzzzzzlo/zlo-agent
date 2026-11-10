import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { HostProcessManager, HostTransportError } from '../electron/main/host-process.ts'
import type { ConversationEvent } from '../../shared/contracts/desktop.ts'

const fixture = fileURLToPath(new URL('./fixtures/process-host.mjs', import.meta.url))
const list = { schemaVersion: 1, type: 'listConversations' } as const

function startFixture(variant: string, marker?: string) {
  return spawn(process.execPath, [fixture, variant, ...(marker ? [marker] : [])], {
    windowsHide: true, stdio: 'pipe',
  })
}

test('manager waits for framed ready, correlates replies and relays durable events', async (t) => {
  const manager = new HostProcessManager({ mode: 'faux', spawnChild: () => startFixture('ready') })
  t.after(() => manager.shutdown())
  const ready = manager.start()
  assert.equal(manager.status.state, 'starting')
  await assert.rejects(manager.request(list), { code: 'HOST_UNAVAILABLE' })
  assert.deepEqual(await ready, { state: 'ready', mode: 'faux' })

  const first = manager.request(list)
  const second = manager.request({ schemaVersion: 1, type: 'getConversation', conversationId: 'conversation-1' })
  assert.deepEqual(await Promise.all([first, second]), [['first'], { id: 'conversation-1' }])
  manager.onEvent(() => { throw new Error('isolated listener') })
  const event = new Promise<ConversationEvent>((resolve) => manager.onEvent(resolve))
  assert.equal(await manager.request({
    schemaVersion: 1, type: 'subscribeConversation', conversationId: 'conversation-1', after: 31,
  }), true)
  const next = await event
  assert.equal(next.seq, 32)
  assert.equal(next.payload.delta, '测试')
  await assert.rejects(manager.request({
    schemaVersion: 1, type: 'renameConversation', conversationId: 'conversation-1', requestId: 'r1', title: 'new',
  }), (error) => error instanceof HostTransportError && error.code === 'CONFLICT')
})

test('manager observes crash, rejects pending work and restarts a fresh connection', async (t) => {
  let starts = 0
  const manager = new HostProcessManager({
    mode: 'faux',
    spawnChild: () => { starts++; return startFixture('ready') },
  })
  t.after(() => manager.shutdown())
  await manager.start()
  await assert.rejects(manager.request({
    schemaVersion: 1, type: 'archiveConversation', conversationId: 'c', requestId: 'r',
  }), { code: 'HOST_UNAVAILABLE' })
  assert.equal(manager.status.state, 'offline')
  assert.match(manager.status.message ?? '', /17/)
  assert.doesNotMatch(manager.status.message ?? '', /provider credential/)
  const restarted = await Promise.all([manager.restart(), manager.restart()])
  assert.deepEqual(restarted.map(({ state }) => state), ['ready', 'ready'])
  assert.equal(starts, 2)
  assert.deepEqual(await manager.request(list), ['first'])
})

test('manager rejects the wrong startup mode and bounds startup and command waits', async (t) => {
  for (const variant of ['bad-mode', 'no-ready'] as const) {
    const manager = new HostProcessManager({
      mode: 'faux', spawnChild: () => startFixture(variant), startupTimeoutMs: 500,
    })
    t.after(() => manager.shutdown())
    const status = await manager.start()
    assert.equal(status.state, 'offline')
    assert.match(status.message ?? '', variant === 'bad-mode' ? /模式/ : /超时/)
  }
  const manager = new HostProcessManager({
    mode: 'faux', spawnChild: () => startFixture('ready'), requestTimeoutMs: 250,
  })
  t.after(() => manager.shutdown())
  await manager.start()
  await assert.rejects(manager.request({
    schemaVersion: 1, type: 'getConversationHistory', conversationId: 'c',
  }), { code: 'HOST_UNAVAILABLE' })
  assert.equal(manager.status.state, 'ready')
  assert.deepEqual(await manager.request(list), ['first'])
})

test('manager sends exit and waits for the child to finish before shutdown resolves', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zlo-host-process-'))
  const marker = join(directory, 'checkpoint.txt')
  const manager = new HostProcessManager({
    mode: 'faux', spawnChild: () => startFixture('ready', marker),
  })
  try {
    await manager.start()
    await Promise.all([manager.shutdown(), manager.shutdown()])
    assert.equal(await readFile(marker, 'utf8'), 'clean')
    assert.equal(manager.status.state, 'offline')
    assert.equal((await manager.restart()).state, 'offline')
  } finally {
    await manager.shutdown()
    await rm(marker, { force: true })
    await rmdir(directory)
  }
})
