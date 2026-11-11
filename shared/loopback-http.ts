import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'

export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

export function localPort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const port = Number(value)
  if (!/^\d{1,5}$/u.test(value) || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid loopback port')
  return port
}

export function validLocalToken(value: string | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/u.test(value)
}

export function bearer(req: IncomingMessage, secret: string): void {
  const actual = req.headers.authorization
  const expected = 'Bearer ' + secret
  if (!actual || actual.length !== expected.length || !/^[\x20-\x7e]+$/u.test(actual) ||
    !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) throw new HttpError(401, 'Unauthorized')
}

export function json(res: ServerResponse, body: unknown, status = 200) {
  if (res.destroyed || res.writableEnded) return
  const data = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) })
  res.end(data)
}

export async function bodyRecord(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'JSON required')
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length
    if (bytes > 16_384) { req.resume(); throw new HttpError(413, 'Request body too large') }
    chunks.push(chunk)
  }
  let data: unknown
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new HttpError(400, 'Invalid JSON') }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'JSON object required')
  return data as Record<string, unknown>
}

export async function listenLoopback(port: number,
  handler: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void) {
  let origin = ''
  let pending = 0
  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000, keepAliveTimeout: 2_000 }, (req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('x-frame-options', 'DENY')
    if (pending >= 40) { json(res, { error: 'Local service is busy' }, 503); return }
    pending++
    void Promise.resolve().then(async () => {
      if (req.headers.host !== origin.slice('http://'.length) ||
        (req.headers.origin !== undefined && req.headers.origin !== origin)) throw new HttpError(403, 'Forbidden origin')
      if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) throw new HttpError(400, 'Invalid request target')
      await handler(req, res, new URL(req.url, origin))
    }).catch(error => json(res, { error: error instanceof HttpError ? error.message : 'Local request failed' }, error instanceof HttpError ? error.status : 500))
      .finally(() => { pending-- })
  })
  server.maxConnections = 64
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a loopback address')
  origin = `http://127.0.0.1:${address.port}`
  return { origin, close: () => new Promise<void>((resolve) => {
    server.close(() => resolve()); server.closeAllConnections()
  }) }
}
