import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { ConversationTurn } from '../../shared/contracts/desktop.ts'
import { ConversationService } from '../src/conversation.ts'
import { LocalStore } from '../src/store.ts'
import { TaskEngine } from '../src/task-engine.ts'

function start(store: LocalStore, cwd: string) {
  const conversations = new ConversationService(store)
  const engine = new TaskEngine(store)
  const { id: conversationId } = conversations.create({ requestId: 'create' }, cwd)
  const input = { conversationId, requestId: 'send', text: 'Stream test' }
  const { taskId } = engine.create({ requestId: 'task', conversationId, goal: input.text, cwd },
    (task) => conversations.attachTask(input, task))
  const task = engine.start(taskId)
  const source = { taskId, taskRunId: task.taskRunId, taskAttemptId: task.attemptId, type: '', payload: {} }
  return { conversations, engine, conversationId, taskId, source }
}

function countWrites(path: string) {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE write_totals (writes INTEGER, bytes INTEGER);
    INSERT INTO write_totals VALUES (0, 0);
    CREATE TRIGGER count_inserts AFTER INSERT ON records BEGIN
      UPDATE write_totals SET writes = writes + 1, bytes = bytes + length(CAST(new.value AS BLOB));
    END;
    CREATE TRIGGER count_updates AFTER UPDATE ON records BEGIN
      UPDATE write_totals SET writes = writes + 1, bytes = bytes + length(CAST(new.value AS BLOB));
    END;
    CREATE TRIGGER count_events AFTER INSERT ON events BEGIN
      UPDATE write_totals SET writes = writes + 1, bytes = bytes + length(CAST(new.event AS BLOB));
    END;
  `)
  return db
}

test('long reply batches reduce logical database writes and restore identical text and cursor', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'zlo-stream-bench-'))
  try {
    const parts = Array.from({ length: 1024 }, (_, index) => `${index.toString().padStart(4, '0')}:${'文'.repeat(128)}\n`)
    const expected = parts.join('')
    function measure(batched: boolean) {
      const path = join(root, batched ? 'batched.sqlite' : 'original.sqlite')
      const store = new LocalStore(path)
      const { conversations, conversationId, taskId, source } = start(store, root)
      const db = countWrites(path)
      const began = performance.now()
      try {
        if (batched) {
          for (const delta of parts) conversations.recordDelta(source, delta)
          conversations.checkpointOutput(taskId)
        } else {
          // Sprint 4 wrote the full Turn and one event for every delta.
          const namespace = 'conversation-turns:' + conversationId
          for (const delta of parts) store.transaction(() => {
            const turn = store.get<ConversationTurn>(namespace, '0000000000000001')!
            turn.assistant.text += delta
            store.put(namespace, '0000000000000001', turn)
            store.append({ ...source, type: 'message.delta', payload: { delta, messageId: turn.assistant.id } },
              'conversation:' + conversationId)
          })
        }
        const milliseconds = performance.now() - began
        const totals = db.prepare('SELECT writes, bytes FROM write_totals').get() as { writes: number; bytes: number }
        const snapshot = conversations.history({ conversationId })
        assert.equal(snapshot.turns[0].assistant.text, expected)
        assert.equal(store.events('conversation:' + conversationId)
          .filter((event) => event.type === 'message.delta').map((event) => event.payload.delta).join(''), expected)
        store.close()
        const reopened = new LocalStore(path)
        try {
          assert.deepEqual(new ConversationService(reopened).history({ conversationId }), snapshot)
        } finally {
          reopened.close()
        }
        return { ...totals, milliseconds }
      } finally {
        db.close()
        store.close()
      }
    }
    const original = measure(false)
    const batched = measure(true)
    t.diagnostic(JSON.stringify({ deltaCount: parts.length, replyBytes: Buffer.byteLength(expected), original, batched }))
    assert.ok(batched.writes < original.writes / 10)
    assert.ok(batched.bytes < original.bytes / 10)
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'zlo-stream-bench-')))
    rmSync(root, { recursive: true, force: true })
  }
})

test('committed batches replay once and pending text precedes terminal status', async () => {
  const store = new LocalStore(':memory:')
  try {
    const { conversations, engine, conversationId, taskId, source } = start(store, 'test')
    conversations.recordDelta(source, 'durable ')
    await delay(80)
    const first = conversations.history({ conversationId })
    assert.equal(first.turns[0].assistant.text, 'durable ')
    conversations.recordDelta(source, 'tail')
    store.projectEvents((event) => { if (event.type === 'test.rollback') throw new Error('test rollback') })
    assert.throws(() => store.transaction(() => store.append({ ...source, type: 'test.rollback' })), /test rollback/)
    assert.equal(conversations.history({ conversationId }).cursor, first.cursor)
    engine.requestStop(taskId, 'stop')
    engine.beginStopping(taskId)
    engine.end(taskId, 'user_stop')
    conversations.recordDelta(source, 'late reply')
    conversations.checkpointOutput(taskId)
    const tail = store.events('conversation:' + conversationId, first.cursor)
    assert.equal(tail[0].type, 'message.delta')
    assert.deepEqual(tail.filter((event) => event.type === 'message.delta').map((event) => event.payload.delta), ['tail'])
    const last = conversations.history({ conversationId })
    assert.equal(last.turns[0].assistant.text, 'durable tail')
    assert.equal(last.turns[0].status, 'stopped')
  } finally {
    store.close()
  }
})

test('legacy active replies use their saved prefix once when the first batch is appended', () => {
  const store = new LocalStore(':memory:')
  try {
    const { conversations, conversationId, taskId, source } = start(store, 'test')
    const namespace = 'conversation-turns:' + conversationId
    store.transaction(() => {
      const turn = store.get<ConversationTurn>(namespace, '0000000000000001')!
      turn.assistant.text = 'legacy '
      store.put(namespace, '0000000000000001', turn)
      store.append({ ...source, type: 'message.delta', payload: { delta: 'legacy ', messageId: turn.assistant.id } },
        'conversation:' + conversationId)
    })
    conversations.recordDelta(source, 'new')
    conversations.checkpointOutput(taskId)
    assert.equal(conversations.history({ conversationId }).turns[0].assistant.text, 'legacy new')
  } finally {
    store.close()
  }
})
