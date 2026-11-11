import { readFile } from 'node:fs/promises'
import { bearer, bodyRecord, HttpError, json, listenLoopback, validLocalToken } from '../../shared/loopback-http.ts'
import { isTaskId } from './collector.ts'
import type { Collector } from './collector.ts'
import type { ObservatoryDatabase } from './database.ts'
import type { EvaluationJobs } from './evaluation-jobs.ts'
import { buildMetrics } from './metrics.ts'
import { buildTrace } from './trace.ts'

const assets = new Map([
  ['/', 'index.html'], ['/index.html', 'index.html'], ['/styles.css', 'styles.css'], ['/dashboard.js', 'dashboard.js'],
  ['/components.js', 'components.js'], ['/trace-view.js', 'trace-view.js'], ['/evaluation-view.js', 'evaluation-view.js'],
])
const contentType: Record<string, string> = { html: 'text/html', css: 'text/css', js: 'text/javascript' }
const tracePath = /^\/api\/tasks\/([^/]+)$/u
const cancelPath = /^\/api\/evaluations\/([^/]+)\/cancel$/u

function filters(url: URL) {
  const read = (name: string) => {
    const value = url.searchParams.get(name) || undefined
    if (value && value.length > 128) throw new HttpError(400, 'Invalid filter')
    return value
  }
  const date = (name: string) => {
    const value = read(name)
    if (!value) return undefined
    const time = Date.parse(value)
    if (!Number.isFinite(time)) throw new HttpError(400, 'Invalid date range')
    return time
  }
  const from = date('from'), to = date('to'), taskId = read('taskId')
  const role = read('role'), provider = read('provider'), model = read('model'), status = read('status')
  if (from !== undefined && to !== undefined && from > to || taskId && !isTaskId(taskId) ||
    role && !['root', 'team', 'worker'].includes(role)) throw new HttpError(400, 'Invalid filter')
  return { from, to, taskId, role, provider, model, status }
}

export function startDashboard(options: { port: number; token: string; database: ObservatoryDatabase; collector: Collector; jobs: EvaluationJobs; model?: string }) {
  const { port, token, database, collector, jobs, model } = options
  if (!validLocalToken(token)) throw new Error('Invalid dashboard token')
  const configuration = () => ({ automatic: database.automaticSince() !== null, model })
  return listenLoopback(port, async (req, res, url) => {
    res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
    const asset = assets.get(url.pathname)
    if (asset && req.method === 'GET') {
      const data = await readFile(new URL('../public/' + asset, import.meta.url))
      res.writeHead(200, { 'content-type': contentType[asset.split('.').at(-1)!] + '; charset=utf-8', 'content-length': data.length })
      res.end(data)
      return
    }
    bearer(req, token)
    if (url.pathname === '/api/overview' && req.method === 'GET') {
      const filter = filters(url)
      const tasks = filter.taskId ? [database.task(filter.taskId)].filter(task => task !== undefined) : database.tasks()
      const events = filter.taskId ? database.events(filter.taskId) : database.allEvents()
      const metrics = buildMetrics(tasks, events, Date.now(), filter)
      const selected = new Set(metrics.taskIds)
      json(res, { tasks: tasks.filter(task => selected.has(task.id)), metrics, health: collector.health() })
      return
    }
    const trace = tracePath.exec(url.pathname)
    if (req.method === 'GET' && trace && isTaskId(trace[1])) {
      const task = database.task(trace[1])
      if (!task) throw new HttpError(404, 'Task unavailable')
      json(res, buildTrace(task, database.events(task.id)))
      return
    }
    if (url.pathname === '/api/evaluations' && req.method === 'GET') {
      json(res, { evaluations: database.jobs(), config: configuration() })
      return
    }
    if (url.pathname === '/api/evaluations' && req.method === 'POST') {
      const { taskId, nodeId, artifacts = [], useModel = false } = await bodyRecord(req)
      if (!isTaskId(taskId) || nodeId !== undefined && !isTaskId(nodeId) || typeof useModel !== 'boolean' ||
        !Array.isArray(artifacts) || artifacts.length > 6 || artifacts.some(path => typeof path !== 'string' || !path || path.length > 512)) {
        throw new HttpError(400, 'Invalid evaluation request')
      }
      if (useModel && !model) throw new HttpError(409, 'Configure an evaluation model before authorizing a model request')
      const task = database.task(taskId)
      if (!task) throw new HttpError(404, 'Task unavailable')
      json(res, { id: jobs.start(task, nodeId, artifacts, useModel) }, 202)
      return
    }
    if (url.pathname === '/api/evaluation-settings' && req.method === 'POST') {
      const { automatic } = await bodyRecord(req)
      if (typeof automatic !== 'boolean') throw new HttpError(400, 'Invalid evaluation setting')
      database.setAutomatic(automatic)
      json(res, configuration())
      return
    }
    const cancel = cancelPath.exec(url.pathname)
    if (req.method === 'POST' && cancel && isTaskId(cancel[1])) {
      if (!jobs.cancel(cancel[1])) throw new HttpError(409, 'Evaluation has already settled')
      json(res, { accepted: true }, 202)
      return
    }
    throw new HttpError(404, 'Unknown dashboard route')
  })
}
