import type { ServerResponse } from 'node:http'
import { bearer, bodyRecord, HttpError, json, listenLoopback, validLocalToken } from '../../shared/loopback-http.ts'
import type { AgentEvent } from './contracts/domain.ts'
import type { LocalAgentHost } from './host.ts'
import { evaluationEvidence } from './telemetry-evidence.ts'
import { isTaskId, telemetryEvent } from './telemetry-projection.ts'

type TelemetrySource = Pick<LocalAgentHost, 'telemetryHeads' | 'telemetrySnapshot' | 'getHistory' | 'events' | 'subscribe'>
const tasksPath = /^\/v1\/tasks\/([^/]+)(?:\/(events|evidence))?$/u
const pageSize = 128
const maxWatch = 48

function cursor(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new HttpError(400, 'Invalid cursor')
  return value
}

function checkedTask<T>(operation: () => T): T {
  try { return operation() } catch { throw new HttpError(404, 'Task unavailable') }
}

function waitForChange(host: TelemetrySource, watches: { id: string; after: number }[], res: ServerResponse): Promise<boolean> {
  return new Promise(resolve => {
    const unsubscribes: (() => void)[] = []
    const finish = (changed: boolean) => {
      clearTimeout(timer)
      res.off('close', closed)
      for (const unsubscribe of unsubscribes) unsubscribe()
      resolve(changed)
    }
    const closed = () => finish(false)
    const timer = setTimeout(closed, 1_500)
    res.once('close', closed)
    for (const { id, after } of watches) {
      try { unsubscribes.push(host.subscribe(id, after, (_event: AgentEvent) => finish(true))) }
      catch { /* The task may have disappeared after listing. The next discovery will reconcile it. */ }
    }
  })
}

export function startTelemetryHttp(host: TelemetrySource, { port, token }: { port: number; token: string }) {
  if (!validLocalToken(token)) throw new Error('Invalid telemetry access token')
  return listenLoopback(port, async (req, res, url) => {
    bearer(req, token)
    if (req.method === 'GET' && url.pathname === '/v1/tasks') {
      const before = url.searchParams.get('before')
      if (before !== null && !isTaskId(before)) throw new HttpError(400, 'Invalid task page cursor')
      const tasks = host.telemetryHeads(before, pageSize)
      json(res, { schemaVersion: 1, tasks, next: tasks.length === pageSize ? tasks.at(-1)!.id : null })
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/watch') {
      const { tasks } = await bodyRecord(req)
      if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > maxWatch) throw new HttpError(400, 'Invalid task watch list')
      const watches = tasks.map(value => {
        if (!value || !isTaskId(value.id)) throw new HttpError(400, 'Invalid task watch')
        return { id: value.id, after: cursor(value.after) }
      })
      json(res, { schemaVersion: 1, changed: await waitForChange(host, watches, res) })
      return
    }
    const [, id, kind] = tasksPath.exec(url.pathname) ?? []
    if (!isTaskId(id)) throw new HttpError(404, 'Unknown telemetry route')
    if (req.method === 'GET' && !kind) json(res, checkedTask(() => host.telemetrySnapshot(id)))
    else if (req.method === 'GET' && kind === 'events') {
      const raw = url.searchParams.get('after') ?? '0'
      if (!/^\d{1,16}$/u.test(raw)) throw new HttpError(400, 'Invalid cursor')
      const after = cursor(Number(raw))
      const events = checkedTask(() => host.events(id, after, pageSize)).map(telemetryEvent)
      json(res, { schemaVersion: 1, events })
    } else if (req.method === 'POST' && kind === 'evidence') {
      const { nodeId, artifacts = [] } = await bodyRecord(req)
      if (nodeId !== undefined && !isTaskId(nodeId)) throw new HttpError(400, 'Invalid node ID')
      if (!Array.isArray(artifacts) || artifacts.length > 6 || artifacts.some(value => typeof value !== 'string' || value.length < 1 || value.length > 512)) {
        throw new HttpError(400, 'Invalid artifact selection')
      }
      const controller = new AbortController()
      const closed = () => controller.abort()
      res.once('close', closed)
      try {
        const history = checkedTask(() => host.getHistory(id))
        const before = checkedTask(() => host.telemetrySnapshot(id)).cursor
        const result = await evaluationEvidence(history, nodeId, artifacts, AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]))
          .catch(() => { throw new HttpError(409, 'Evaluation evidence unavailable') })
        if (checkedTask(() => host.telemetrySnapshot(id)).cursor !== before) throw new HttpError(409, 'The task changed during evidence capture')
        json(res, result)
      } finally { res.off('close', closed) }
    } else throw new HttpError(405, 'Method not supported by telemetry')
  })
}
