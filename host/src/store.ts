import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface EventDraft {
  taskId: string;
  type: string;
  taskRunId?: string;
  taskNodeId?: string;
  taskAttemptId?: string;
  agentId?: string;
  agentRunId?: string;
  sessionId?: string;
  parentAgentRunId?: string;
  correlationId?: string;
  causationId?: string;
  payload: Record<string, unknown>;
}

export interface AgentEvent extends EventDraft {
  schemaVersion: 1;
  id: string;
  seq: number;
  occurredAt: string;
}

type EventSink = (event: AgentEvent) => void | Promise<void>;

interface Subscription {
  taskId: string;
  cursor: number;
  sink: EventSink;
  pending: boolean;
  active: boolean;
}

const SCHEMA_VERSION = 1;
const REPLAY_BATCH_SIZE = 128;

/** Store JSON DTOs and append-only events in one transaction boundary. */
export class LocalStore {
  readonly #db: DatabaseSync;
  readonly #writerLock: DatabaseSync | undefined;
  readonly #subscriptions = new Map<string, Set<Subscription>>();
  #changedTasks: Set<string> | undefined;

  constructor(databasePath: string) {
    const path = databasePath === ':memory:' ? databasePath : canonicalPath(databasePath);
    this.#writerLock = path === ':memory:' ? undefined : acquireWriterLock(path);
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path);
      this.#db = db;
      const journal = db.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode;
      if (path !== ':memory:' && journal !== 'wal') {
        throw new Error('Local store requires WAL journaling');
      }
      db.exec('PRAGMA synchronous = FULL');
      this.#migrate();
    } catch (error) {
      try {
        db?.close();
      } finally {
        this.#writerLock?.close();
      }
      throw error;
    }
  }

  close(): void {
    if (this.#changedTasks) throw new Error('Cannot close store during a transaction');
    if (!this.#db.isOpen) return;
    for (const subscriptions of this.#subscriptions.values()) {
      for (const subscription of subscriptions) subscription.active = false;
    }
    this.#subscriptions.clear();
    this.#db.close();
    this.#writerLock?.close();
  }

  transaction<T>(callback: () => T): T {
    if (this.#changedTasks) throw new Error('Nested store transactions are unsupported');
    this.#db.exec('BEGIN IMMEDIATE');
    const changedTasks = new Set<string>();
    this.#changedTasks = changedTasks;
    let result: T;
    try {
      result = callback();
      if (isThenable(result)) {
        void Promise.resolve(result).catch(() => {});
        throw new Error('Store transaction callback must be synchronous');
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    } finally {
      this.#changedTasks = undefined;
    }
    for (const taskId of changedTasks) {
      for (const subscription of this.#subscriptions.get(taskId) ?? []) {
        this.#schedule(subscription);
      }
    }
    return result;
  }

  get<T>(namespace: string, id: string): T | undefined {
    const row = this.#db.prepare('SELECT value FROM records WHERE namespace = ? AND id = ?').get(namespace, id);
    return row ? JSON.parse(row.value as string) as T : undefined;
  }

  list<T>(namespace: string): T[] {
    return this.#db.prepare('SELECT value FROM records WHERE namespace = ? ORDER BY id').all(namespace)
      .map((row) => JSON.parse(row.value as string) as T);
  }

  put(namespace: string, id: string, value: unknown): void {
    this.#requireTransaction();
    this.#db.prepare(`
      INSERT INTO records(namespace, id, value) VALUES (?, ?, ?)
      ON CONFLICT(namespace, id) DO UPDATE SET value = excluded.value
    `).run(namespace, id, encode(value));
  }

  append(draft: EventDraft): AgentEvent {
    const changedTasks = this.#requireTransaction();
    const row = this.#db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE task_id = ?').get(draft.taskId);
    const event: AgentEvent = {
      ...draft,
      schemaVersion: 1,
      id: randomUUID(),
      seq: Number(row?.seq) + 1,
      occurredAt: new Date().toISOString(),
    };
    this.#db.prepare('INSERT INTO events(task_id, seq, id, event) VALUES (?, ?, ?, ?)')
      .run(event.taskId, event.seq, event.id, encode(event));
    changedTasks.add(event.taskId);
    return event;
  }

  events(taskId: string, after = 0): AgentEvent[] {
    validateCursor(after);
    return this.#readEvents(taskId, after, -1);
  }

  /** The cursor is exclusive. Sinks are serial per subscriber and run after commit. */
  subscribe(taskId: string, after: number, sink: EventSink): () => void {
    validateCursor(after);
    if (!this.#db.isOpen) throw new Error('Local store is closed');
    const subscription: Subscription = { taskId, cursor: after, sink, pending: false, active: true };
    const subscriptions = this.#subscriptions.get(taskId) ?? new Set<Subscription>();
    subscriptions.add(subscription);
    this.#subscriptions.set(taskId, subscriptions);
    this.#schedule(subscription);
    return () => this.#unsubscribe(subscription);
  }

  #migrate(): void {
    const version = this.#db.prepare('PRAGMA user_version').get()?.user_version;
    if (version === SCHEMA_VERSION) return;
    if (version !== 0) throw new Error(`Unsupported local store schema version: ${version}`);
    this.transaction(() => {
      this.#db.exec(`
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
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
    });
  }

  #requireTransaction(): Set<string> {
    if (!this.#changedTasks || !this.#db.isTransaction) {
      throw new Error('Store writes require a transaction');
    }
    return this.#changedTasks;
  }

  #readEvents(taskId: string, after: number, limit: number): AgentEvent[] {
    return this.#db.prepare('SELECT event FROM events WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(taskId, after, limit).map((row) => JSON.parse(row.event as string) as AgentEvent);
  }

  #schedule(subscription: Subscription): void {
    if (!subscription.active || subscription.pending) return;
    subscription.pending = true;
    setImmediate(() => { void this.#deliver(subscription); });
  }

  async #deliver(subscription: Subscription): Promise<void> {
    try {
      if (!subscription.active) return;
      const batch = this.#readEvents(subscription.taskId, subscription.cursor, REPLAY_BATCH_SIZE);
      for (const event of batch) {
        if (!subscription.active) break;
        subscription.cursor = event.seq;
        try {
          await subscription.sink(event);
        } catch {
          // Consumers own their failures and can reconnect from their last acknowledged cursor.
        }
      }
      subscription.pending = false;
      if (batch.length > 0) this.#schedule(subscription);
    } catch {
      // Replay failures are isolated from writes. Reconnecting or reading directly can retry.
      this.#unsubscribe(subscription);
    }
  }

  #unsubscribe(subscription: Subscription): void {
    if (!subscription.active) return;
    subscription.active = false;
    const subscriptions = this.#subscriptions.get(subscription.taskId);
    subscriptions?.delete(subscription);
    if (subscriptions?.size === 0) this.#subscriptions.delete(subscription.taskId);
  }
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  const directory = dirname(absolute);
  mkdirSync(directory, { recursive: true });
  try {
    const canonical = realpathSync.native(absolute);
    if (statSync(canonical).nlink > 1) throw new Error('Local store database cannot have hard links');
    return canonical;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    if (lstatSync(absolute, { throwIfNoEntry: false })?.isSymbolicLink()) throw error;
    return join(realpathSync.native(directory), basename(absolute));
  }
}

function acquireWriterLock(path: string): DatabaseSync {
  const lock = new DatabaseSync(`${path}.writer`);
  try {
    lock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
  } catch (error) {
    lock.close();
    if (error instanceof Error && 'errcode' in error && (error.errcode === 5 || error.errcode === 6)) {
      throw new Error(`Local store already has a Host writer: ${path}`, { cause: error });
    }
    throw error;
  }
  return lock;
}

function encode(value: unknown): string {
  const result = JSON.stringify(value);
  if (result === undefined) throw new TypeError('Store values must be JSON-serializable');
  return result;
}

function validateCursor(cursor: number): void {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RangeError('Invalid event cursor');
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value != null && typeof (value as { then?: unknown }).then === 'function';
}
