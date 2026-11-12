import { extname } from 'node:path'
import type { Page } from 'playwright-core'
import { closeDenyProxy, launchIsolatedBrowser } from './browser-runtime.ts'
import { previewImageLimits } from './execution.ts'
import { workspaceTarget } from './workspace.ts'
import type { CodingWorkspace } from './workspace.ts'

const origin = 'http://zlo-preview.invalid'
const maxAssets = 16
const maxAssetBytes = 2 * 1024 * 1024
export const localBrowserTimeout = 12_000
export const localErrorKind = /^(?:SyntaxError|ReferenceError|TypeError|RangeError|URIError|EvalError|Error)$/u
const assetTypes = new Map([
  ['.css', ['stylesheet', 'text/css; charset=utf-8']], ['.js', ['script', 'text/javascript; charset=utf-8']],
  ['.mjs', ['script', 'text/javascript; charset=utf-8']], ['.svg', ['image', 'image/svg+xml']],
  ['.png', ['image', 'image/png']], ['.jpg', ['image', 'image/jpeg']], ['.jpeg', ['image', 'image/jpeg']],
  ['.webp', ['image', 'image/webp']], ['.gif', ['image', 'image/gif']], ['.woff', ['font', 'font/woff']], ['.woff2', ['font', 'font/woff2']],
])
const csp = ["default-src 'none'", "sandbox allow-scripts allow-same-origin", "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'", "connect-src 'none'", "worker-src 'none'",
  "frame-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'none'"].join('; ')

export const localPageProperties = {
  path: { type: 'string', maxLength: 512 },
  assets: { type: 'array', maxItems: maxAssets, items: { type: 'string', maxLength: 512 } },
  width: { type: 'integer', minimum: 240, maximum: previewImageLimits.width },
  height: { type: 'integer', minimum: 160, maximum: previewImageLimits.height },
}

export function boundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

export interface LocalPageInput {
  path: string
  assets: string[]
  width: number
  height: number
}

export function localPageInput(input: unknown): LocalPageInput | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return
  const { path: raw, assets = [], width = 800, height = 600 } = input as Record<string, unknown>
  const path = workspaceTarget({ path: raw })
  if (!path || !/\.html?$/iu.test(path) || !boundedInteger(width, 240, previewImageLimits.width) ||
    !boundedInteger(height, 160, previewImageLimits.height) || !Array.isArray(assets) || assets.length > maxAssets) return
  const selected = new Set<string>()
  for (const value of assets) {
    const asset = workspaceTarget({ path: value })
    if (!asset || !assetTypes.has(extname(asset).toLowerCase())) return
    selected.add(asset)
  }
  return { path, assets: [...selected], width, height }
}

export function localPageTargets(input: unknown): string[] {
  const page = localPageInput(input)
  if (!page) throw new Error('Invalid local page selection')
  return [page.path, ...page.assets]
}

export const localUrlFor = (path: string) => origin + '/' + path.split('/').map(segment => encodeURIComponent(segment)).join('/')

interface Resource {
  body: Buffer
  resource: string
  mime: string
}

export async function readLocalPage(workspace: CodingWorkspace, selection: LocalPageInput, signal: AbortSignal) {
  const entry = localUrlFor(selection.path)
  const { text } = await workspace.readTextSnapshot(selection.path, signal)
  const body = Buffer.from(text)
  let bytes = body.length
  const resources = new Map<string, Resource>([[entry, { body, resource: 'document', mime: 'text/html; charset=utf-8' }]])
  for (const asset of selection.assets) {
    const body = await workspace.readPreviewAsset(asset, signal)
    bytes += body.length
    if (bytes > maxAssetBytes) throw new Error('Local page resources exceed the byte budget')
    const [resource, mime] = assetTypes.get(extname(asset).toLowerCase())!
    resources.set(localUrlFor(asset), { body, resource, mime })
  }
  return { entry, resources }
}

export interface LocalBrowserDocument {
  page: Page
  diagnostics(): { blockedRequests: number; runtimeErrors: number; consoleErrors: number; errorKinds: string[] }
  close(): Promise<void>
}

export async function openLocalDocument(entry: string, resources: ReadonlyMap<string, Resource>,
  viewport: { width: number; height: number }, signal: AbortSignal, options: { sampleTime?: boolean; javaScriptEnabled?: boolean } = {},
): Promise<LocalBrowserDocument> {
  const { browser, proxy } = await launchIsolatedBrowser(5_500, signal)
  const lifetime = new AbortController()
  let closing: Promise<void> | undefined
  const close = () => {
    lifetime.abort()
    return closing ??= browser.close().catch(() => {}).finally(() => closeDenyProxy(proxy))
  }
  const cancel = () => { void close().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, serviceWorkers: 'block',
      acceptDownloads: false, offline: true, javaScriptEnabled: options.javaScriptEnabled ?? true })
    await context.addInitScript(() => {
      for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel']) {
        Object.defineProperty(window, key, { value: undefined, configurable: false, writable: false })
      }
    })
    let blockedRequests = 0, runtimeErrors = 0, consoleErrors = 0, requests = 0
    let navigation = true
    let page: Page | undefined
    const errorKinds = new Set<string>()
    await context.routeWebSocket(/./u, socket => { blockedRequests++; return socket.close() })
    await context.route(/./u, async route => {
      try {
        const request = route.request(), resource = request.resourceType()
        const url = new URL(request.url())
        const asset = !url.search ? resources.get(url.href) : undefined
        if (lifetime.signal.aborted || ++requests > 64 || !page || request.frame() !== page.mainFrame() || request.method() !== 'GET' ||
          !asset || resource !== asset.resource || resource === 'document' && (!navigation || url.href !== entry)) {
          blockedRequests++
          await route.abort()
          return
        }
        if (resource === 'document') navigation = false
        await route.fulfill({ status: 200, body: asset.body, headers: { 'content-type': asset.mime,
          'content-security-policy': csp, 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
          'permissions-policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), payment=()' } })
      } catch { blockedRequests++; await route.abort().catch(() => {}) }
    })
    page = await context.newPage()
    page.setDefaultTimeout(5_500)
    context.on('page', popup => { if (popup !== page) void popup.close().catch(() => {}) })
    page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}) })
    page.on('console', message => { if (message.type() === 'error') consoleErrors++ })
    page.on('pageerror', error => {
      runtimeErrors++
      errorKinds.add(localErrorKind.test(error.name) ? error.name : 'Error')
    })
    if (options.sampleTime) {
      const time = new Date('2026-01-01T00:00:00Z')
      await page.clock.install({ time })
      await page.clock.pauseAt(new Date(time.valueOf() + 5_000))
    }
    const loaded = await page.goto(entry, { waitUntil: 'load', timeout: 4_500 })
    if (!loaded?.ok() || page.url() !== entry) throw new Error('Local page navigation failed')
    signal.throwIfAborted()
    return { page, close, diagnostics: () => ({ blockedRequests, runtimeErrors, consoleErrors, errorKinds: [...errorKinds] }) }
  } catch (error) {
    await close()
    throw error
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
