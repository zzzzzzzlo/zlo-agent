import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentEvent, EventDraft } from './contracts/domain.ts';

export type { AgentEvent, EventDraft } from './contracts/domain.ts';

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
  readonly #projectors = new Set<(event: AgentEvent) => void>();
  #changedTasks: Set<string> | undefined;
  #settlements: ((committed: boolean) => void)[] | undefined;

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
    this.#projectors.clear();
    this.#db.close();
    this.#writerLock?.close();
  }

  transaction<T>(callback: () => T): T {
    if (this.#changedTasks) throw new Error('Nested store transactions are unsupported');
    this.#db.exec('BEGIN IMMEDIATE');
    const changedTasks = new Set<string>();
    const settlements: ((committed: boolean) => void)[] = [];
    this.#changedTasks = changedTasks;
    this.#settlements = settlements;
    let result: T;
    let committed = false;
    try {
      result = callback();
      if (isThenable(result)) {
        void Promise.resolve(result).catch(() => {});
        throw new Error('Store transaction callback must be synchronous');
      }
      this.#db.exec('COMMIT');
      committed = true;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    } finally {
      this.#changedTasks = undefined;
      this.#settlements = undefined;
      for (const settle of settlements) settle(committed);
    }
    for (const taskId of changedTasks) {
      for (const subscription of this.#subscriptions.get(taskId) ?? []) {
        this.#schedule(subscription);
      }
    }
    return result;
  }

  /** Settle in-memory state alongside a synchronous write, including on rollback. */
  onTransactionSettled(settle: (committed: boolean) => void): void {
    this.#requireTransaction();
    this.#settlements!.push(settle);
  }

  get<T>(namespace: string, id: string): T | undefined {
    const row = this.#db.prepare('SELECT value FROM records WHERE namespace = ? AND id = ?').get(namespace, id);
    return row ? JSON.parse(row.value as string) as T : undefined;
  }

  list<T>(namespace: string): T[] {
    return this.#db.prepare('SELECT value FROM records WHERE namespace = ? ORDER BY id').all(namespace)
      .map((row) => JSON.parse(row.value as string) as T);
  }

  listBefore<T>(namespace: string, before: string | null, limit: number): T[] {
    return this.#db.prepare(`
      SELECT value FROM records WHERE namespace = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?
    `).all(namespace, before, before, limit).map((row) => JSON.parse(row.value as string) as T);
  }

  recentField(namespace: string, path: string, limit: number): string[] {
    return this.#db.prepare(`
      SELECT json_extract(value, ?) AS field FROM records WHERE namespace = ? ORDER BY id DESC LIMIT ?
    `).all(path, namespace, limit).flatMap(row => typeof row.field === 'string' ? [row.field] : []);
  }

  conversationActivity(namespace: string) {
    const model = this.#db.prepare(`
      WITH activity AS (
        SELECT json_extract(e.event, '$.type') AS type, json_extract(e.event, '$.payload') AS payload
        FROM records r JOIN events e ON e.task_id = json_extract(r.value, '$.taskId')
        WHERE r.namespace = ? AND json_extract(e.event, '$.type') IN ('model.request_started', 'model.usage')
      )
      SELECT count(*) FILTER (WHERE type = 'model.request_started') AS requests,
        count(*) FILTER (WHERE type = 'model.usage') AS reports,
        count(json_extract(payload, '$.estimatedCostUsd')) FILTER (WHERE type = 'model.usage') AS priced,
        sum(json_extract(payload, '$.estimatedCostUsd')) FILTER (WHERE type = 'model.usage') AS cost,
        sum(json_extract(payload, '$.input')) FILTER (WHERE type = 'model.usage') AS input,
        sum(json_extract(payload, '$.output')) FILTER (WHERE type = 'model.usage') AS output,
        sum(json_extract(payload, '$.cacheRead')) FILTER (WHERE type = 'model.usage') AS cacheRead,
        sum(json_extract(payload, '$.cacheWrite')) FILTER (WHERE type = 'model.usage') AS cacheWrite
      FROM activity
    `).get(namespace)!;
    const tools = this.#db.prepare(`
      SELECT json_extract(tool.value, '$.name') AS name, json_extract(tool.value, '$.status') AS status, count(*) AS count
      FROM records r, json_each(r.value, '$.tools') tool
      WHERE r.namespace = ? GROUP BY name, status ORDER BY name, status
    `).all(namespace).map(row => ({ name: row.name as string, status: row.status as string, count: Number(row.count) }));
    return { modelRequests: Number(model.requests), usageReports: Number(model.reports), pricedReports: Number(model.priced),
      estimatedCostUsd: typeof model.cost === 'number' ? model.cost : null,
      usage: { input: Number(model.input ?? 0), output: Number(model.output ?? 0), cacheRead: Number(model.cacheRead ?? 0), cacheWrite: Number(model.cacheWrite ?? 0) }, tools };
  }

  matchingRecords<T>(namespace: string, path: string, value: string): T[] {
    return this.#db.prepare(`
      SELECT value FROM records WHERE namespace = ? AND json_extract(value, ?) = ? ORDER BY id
    `).all(namespace, path, value).map(row => JSON.parse(row.value as string) as T);
  }

  put(namespace: string, id: string, value: unknown): void {
    this.#requireTransaction();
    this.#db.prepare(`
      INSERT INTO records(namespace, id, value) VALUES (?, ?, ?)
      ON CONFLICT(namespace, id) DO UPDATE SET value = excluded.value
    `).run(namespace, id, encode(value));
  }

  append(draft: EventDraft, streamId = draft.taskId): AgentEvent {
    const changedTasks = this.#requireTransaction();
    const event: AgentEvent = {
      ...draft,
      schemaVersion: 1,
      id: randomUUID(),
      seq: this.eventCursor(streamId) + 1,
      occurredAt: new Date().toISOString(),
    };
    this.#db.prepare('INSERT INTO events(task_id, seq, id, event) VALUES (?, ?, ?, ?)')
      .run(streamId, event.seq, event.id, encode(event));
    changedTasks.add(streamId);
    if (streamId === draft.taskId) {
      for (const project of this.#projectors) project(event);
    }
    return event;
  }

  eventCursor(streamId: string): number {
    const row = this.#db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE task_id = ?').get(streamId);
    return Number(row?.seq);
  }

  /** Project primary events inside their write transaction. Projections write to separate streams. */
  projectEvents(project: (event: AgentEvent) => void): void {
    this.#projectors.add(project);
  }

  events(taskId: string, after = 0, limit = -1): AgentEvent[] {
    validateCursor(after);
    return this.#readEvents(taskId, after, limit);
  }

  eventsOfTypes(taskId: string, types: readonly string[]): AgentEvent[] {
    if (!types.length) return [];
    return this.#db.prepare(`
      SELECT event FROM events
      WHERE task_id = ? AND json_extract(event, '$.type') IN (${types.map(() => '?').join(', ')})
      ORDER BY seq
    `).all(taskId, ...types).map(row => JSON.parse(row.event as string) as AgentEvent);
  }

  messageDeltas(streamId: string, messageId: string, after: number): { seq: number; delta: string }[] {
    return this.#db.prepare(`
      SELECT seq, json_extract(event, '$.payload.delta') AS delta
      FROM events
      WHERE task_id = ? AND seq > ?
        AND json_extract(event, '$.type') = 'message.delta'
        AND json_extract(event, '$.payload.messageId') = ?
      ORDER BY seq
    `).all(streamId, after, messageId) as { seq: number; delta: string }[];
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
