import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setImmediate as nextTick } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { LocalStore, StorePersistenceError } from '../src/store.ts';

function databasePath(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'zlo-store-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'task.sqlite');
}

function append(store: LocalStore, taskId: string, type: string) {
  return store.append({ taskId, type, payload: {} });
}

test('rolls back state and events together, including the sequence number', (t) => {
  const store = new LocalStore(':memory:');
  t.after(() => store.close());
  assert.throws(() => store.put('tasks', 'one', {}), /require a transaction/);
  assert.throws(() => append(store, 'one', 'task.created'), /require a transaction/);

  assert.throws(() => store.transaction(() => {
    store.put('tasks', 'one', { status: 'running' });
    assert.equal(append(store, 'one', 'task.running').seq, 1);
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(store.get('tasks', 'one'), undefined);
  assert.deepEqual(store.events('one'), []);

  assert.throws(() => store.transaction(async () => {
    store.put('tasks', 'one', { status: 'created' });
    throw new Error('late failure');
  }), /callback must be synchronous/);
  assert.equal(store.get('tasks', 'one'), undefined);
  assert.equal(store.transaction(() => append(store, 'one', 'task.created')).seq, 1);
});

test('preserves committed records and per-task event cursors after reopening', (t) => {
  const path = databasePath(t);
  const original = new LocalStore(path);
  let id: string;
  try {
    id = original.transaction(() => {
      original.put('tasks', 'one', { status: 'created' });
      original.put('tasks', 'one', { status: 'stopped', reason: '用户已停止' });
      original.put('runs', 'one', { status: 'interrupted' });
      append(original, 'one', 'task.created');
      assert.equal(append(original, 'two', 'task.created').seq, 1);
      return append(original, 'one', 'task.stopped').id;
    });
    assert.throws(() => new LocalStore(path), /already has a Host writer/);
  } finally {
    original.close();
  }

  const reopened = new LocalStore(path);
  try {
    assert.deepEqual(reopened.list('tasks'), [{ status: 'stopped', reason: '用户已停止' }]);
    assert.deepEqual(reopened.get('runs', 'one'), { status: 'interrupted' });
    assert.deepEqual(reopened.events('one', 1).map((event) => [event.seq, event.id]), [[2, id]]);
    assert.equal(reopened.transaction(() => append(reopened, 'one', 'task.resumed')).seq, 3);
    assert.throws(() => reopened.events('one', -1), /Invalid event cursor/);
  } finally {
    reopened.close();
  }
});

test('reclaims the writer lock after killing a process and recovers its last commit', { timeout: 5000 }, async (t) => {
  const path = databasePath(t);
  const moduleUrl = new URL('../src/store.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { LocalStore } from ${JSON.stringify(moduleUrl)};
    const store = new LocalStore(process.argv[1]);
    store.transaction(() => {
      store.put('tasks', 'one', { status: 'stopping' });
      store.append({ taskId: 'one', type: 'task.stop_requested', payload: {} });
    });
    console.log('ready');
    setInterval(() => {}, 1000);
  `, path], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  try {
    const [ready] = await Promise.race([
      once(lines, 'line', { signal: t.signal }),
      exited.then(() => { throw new Error('Host process exited before committing'); }),
    ]);
    assert.equal(ready, 'ready');
    assert.throws(() => new LocalStore(path), /already has a Host writer/);
  } finally {
    lines.close();
    child.kill('SIGKILL');
    await exited;
  }

  const recovered = new LocalStore(path);
  try {
    assert.deepEqual(recovered.get('tasks', 'one'), { status: 'stopping' });
    assert.equal(recovered.events('one')[0]?.type, 'task.stop_requested');
  } finally {
    recovered.close();
  }
});

test('delivers only committed events in cursor order and isolates failed or slow sinks', { timeout: 5000 }, async (t) => {
  const store = new LocalStore(':memory:');
  t.after(() => store.close());
  store.transaction(() => {
    append(store, 'one', 'task.created');
    append(store, 'one', 'task.running');
  });

  const releaseSlowSink = Promise.withResolvers<void>();
  const slowFinished = Promise.withResolvers<void>();
  const fastFinished = Promise.withResolvers<void>();
  const slow: [number, string][] = [];
  const fast: [number, string][] = [];
  store.subscribe('one', 1, async (event) => {
    slow.push([event.seq, event.type]);
    if (event.seq === 2) {
      await releaseSlowSink.promise;
      throw new Error('async sink failure');
    }
    if (event.seq === 4) slowFinished.resolve();
  });
  const unsubscribe = store.subscribe('one', 1, (event) => {
    fast.push([event.seq, event.type]);
    if (event.seq === 2) throw new Error('sync sink failure');
    fastFinished.resolve();
  });

  assert.throws(() => store.transaction(() => {
    append(store, 'one', 'task.failed');
    throw new Error('rollback');
  }), /rollback/);
  assert.deepEqual(store.events('one').map((event) => event.type), ['task.created', 'task.running']);
  store.transaction(() => append(store, 'one', 'task.stopped'));
  assert.deepEqual(fast, []);
  await fastFinished.promise;
  assert.deepEqual(fast, [[2, 'task.running'], [3, 'task.stopped']]);
  assert.deepEqual(slow, [[2, 'task.running']]);

  unsubscribe();
  store.transaction(() => append(store, 'one', 'task.resumed'));
  releaseSlowSink.resolve();
  await slowFinished.promise;
  await nextTick();
  assert.deepEqual(fast, [[2, 'task.running'], [3, 'task.stopped']]);
  assert.deepEqual(slow, [[2, 'task.running'], [3, 'task.stopped'], [4, 'task.resumed']]);
});

test('configures SQLite busy_timeout on WAL database while wrapping persistence errors distinctly from business rollbacks', (t) => {
  const path = databasePath(t);
  const store = new LocalStore(path);
  try {
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(reader.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
    } finally {
      reader.close();
    }
    assert.throws(() => store.transaction(() => {
      throw new Error('domain invariant failed');
    }), (error: unknown) => error instanceof Error && !(error instanceof StorePersistenceError));
  } finally {
    store.close();
  }
  assert.throws(() => store.transaction(() => 1), (error: unknown) => error instanceof StorePersistenceError);
});

test('P2-1: migrates v1 SQLite stores to v3 and uses expression indexes for tasks, operations and task-nodes', (t) => {
  const path = databasePath(t);
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE records (
      namespace TEXT NOT NULL,
      id TEXT NOT NULL,
      value TEXT NOT NULL CHECK (json_valid(value)),
      PRIMARY KEY (namespace, id)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE events (
      task_id TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK (seq > 0),
      id TEXT NOT NULL UNIQUE,
      event TEXT NOT NULL CHECK (json_valid(event)),
      PRIMARY KEY (task_id, seq)
    ) STRICT, WITHOUT ROWID;
    INSERT INTO records(namespace, id, value) VALUES ('tasks', '01', '{"id":"01","status":"succeeded"}');
    INSERT INTO records(namespace, id, value) VALUES ('tasks', '02', '{"id":"02","status":"ready"}');
    INSERT INTO records(namespace, id, value) VALUES ('operations', 'op-1', '{"id":"op-1","taskId":"02"}');
    PRAGMA user_version = 1;
  `);
  legacy.close();

  const store = new LocalStore(path);
  try {
    assert.deepEqual(store.firstReadyTask(), { id: '02', status: 'ready' });
    assert.deepEqual(store.recordsByTaskId('operations', '02'), [{ id: 'op-1', taskId: '02' }]);
    store.transaction(() => {
      store.put('operations', 'op-1', { id: 'op-1', taskId: '02', taskNodeId: 'n1', attemptId: 'att-1' });
      store.put('attempts', 'att-1', { id: 'att-1', taskId: '02', nodeId: 'n1' });
      store.put('task-nodes', '02:n1', { id: 'n1', taskId: '02', parentNodeId: 'root', ordinal: 1, status: 'succeeded', archivedAt: '2026-01-01T00:00:00Z' });
      store.put('task-nodes', '02:n2', { id: 'n2', taskId: '02', parentNodeId: 'root', ordinal: 2, status: 'ready' });
      store.put('task-nodes', '02:n3', { id: 'n3', taskId: '02', parentNodeId: 'team-1', ordinal: 3, status: 'running' });
    });
    assert.equal(store.operationsForNode('02', 'n1').length, 1);
    assert.equal(store.operationsForAttempt('02', 'att-1').length, 1);
    assert.equal(store.attemptsForNode('02', 'n1').length, 1);
    assert.equal(store.taskNodes('02').length, 3);
    assert.equal(store.taskNodes('02', { includeArchived: false }).length, 2);
    assert.equal(store.taskNodesByParent('02', 'team-1').length, 1);
    assert.equal(store.taskNodesByStatus('02', 'ready').length, 1);
    const page1 = store.taskNodesPage<{ id: string }>('02', { limit: 2 });
    assert.deepEqual(page1.items.map(item => item.id), ['n1', 'n2']);
    assert.equal(page1.hasMore, true);
    assert.equal(page1.nextOrdinal, 2);
    const page2 = store.taskNodesPage<{ id: string }>('02', { afterOrdinal: page1.nextOrdinal!, limit: 2 });
    assert.deepEqual(page2.items.map(item => item.id), ['n3']);
    assert.equal(page2.hasMore, false);
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(reader.prepare('PRAGMA user_version').get()?.user_version, 3);
      const opPlan = reader.prepare(`
        EXPLAIN QUERY PLAN SELECT value FROM records INDEXED BY idx_records_operations_task WHERE namespace = 'operations' AND json_extract(value, '$.taskId') = ? ORDER BY id
      `).all('02').map(row => String(row.detail)).join('\n');
      assert.match(opPlan, /SEARCH records USING INDEX idx_records_operations_task/);
      const opNodePlan = reader.prepare(`
        EXPLAIN QUERY PLAN SELECT value FROM records INDEXED BY idx_records_operations_node WHERE namespace = 'operations' AND json_extract(value, '$.taskId') = ? AND json_extract(value, '$.taskNodeId') = ? ORDER BY id
      `).all('02', 'n1').map(row => String(row.detail)).join('\n');
      assert.match(opNodePlan, /SEARCH records USING INDEX idx_records_operations_node/);
      const opAttemptPlan = reader.prepare(`
        EXPLAIN QUERY PLAN SELECT value FROM records INDEXED BY idx_records_operations_attempt WHERE namespace = 'operations' AND json_extract(value, '$.taskId') = ? AND json_extract(value, '$.attemptId') = ? ORDER BY id
      `).all('02', 'att-1').map(row => String(row.detail)).join('\n');
      assert.match(opAttemptPlan, /SEARCH records USING INDEX idx_records_operations_attempt/);
      const attemptNodePlan = reader.prepare(`
        EXPLAIN QUERY PLAN SELECT value FROM records INDEXED BY idx_records_attempts_node WHERE namespace = 'attempts' AND json_extract(value, '$.taskId') = ? AND json_extract(value, '$.nodeId') = ? ORDER BY id
      `).all('02', 'n1').map(row => String(row.detail)).join('\n');
      assert.match(attemptNodePlan, /SEARCH records USING INDEX idx_records_attempts_node/);
      const readyPlan = reader.prepare(`
        EXPLAIN QUERY PLAN SELECT value FROM records INDEXED BY idx_records_task_status WHERE namespace = 'tasks' AND json_extract(value, '$.status') = 'ready' ORDER BY id ASC LIMIT 1
      `).all().map(row => String(row.detail)).join('\n');
      assert.match(readyPlan, /SEARCH records USING INDEX idx_records_task_status/);
      const activeNodesPlan = reader.prepare(`
        EXPLAIN QUERY PLAN SELECT value FROM records INDEXED BY idx_records_task_nodes_active
        WHERE namespace = 'task-nodes' AND json_extract(value, '$.taskId') = ? AND json_extract(value, '$.archivedAt') IS NULL
        ORDER BY COALESCE(json_extract(value, '$.ordinal'), 0), id
      `).all('02').map(row => String(row.detail)).join('\n');
      assert.match(activeNodesPlan, /SEARCH records USING INDEX idx_records_task_nodes_active/);
    } finally {
      reader.close();
    }
  } finally {
    store.close();
  }
});
