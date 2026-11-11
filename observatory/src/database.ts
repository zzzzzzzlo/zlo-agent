import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { TelemetryEvent, TelemetryTask } from '../../shared/contracts/observatory.ts'

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export interface EvaluationJob {
  id: string
  taskId: string
  taskRunId: string
  nodeId?: string
  status: JobStatus
  createdAt: string
  automatic: boolean
  result?: unknown
  snapshot?: unknown
  error?: string
}

export class ObservatoryDatabase {
  readonly #db: DatabaseSync
  readonly #lock: DatabaseSync
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.#lock = new DatabaseSync(join(directory, 'observatory.sqlite.writer'))
    let db: DatabaseSync | undefined
    try {
      this.#lock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE')
      db = this.#db = new DatabaseSync(join(directory, 'observatory.sqlite'), { timeout: 2000 })
      this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS streams (task_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0, snapshot TEXT);
      CREATE TABLE IF NOT EXISTS telemetry (task_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT UNIQUE NOT NULL,
        event TEXT NOT NULL, PRIMARY KEY(task_id, seq));
      CREATE TABLE IF NOT EXISTS evaluations (id TEXT PRIMARY KEY, automatic_key TEXT UNIQUE, created_at TEXT NOT NULL,
        status TEXT NOT NULL, job TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      `)
    } catch (error) {
      db?.close()
      this.#lock.close()
      throw error
    }
  }

  close() { try { this.#db.close() } finally { this.#lock.close() } }

  cursor(taskId: string): number {
    return Number(this.#db.prepare('SELECT cursor FROM streams WHERE task_id = ?').get(taskId)?.cursor ?? 0)
  }

  cursors(): Map<string, number> {
    return new Map(this.#db.prepare('SELECT task_id, cursor FROM streams').all().map(row => [String(row.task_id), Number(row.cursor)]))
  }

  ingest(taskId: string, batch: TelemetryEvent[]): number {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      let cursor = this.cursor(taskId)
      const duplicate = this.#db.prepare('SELECT id FROM telemetry WHERE task_id = ? AND seq = ?')
      const insert = this.#db.prepare('INSERT INTO telemetry(task_id, seq, id, event) VALUES (?, ?, ?, ?)')
      for (const event of batch) {
        if (event.taskId !== taskId) throw new Error('Event does not match task stream')
        if (event.seq <= cursor) {
          if (duplicate.get(taskId, event.seq)?.id !== event.id) throw new Error('Event identity conflict')
          continue
        }
        if (event.seq !== cursor + 1) throw new Error('Event sequence gap')
        insert.run(taskId, event.seq, event.id, JSON.stringify(event))
        cursor = event.seq
      }
      this.#db.prepare(`INSERT INTO streams(task_id,cursor) VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET cursor=excluded.cursor`).run(taskId, cursor)
      this.#db.exec('COMMIT')
      return cursor
    } catch (error) { this.#db.exec('ROLLBACK'); throw error }
  }

  saveSnapshot(snapshot: TelemetryTask) {
    this.#db.prepare(`INSERT INTO streams(task_id,snapshot) VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET snapshot=excluded.snapshot`)
      .run(snapshot.id, JSON.stringify(snapshot))
  }

  task(id: string): TelemetryTask | undefined {
    const row = this.#db.prepare('SELECT snapshot FROM streams WHERE task_id = ?').get(id)
    return row?.snapshot ? JSON.parse(String(row.snapshot)) : undefined
  }

  tasks(): TelemetryTask[] {
    return this.#db.prepare('SELECT snapshot FROM streams WHERE snapshot IS NOT NULL ORDER BY task_id').all().map(row => JSON.parse(String(row.snapshot)))
  }

  events(taskId: string): TelemetryEvent[] {
    return this.#db.prepare('SELECT event FROM telemetry WHERE task_id = ? ORDER BY seq').all(taskId).map(row => JSON.parse(String(row.event)))
  }

  allEvents(): TelemetryEvent[] {
    return this.#db.prepare('SELECT event FROM telemetry ORDER BY task_id, seq').all().map(row => JSON.parse(String(row.event)))
  }

  addJob(job: EvaluationJob, key?: string): boolean {
    return this.#db.prepare('INSERT INTO evaluations VALUES (?, ?, ?, ?, ?) ON CONFLICT(automatic_key) DO NOTHING')
      .run(job.id, key ?? null, job.createdAt, job.status, JSON.stringify(job)).changes === 1
  }

  saveJob(job: EvaluationJob) {
    this.#db.prepare('UPDATE evaluations SET status = ?, job = ? WHERE id = ?').run(job.status, JSON.stringify(job), job.id)
  }

  job(id: string): EvaluationJob | undefined {
    const row = this.#db.prepare('SELECT job FROM evaluations WHERE id = ?').get(id)
    return row ? JSON.parse(String(row.job)) : undefined
  }

  jobs(pending = false): EvaluationJob[] {
    const sql = pending ? "SELECT job FROM evaluations WHERE status IN ('queued','running') ORDER BY created_at"
      : 'SELECT job FROM evaluations ORDER BY created_at DESC, id DESC LIMIT 200'
    return this.#db.prepare(sql).all().map(row => JSON.parse(String(row.job)))
  }

  automaticSince(): string | null {
    const value = this.#db.prepare("SELECT value FROM settings WHERE name = 'automatic'").get()?.value
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
  }

  setAutomatic(automatic: boolean) {
    const value = automatic ? this.automaticSince() ?? new Date().toISOString() : 'disabled'
    this.#db.prepare("INSERT INTO settings VALUES ('automatic', ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run(value)
  }
}
