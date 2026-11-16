import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentEvent, EventDraft, TaskStatus, VerificationResult, VerificationVerdict } from './contracts/domain.ts';
import { verificationVerdict } from './contracts/domain.ts';
import { isCompletionFollowUp } from '../../shared/contracts/observatory.ts';

export type { AgentEvent, EventDraft } from './contracts/domain.ts';

type EventSink = (event: AgentEvent) => void | Promise<void>;

interface Subscription {
  taskId: string;
  cursor: number;
  sink: EventSink;
  pending: boolean;
  dirty: boolean;
  active: boolean;
}

const SCHEMA_VERSION = 2;
const REPLAY_BATCH_SIZE = 128;

export class StorePersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StorePersistenceError';
  }
}

function asPersistenceError(error: unknown): StorePersistenceError {
  if (error instanceof StorePersistenceError) return error;
  const message = error instanceof Error ? error.message : 'Local store persistence failed';
  return new StorePersistenceError(message, { cause: error });
}

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
      db = new DatabaseSync(path, { timeout: 5000 });
      this.#db = db;
      const journal = db.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode;
      if (path !== ':memory:' && journal !== 'wal') {
        throw new Error('Local store requires WAL journaling');
      }
      db.exec('PRAGMA synchronous = FULL');
      db.exec('PRAGMA busy_timeout = 5000');
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

  get isClosed(): boolean {
    return !this.#db.isOpen;
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
    try {
      this.#db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      throw asPersistenceError(error);
    }
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
      try {
        this.#db.exec('COMMIT');
      } catch (error) {
        throw asPersistenceError(error);
      }
      committed = true;
    } catch (error) {
      if (this.#db.isTransaction) {
        try {
          this.#db.exec('ROLLBACK');
        } catch (rollbackError) {
          throw asPersistenceError(rollbackError);
        }
      }
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
    const rows = this.#db.prepare(`
      WITH turn_tasks AS (
        SELECT r.id AS turnId, r.value AS turnJson, json_extract(r.value, '$.taskId') AS taskId, t.value AS taskJson
        FROM records r
        LEFT JOIN records t ON t.namespace = 'tasks' AND t.id = json_extract(r.value, '$.taskId')
        WHERE r.namespace = ?
        ORDER BY r.id
      ),
      task_events AS (
        SELECT e.task_id AS taskId,
          count(*) FILTER (WHERE json_extract(e.event, '$.type') = 'model.request_started') AS requests,
          count(*) FILTER (WHERE json_extract(e.event, '$.type') = 'model.usage') AS reports,
          count(json_extract(e.event, '$.payload.estimatedCostUsd')) FILTER (WHERE json_extract(e.event, '$.type') = 'model.usage') AS priced,
          sum(json_extract(e.event, '$.payload.estimatedCostUsd')) FILTER (WHERE json_extract(e.event, '$.type') = 'model.usage') AS cost,
          sum(json_extract(e.event, '$.payload.input')) FILTER (WHERE json_extract(e.event, '$.type') = 'model.usage') AS input,
          sum(json_extract(e.event, '$.payload.output')) FILTER (WHERE json_extract(e.event, '$.type') = 'model.usage') AS output,
          sum(json_extract(e.event, '$.payload.cacheRead')) FILTER (WHERE json_extract(e.event, '$.type') = 'model.usage') AS cacheRead,
          sum(json_extract(e.event, '$.payload.cacheWrite')) FILTER (WHERE json_extract(e.event, '$.type') = 'model.usage') AS cacheWrite,
          max(CASE WHEN json_extract(e.event, '$.type') = 'visual.preview_finished'
            AND json_extract(e.event, '$.payload.rendered') = 1
            AND json_extract(e.event, '$.payload.runtimeErrors') = 0 THEN 1 ELSE 0 END) AS cleanVisual,
          count(*) FILTER (WHERE json_extract(e.event, '$.type') = 'model.output_recovery') AS outputRecoveries,
          count(*) FILTER (WHERE json_extract(e.event, '$.type') = 'task.resumed') AS resumes,
          count(*) FILTER (WHERE json_extract(e.event, '$.type') IN ('task.instruction_added', 'instruction.applied')) AS steerEvents,
          min(json_extract(e.event, '$.occurredAt')) AS firstAt,
          max(CASE WHEN json_extract(e.event, '$.type') IN ('task.state_changed', 'task.stopped')
            AND json_extract(e.event, '$.payload.status') IN ('succeeded', 'failed', 'stopped', 'blocked', 'needs_reconciliation')
            THEN json_extract(e.event, '$.occurredAt') END) AS terminalAt,
          max(json_extract(e.event, '$.occurredAt')) AS lastAt
        FROM events e
        WHERE e.task_id IN (SELECT taskId FROM turn_tasks)
        GROUP BY e.task_id
      )
      SELECT tt.turnJson, tt.taskJson,
        te.requests, te.reports, te.priced, te.cost, te.input, te.output, te.cacheRead, te.cacheWrite,
        te.cleanVisual, te.outputRecoveries, te.resumes, te.steerEvents, te.firstAt, te.terminalAt, te.lastAt
      FROM turn_tasks tt
      LEFT JOIN task_events te ON te.taskId = tt.taskId
      ORDER BY tt.turnId
    `).all(namespace);

    const endedStatuses = new Set<TaskStatus>(['succeeded', 'failed', 'stopped', 'blocked', 'needs_reconciliation']);
    let modelRequests = 0, usageReports = 0, pricedReports = 0;
    let totalCost: number | null = null;
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const completion = {
      ended: 0, verified: 0, unverified: 0, failed: 0, active: 0, stopped: 0, needsReconciliation: 0,
      firstPassVerified: 0, selfRepaired: 0, steered: 0,
      rigorTiers: { command: 0, visual: 0, path: 0, unverified: 0 },
      nodeTotal: 0, nodeSucceeded: 0,
    };
    const turnMetrics: {
      taskId: string; label: string; status: TaskStatus; verdict: VerificationVerdict;
      rigorTier: 'T3' | 'T2' | 'T1' | 'T0'; attemptCount: number;
      firstPassVerified: boolean; selfRepaired: boolean; steered: boolean;
      input: number; output: number; cacheRead: number; cacheWrite: number;
      estimatedCostUsd: number | null; toolCalls: number; toolFailed: number; durationMs: number | null;
      judgmentCalls: number; judgmentInterventions: number;
    }[] = [];

    const judgmentRows = this.#db.prepare(`
      SELECT json_extract(r.value, '$.taskId') AS taskId, e.event AS eventJson
      FROM records r
      JOIN events e ON e.task_id = json_extract(r.value, '$.taskId')
      WHERE r.namespace = ?
        AND json_extract(e.event, '$.type') IN ('judgment.evaluated', 'tool.evidence_replayed', 'turn.followup_triggered')
      ORDER BY r.id, e.seq
    `).all(namespace) as { taskId: string; eventJson: string }[];
    const judgments = summarizeConversationJudgments(judgmentRows);

    for (const row of rows) {
      const turn = JSON.parse(row.turnJson as string) as {
        taskId: string; status: TaskStatus; verification?: VerificationResult;
        user?: { text?: string }; instructions?: unknown[];
        tools?: { status: string }[];
        nodes?: { status: string }[];
      };
      const task = typeof row.taskJson === 'string'
        ? JSON.parse(row.taskJson) as { attemptCount?: number; instructions?: unknown[]; nodes?: { replans?: number; status?: string }[] }
        : undefined;
      const requests = Number(row.requests ?? 0);
      const reports = Number(row.reports ?? 0);
      const priced = Number(row.priced ?? 0);
      const cost = typeof row.cost === 'number' ? row.cost : null;
      const input = Number(row.input ?? 0);
      const output = Number(row.output ?? 0);
      const cacheRead = Number(row.cacheRead ?? 0);
      const cacheWrite = Number(row.cacheWrite ?? 0);
      modelRequests += requests;
      usageReports += reports;
      pricedReports += priced;
      if (cost !== null) totalCost = (totalCost ?? 0) + cost;
      usage.input += input;
      usage.output += output;
      usage.cacheRead += cacheRead;
      usage.cacheWrite += cacheWrite;

      const ended = endedStatuses.has(turn.status);
      const verdict: VerificationVerdict = turn.verification ? verificationVerdict(turn.verification) : 'unverified';
      const cleanVisual = Number(row.cleanVisual ?? 0) > 0;
      const rigorTier: 'T3' | 'T2' | 'T1' | 'T0' = verdict !== 'verified' ? 'T0'
        : turn.verification?.basis === 'project_command' ? 'T3' : cleanVisual ? 'T2' : 'T1';
      const steered = (turn.instructions?.length ?? 0) > 0 || Number(row.steerEvents ?? 0) > 0 ||
        Number(row.resumes ?? 0) > 0 || (task?.instructions?.length ?? 0) > 0;
      const hasReplans = (task?.nodes ?? []).some(node => (node.replans ?? 0) > 0);
      const attemptCount = task?.attemptCount ?? 1;
      const toolCalls = turn.tools?.length ?? 0;
      const toolFailed = turn.tools?.filter(item => item.status === 'failed').length ?? 0;
      const firstPassVerified = ended && verdict === 'verified' && attemptCount === 1 && !steered && !hasReplans;
      const selfRepaired = ended && verdict === 'verified' && !steered && Number(row.resumes ?? 0) === 0 &&
        (toolFailed > 0 || attemptCount > 1 || hasReplans || Number(row.outputRecoveries ?? 0) > 0);

      if (ended) {
        completion.ended++;
        if (verdict === 'verified') {
          completion.verified++;
          if (rigorTier === 'T3') completion.rigorTiers.command++;
          else if (rigorTier === 'T2') completion.rigorTiers.visual++;
          else completion.rigorTiers.path++;
        } else if (verdict === 'failed' || turn.status === 'failed') {
          completion.failed++;
        } else {
          completion.unverified++;
          completion.rigorTiers.unverified++;
        }
        if (turn.status === 'stopped' || turn.status === 'blocked') completion.stopped++;
        if (turn.status === 'needs_reconciliation') completion.needsReconciliation++;
        if (firstPassVerified) completion.firstPassVerified++;
        if (selfRepaired) completion.selfRepaired++;
      } else {
        completion.active++;
      }
      if (steered) completion.steered++;
      const nodes = turn.nodes ?? [];
      completion.nodeTotal += nodes.length;
      completion.nodeSucceeded += nodes.filter(node => node.status === 'succeeded').length;

      const startMs = typeof row.firstAt === 'string' ? Date.parse(row.firstAt) : NaN;
      const endIso = ended ? (typeof row.terminalAt === 'string' ? row.terminalAt : row.lastAt) : row.lastAt;
      const endMs = typeof endIso === 'string' ? Date.parse(endIso) : NaN;
      const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : null;
      const perTurnJev = judgments.byTask.get(turn.taskId);

      turnMetrics.push({
        taskId: turn.taskId,
        label: String(turn.user?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 48),
        status: turn.status,
        verdict,
        rigorTier,
        attemptCount,
        firstPassVerified,
        selfRepaired,
        steered,
        input,
        output,
        cacheRead,
        cacheWrite,
        estimatedCostUsd: priced > 0 ? cost : null,
        toolCalls,
        toolFailed,
        durationMs,
        judgmentCalls: perTurnJev?.calls ?? 0,
        judgmentInterventions: perTurnJev?.interventions ?? 0,
      });
    }

    const tools = this.#db.prepare(`
      SELECT json_extract(tool.value, '$.name') AS name, json_extract(tool.value, '$.status') AS status, count(*) AS count
      FROM records r, json_each(r.value, '$.tools') tool
      WHERE r.namespace = ? GROUP BY name, status ORDER BY name, status
    `).all(namespace).map(row => ({ name: row.name as string, status: row.status as string, count: Number(row.count) }));

    return {
      modelRequests, usageReports, pricedReports,
      estimatedCostUsd: totalCost, usage, tools,
      completion, turnMetrics: turnMetrics.slice(-30), judgments: judgments.summary,
    };
  }

  matchingRecords<T>(namespace: string, path: string, value: string): T[] {
    return this.#db.prepare(`
      SELECT value FROM records WHERE namespace = ? AND json_extract(value, ?) = ? ORDER BY id
    `).all(namespace, path, value).map(row => JSON.parse(row.value as string) as T);
  }

  recordsByTaskId<T>(namespace: 'operations' | 'attempts', taskId: string): T[] {
    const sql = namespace === 'operations'
      ? `SELECT value FROM records INDEXED BY idx_records_operations_task WHERE namespace = 'operations' AND json_extract(value, '$.taskId') = ? ORDER BY id`
      : `SELECT value FROM records INDEXED BY idx_records_attempts_task WHERE namespace = 'attempts' AND json_extract(value, '$.taskId') = ? ORDER BY id`;
    return this.#db.prepare(sql).all(taskId).map(row => JSON.parse(row.value as string) as T);
  }

  firstReadyTask<T>(): T | undefined {
    const row = this.#db.prepare(`
      SELECT value FROM records INDEXED BY idx_records_task_status WHERE namespace = 'tasks' AND json_extract(value, '$.status') = 'ready' ORDER BY id ASC LIMIT 1
    `).get();
    return row ? JSON.parse(row.value as string) as T : undefined;
  }

  put(namespace: string, id: string, value: unknown): void {
    this.#requireTransaction();
    const encoded = encode(value);
    try {
      this.#db.prepare(`
        INSERT INTO records(namespace, id, value) VALUES (?, ?, ?)
        ON CONFLICT(namespace, id) DO UPDATE SET value = excluded.value
      `).run(namespace, id, encoded);
    } catch (error) {
      throw asPersistenceError(error);
    }
  }

  delete(namespace: string, id: string): void {
    this.#requireTransaction();
    try {
      this.#db.prepare('DELETE FROM records WHERE namespace = ? AND id = ?').run(namespace, id);
    } catch (error) {
      throw asPersistenceError(error);
    }
  }

  append(draft: EventDraft, streamId = draft.taskId): AgentEvent {
    const changedTasks = this.#requireTransaction();
    const seq = this.eventCursor(streamId) + 1;
    const event: AgentEvent = {
      ...draft,
      schemaVersion: 1,
      id: randomUUID(),
      seq,
      occurredAt: new Date().toISOString(),
    };
    const encoded = encode(event);
    try {
      this.#db.prepare('INSERT INTO events(task_id, seq, id, event) VALUES (?, ?, ?, ?)')
        .run(streamId, event.seq, event.id, encoded);
    } catch (error) {
      throw asPersistenceError(error);
    }
    changedTasks.add(streamId);
    if (streamId === draft.taskId) {
      for (const project of this.#projectors) project(event);
    }
    return event;
  }

  eventCursor(streamId: string): number {
    try {
      const row = this.#db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE task_id = ?').get(streamId);
      return Number(row?.seq);
    } catch (error) {
      throw asPersistenceError(error);
    }
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
    const subscription: Subscription = { taskId, cursor: after, sink, pending: false, dirty: false, active: true };
    const subscriptions = this.#subscriptions.get(taskId) ?? new Set<Subscription>();
    subscriptions.add(subscription);
    this.#subscriptions.set(taskId, subscriptions);
    this.#schedule(subscription);
    return () => this.#unsubscribe(subscription);
  }

  #migrate(): void {
    const rawVersion = this.#db.prepare('PRAGMA user_version').get()?.user_version;
    const version = typeof rawVersion === 'number' ? rawVersion : Number(rawVersion ?? 0);
    if (version === SCHEMA_VERSION) return;
    if (!Number.isInteger(version) || version < 0 || version > SCHEMA_VERSION) {
      throw new Error(`Unsupported local store schema version: ${String(rawVersion)}`);
    }
    this.transaction(() => {
      if (version < 1) {
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
        `);
      }
      if (version < 2) {
        this.#db.exec(`
          CREATE INDEX IF NOT EXISTS idx_records_operations_task
            ON records(json_extract(value, '$.taskId'), id)
            WHERE namespace = 'operations';
          CREATE INDEX IF NOT EXISTS idx_records_attempts_task
            ON records(json_extract(value, '$.taskId'), id)
            WHERE namespace = 'attempts';
          CREATE INDEX IF NOT EXISTS idx_records_task_status
            ON records(json_extract(value, '$.status'), id)
            WHERE namespace = 'tasks';
        `);
      }
      this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
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
    if (!subscription.active) return;
    if (subscription.pending) {
      subscription.dirty = true;
      return;
    }
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
      const more = subscription.dirty || batch.length === REPLAY_BATCH_SIZE;
      subscription.dirty = false;
      subscription.pending = false;
      if (more) this.#schedule(subscription);
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

const coreJudgmentOrder = ['tool.injection', 'turn.completion', 'swarm.patch', 'tool.admission', 'model.task_fit', 'memory.capture'];

function summarizeConversationJudgments(rows: readonly { taskId: string; eventJson: string }[]) {
  const replayedTasks = new Set<string>();
  const followUpTriggers = new Map<string, AgentEvent>();
  const parsedRows: AgentEvent[] = [];
  for (const row of rows) {
    const parsed = JSON.parse(row.eventJson) as AgentEvent;
    if (parsed.type === 'tool.evidence_replayed') {
      replayedTasks.add(row.taskId);
    } else if (parsed.type === 'turn.followup_triggered' && parsed.correlationId) {
      followUpTriggers.set(parsed.correlationId, parsed);
    } else if (parsed.type === 'judgment.evaluated' && parsed.payload) {
      parsedRows.push(parsed);
    }
  }
  const byTask = new Map<string, { calls: number; interventions: number }>();
  const pointMap = new Map<string, { point: string; total: number; activeInterventions: number; shadowDisagreements: number; fallbacks: number }>();
  const recent: {
    taskId: string; point: string; mode: 'off' | 'shadow' | 'active';
    impactKind: 'intervened' | 'shadow_diff' | 'fallback' | 'aligned' | 'baseline_only' | 'unconfirmed';
    whatSummary: string; verdictSummary: string; impactSummary: string;
    judgeModel?: string; elapsedMs?: number; fallbackReason?: string;
  }[] = [];
  let total = 0, externalCalls = 0, activeInterventions = 0, shadowDisagreements = 0, fallbacks = 0;
  let injectionBlocks = 0, completionFollowUps = 0, admissionOmissions = 0, patchFlags = 0, memoryFiltered = 0;
  let estimatedCostUsd: number | null = null;

  for (const decision of parsedRows) {
    const { taskId, correlationId, payload } = decision;
    const mode = payload.mode === 'active' || payload.mode === 'shadow' ? payload.mode : 'off';
    if (mode === 'off') continue;
    const point = typeof payload.id === 'string' ? payload.id : 'unknown';
    const judgeStatus = typeof payload.judgeStatus === 'string' ? payload.judgeStatus : undefined;
    const fallbackReason = typeof payload.fallbackReason === 'string' ? payload.fallbackReason : undefined;
    const judgeModel = typeof payload.judgeModel === 'string' ? payload.judgeModel : undefined;
    const elapsedMs = typeof payload.elapsedMs === 'number' && Number.isFinite(payload.elapsedMs) ? payload.elapsedMs : undefined;
    const features = (payload.features && typeof payload.features === 'object' ? payload.features : {}) as Record<string, unknown>;
    const batch = (payload.batch && typeof payload.batch === 'object' ? payload.batch : undefined) as {
      baseline?: unknown[]; output?: unknown[]; judgeOutput?: unknown[];
    } | undefined;
    const baseArr = Array.isArray(batch?.baseline) ? batch.baseline.map(v => v === true) : undefined;
    const outArr = Array.isArray(batch?.output) ? batch.output.map(v => v === true) : undefined;
    const judgeArr = Array.isArray(batch?.judgeOutput) ? batch.judgeOutput : undefined;
    const disagree = payload.disagreement === true ||
      (baseArr && outArr ? baseArr.some((val, idx) => val !== outArr[idx]) : payload.output !== payload.baseline);

    total++;
    const requested = payload.requestSent === true ||
      (judgeStatus !== undefined && judgeStatus !== 'baseline' && fallbackReason !== 'no_choice');
    if (requested) externalCalls++;
    const usage = payload.usage as { estimatedCostUsd?: unknown } | undefined;
    if (typeof usage?.estimatedCostUsd === 'number' && Number.isFinite(usage.estimatedCostUsd) && usage.estimatedCostUsd >= 0) {
      estimatedCostUsd = (estimatedCostUsd ?? 0) + usage.estimatedCostUsd;
    }

    const isFallback = judgeStatus !== undefined && judgeStatus !== 'baseline' && judgeStatus !== 'valid' && fallbackReason !== 'no_choice';
    const completionTriggered = isCompletionFollowUp(decision, correlationId ? followUpTriggers.get(correlationId) : undefined);
    const impactKind = isFallback ? 'fallback'
      : point === 'turn.completion' && mode === 'active' && payload.output === true ? (completionTriggered ? 'intervened' : 'unconfirmed')
        : mode === 'active' && disagree ? 'intervened'
        : mode === 'shadow' && disagree ? 'shadow_diff' : 'aligned';
    if (impactKind === 'intervened') activeInterventions++;
    if (impactKind === 'shadow_diff' || (mode === 'shadow' && disagree)) shadowDisagreements++;
    if (isFallback) fallbacks++;

    const taskStat = byTask.get(taskId) ?? { calls: 0, interventions: 0 };
    taskStat.calls++;
    if (impactKind === 'intervened') taskStat.interventions++;
    byTask.set(taskId, taskStat);

    const pStat = pointMap.get(point) ?? { point, total: 0, activeInterventions: 0, shadowDisagreements: 0, fallbacks: 0 };
    pStat.total++;
    if (impactKind === 'intervened') pStat.activeInterventions++;
    if (mode === 'shadow' && disagree) pStat.shadowDisagreements++;
    if (isFallback) pStat.fallbacks++;
    pointMap.set(point, pStat);

    const batchLen = outArr?.length ?? baseArr?.length ?? 0;
    const baseTrue = baseArr?.filter(Boolean).length ?? 0;
    const outTrue = outArr?.filter(Boolean).length ?? 0;
    let whatSummary = `评估 ${point}`;
    let verdictSummary = '';
    let impactSummary = '';

    if (point === 'tool.injection') {
      const toolName = typeof features.tool === 'string' ? features.tool : '工具输出';
      whatSummary = `扫描 ${toolName} 安全片段 (${batchLen} 段)`;
      verdictSummary = `基线 ${baseTrue}/${batchLen} → 实际拦截 ${outTrue}/${batchLen}`;
      if (mode === 'active') injectionBlocks += outTrue;
      impactSummary = mode === 'active' && outTrue > baseTrue
        ? `额外隔离 ${outTrue - baseTrue} 段可疑注入指令`
        : outTrue > 0 ? `基线已隔离 ${outTrue} 段注入`
          : isFallback ? `回退规则基线 (${fallbackReason ?? judgeStatus})` : '未发现注入威胁，原文放行';
    } else if (point === 'tool.admission') {
      const toolName = typeof features.tool === 'string' ? features.tool : '外部工具';
      const omitted = batchLen - outTrue;
      whatSummary = `筛选 ${toolName} 输出片段 (${batchLen} 段)`;
      verdictSummary = `保留 ${outTrue}/${batchLen} 段 · 折叠 ${omitted} 段`;
      if (mode === 'active') admissionOmissions += omitted;
      impactSummary = mode === 'active' && omitted > 0
        ? `已折叠 ${omitted} 段低相关文本${replayedTasks.has(taskId) ? '（后续按需回放）' : '并归档原文'}`
        : isFallback ? `回退全量保留 (${fallbackReason ?? judgeStatus})` : '全量保留进入上下文';
    } else if (point === 'turn.completion') {
      const role = typeof features.role === 'string' ? features.role : 'root';
      const writes = typeof features.writeCount === 'number' ? features.writeCount : 0;
      whatSummary = `审查 ${role} 交付完整度 (写入 ${writes} 次)`;
      const out = payload.output === true;
      verdictSummary = `基线=${payload.baseline === true ? '不足' : '放行'} → 实际=${out ? '补充验证' : '放行'}`;
      if (completionTriggered) completionFollowUps++;
      impactSummary = completionTriggered ? '拦截过早收尾，触发补充自检轮次'
        : impactKind === 'unconfirmed' ? '建议补充自检，未记录到由此判定触发的续跑'
        : impactKind === 'shadow_diff' ? 'Shadow 建议补充检查（未拦截）'
          : isFallback ? `回退基线放行 (${fallbackReason ?? judgeStatus})` : '允许回合正常收尾';
    } else if (point === 'swarm.patch') {
      const writes = typeof features.writeCount === 'number' ? features.writeCount : 0;
      const targets = typeof features.targetCount === 'number' ? features.targetCount : 0;
      whatSummary = `审查子 Agent 补丁范围 (写入 ${writes} · 路径 ${targets})`;
      const out = payload.output === true;
      verdictSummary = `实际=${out ? '标记越界提醒' : '范围合规'}`;
      if (mode === 'active' && out) patchFlags++;
      impactSummary = mode === 'active' && out ? '已标记 patch_scope_review 提醒主 Agent 复核'
        : isFallback ? `回退基线放行 (${fallbackReason ?? judgeStatus})` : '补丁范围符合子目标约束';
    } else if (point === 'model.task_fit') {
      const count = Array.isArray(features.candidates) ? features.candidates.length : 0;
      whatSummary = `评估 ${count} 个候选模型路由适配度`;
      verdictSummary = `基线 #${String(payload.baseline ?? 0)} → 实际 #${String(payload.output ?? 0)}`;
      impactSummary = mode === 'active' && disagree ? `已切换至候选模型 #${String(payload.output)}`
        : impactKind === 'shadow_diff' ? `Shadow 推荐 #${String(payload.shadow ?? payload.judgeOutput)}（未切换）`
          : '沿用基线模型路由';
    } else if (point === 'memory.capture') {
      const dropped = batchLen - outTrue;
      whatSummary = `筛选长期记忆候选 (${batchLen} 条)`;
      verdictSummary = `保留 ${outTrue}/${batchLen} 条（过滤 ${dropped} 条）`;
      if (mode === 'active') memoryFiltered += dropped;
      impactSummary = mode === 'active' && dropped > 0 ? `已过滤 ${dropped} 条低价值记忆`
        : `保留 ${outTrue} 条进入持久化`;
    } else {
      verdictSummary = batch ? `保留 ${outTrue}/${batchLen} (Jev ${judgeArr?.filter(v => v === true).length ?? 0})`
        : `基线 ${String(payload.baseline ?? '—')} → 实际 ${String(payload.output ?? '—')}`;
      impactSummary = impactKind === 'intervened' ? 'Active 模式改写了规则基线'
        : impactKind === 'shadow_diff' ? 'Shadow 与基线存在分歧'
          : isFallback ? `回退基线 (${fallbackReason ?? judgeStatus})` : '与基线一致';
    }

    recent.push({
      taskId, point, mode, impactKind, whatSummary, verdictSummary, impactSummary,
      ...(judgeModel ? { judgeModel } : {}),
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      ...(fallbackReason ? { fallbackReason } : {}),
    });
  }

  const byPoint = [...pointMap.values()].sort((left, right) => {
    const li = coreJudgmentOrder.indexOf(left.point);
    const ri = coreJudgmentOrder.indexOf(right.point);
    if (li >= 0 && ri >= 0) return li - ri;
    if (li >= 0) return -1;
    if (ri >= 0) return 1;
    return left.point.localeCompare(right.point);
  });

  return {
    byTask,
    summary: {
      total, externalCalls, activeInterventions, shadowDisagreements, fallbacks,
      injectionBlocks, completionFollowUps, admissionOmissions, patchFlags, memoryFiltered,
      estimatedCostUsd, byPoint, recent: recent.slice(-24).reverse(),
    },
  };
}
