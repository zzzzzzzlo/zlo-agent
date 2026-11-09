import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setImmediate as nextTick } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { LocalStore } from '../src/store.ts';

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
