import { extname } from 'node:path'
import type { Page } from 'playwright-core'
import { closeDenyProxy, launchIsolatedBrowser } from './browser-runtime.ts'
import { previewImageLimits, toolImages } from './execution.ts'
import type { ToolImage } from './execution.ts'
import { workspaceTarget } from './workspace.ts'
import type { CodingWorkspace, WorkspaceTool } from './workspace.ts'

const origin = 'http://zlo-preview.invalid'
const timeoutMs = 12_000
const maxAssets = 16
const maxAssetBytes = 2 * 1024 * 1024
const maxTime = 4_000
const errorKind = /^(?:SyntaxError|ReferenceError|TypeError|RangeError|URIError|EvalError|Error)$/u
const entryTypes = new Set(['.htm', '.html'])
const assetTypes: ReadonlyMap<string, readonly [string, string]> = new Map([
  ['.css', ['stylesheet', 'text/css; charset=utf-8']], ['.js', ['script', 'text/javascript; charset=utf-8']],
  ['.mjs', ['script', 'text/javascript; charset=utf-8']], ['.svg', ['image', 'image/svg+xml']],
  ['.png', ['image', 'image/png']], ['.jpg', ['image', 'image/jpeg']], ['.jpeg', ['image', 'image/jpeg']],
  ['.webp', ['image', 'image/webp']], ['.gif', ['image', 'image/gif']], ['.woff', ['font', 'font/woff']], ['.woff2', ['font', 'font/woff2']],
])
const policy = ["default-src 'none'", "sandbox allow-scripts allow-same-origin", "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'", "connect-src 'none'", "worker-src 'none'",
  "frame-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'none'"].join('; ')

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

function previewInput(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return
  const { path: raw, assets = [], width = 800, height = 600, timesMs = [0] } = input as Record<string, unknown>
  const path = workspaceTarget({ path: raw })
  if (!path || !entryTypes.has(extname(path).toLowerCase()) || !integer(width, 240, previewImageLimits.width) ||
    !integer(height, 160, previewImageLimits.height) || !Array.isArray(assets) || assets.length > maxAssets ||
    !Array.isArray(timesMs) || timesMs.length < 1 || timesMs.length > previewImageLimits.count ||
    !timesMs.every(time => integer(time, 0, maxTime)) || new Set(timesMs).size !== timesMs.length) return
  const selected: string[] = []
  for (const value of assets) {
    const asset = workspaceTarget({ path: value })
    if (!asset || !assetTypes.has(extname(asset).toLowerCase())) return
    if (!selected.includes(asset)) selected.push(asset)
  }
  return { path, assets: selected, width, height, timesMs: [...timesMs].sort((a, b) => a - b) as number[] }
}

const urlFor = (path: string) => origin + '/' + path.split('/').map(segment => encodeURIComponent(segment)).join('/')

async function layoutAt(page: Page, timeMs: number) {
  return page.evaluate(time => {
    for (const animation of document.getAnimations()) {
      if (animation.playState !== 'idle' && animation.playState !== 'finished') {
        animation.pause()
        animation.currentTime = time
      }
    }
    for (const svg of document.querySelectorAll('svg')) {
      svg.pauseAnimations()
      svg.setCurrentTime(time / 1000)
    }
    const root = document.documentElement
    return { overflowX: Math.max(0, root.scrollWidth - innerWidth), overflowY: Math.max(0, root.scrollHeight - innerHeight),
      animations: document.getAnimations().length, svgAnimations: document.querySelectorAll('animate, animateMotion, animateTransform').length }
  }, timeMs)
}

export function createPreviewTools(workspace: CodingWorkspace): WorkspaceTool[] {
  return [{
    name: 'preview_page', effect: 'read', policy: { rootOnly: true },
    description: 'Render a local HTML file in an isolated browser. Specify the exact workspace-relative CSS, JS, SVG, image and font assets it may load. No external network. Supply up to three animation sample times in milliseconds. A vision-capable model receives viewport images; other models receive only structural diagnostics.',
    parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: {
      path: { type: 'string', maxLength: 512 }, assets: { type: 'array', maxItems: maxAssets, items: { type: 'string', maxLength: 512 } },
      width: { type: 'integer', minimum: 240, maximum: previewImageLimits.width },
      height: { type: 'integer', minimum: 160, maximum: previewImageLimits.height },
      timesMs: { type: 'array', minItems: 1, maxItems: previewImageLimits.count, items: { type: 'integer', minimum: 0, maximum: maxTime } },
    } },
    async execute(_id, input, cancellation) {
      const selected = previewInput(input)
      if (!selected) return { ok: false, error: 'Expected a workspace HTML path, bounded viewport and up to three distinct sample times.' }
      const signal = cancellation ? AbortSignal.any([cancellation, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
      const resources = new Map<string, { body: Buffer; resource: string; mime: string }>()
      const entry = urlFor(selected.path)
      try {
        const { text } = await workspace.readTextSnapshot(selected.path, signal)
        const body = Buffer.from(text)
        let bytes = body.length
        resources.set(entry, { body, resource: 'document', mime: 'text/html; charset=utf-8' })
        for (const asset of selected.assets) {
          const body = await workspace.readPreviewAsset(asset, signal)
          bytes += body.length
          if (bytes > maxAssetBytes) return { ok: false, error: 'Selected preview resources exceed the byte budget.' }
          const [resource, mime] = assetTypes.get(extname(asset).toLowerCase())!
          resources.set(urlFor(asset), { body, resource, mime })
        }
      } catch { return { ok: false, error: 'A selected preview file is inaccessible or exceeds the workspace limits.' } }

      let launch: Awaited<ReturnType<typeof launchIsolatedBrowser>> | undefined
      let closing: Promise<void> | undefined
      const close = () => {
        if (launch) {
          const { browser, proxy } = launch
          closing ??= browser.close().catch(() => {}).finally(() => closeDenyProxy(proxy))
        }
        return closing
      }
      const cancel = () => { void close()?.catch(() => {}) }
      let stage = 'launch'
      try {
        launch = await launchIsolatedBrowser(5_500, signal)
        signal.addEventListener('abort', cancel, { once: true })
        signal.throwIfAborted()
        stage = 'setup'
        const context = await launch.browser.newContext({ viewport: { width: selected.width, height: selected.height },
          deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false, offline: true })
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
            if (signal.aborted || ++requests > 64 || !page || request.frame() !== page.mainFrame() || request.method() !== 'GET' ||
              !asset || resource !== asset.resource || resource === 'document' && (!navigation || url.href !== entry)) {
              blockedRequests++
              await route.abort()
              return
            }
            if (resource === 'document') navigation = false
            await route.fulfill({ status: 200, body: asset.body, headers: { 'content-type': asset.mime,
              'content-security-policy': policy, 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
              'permissions-policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), payment=()' } })
          } catch { blockedRequests++; await route.abort().catch(() => {}) }
        })
        page = await context.newPage()
        context.on('page', popup => { if (popup !== page) void popup.close().catch(() => {}) })
        page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}) })
        page.on('console', message => { if (message.type() === 'error') consoleErrors++ })
        page.on('pageerror', error => {
          runtimeErrors++
          const kind = errorKind.test(error.name) ? error.name : 'Error'
          errorKinds.add(kind)
        })
        const time = new Date('2026-01-01T00:00:00Z')
        await page.clock.install({ time })
        await page.clock.pauseAt(new Date(time.valueOf() + 5_000))
        const started = performance.now()
        stage = 'navigation'
        const loaded = await page.goto(entry, { waitUntil: 'load', timeout: 4_500 })
        if (!loaded?.ok() || page.url() !== entry) throw new Error('Preview navigation failed')
        const images: ToolImage[] = []
        const samples = []
        let previous = 0
        for (const timeMs of selected.timesMs) {
          stage = 'sampling'
          signal.throwIfAborted()
          if (timeMs > previous) {
            try { await page.clock.runFor(timeMs - previous) } catch (error) {
              // Playwright surfaces exceptions from virtual timer callbacks as clock errors.
              const kind = error instanceof Error ? /^clock\.runFor: (\w+Error|Error):/u.exec(error.message)?.[1] : undefined
              if (!kind || !errorKind.test(kind) || signal.aborted) throw error
              runtimeErrors++
              errorKinds.add(kind)
            }
          }
          previous = timeMs
          if (page.url() !== entry) throw new Error('Preview navigated away')
          const layout = await layoutAt(page, timeMs)
          let bytes = await page.screenshot({ type: 'jpeg', quality: 74, timeout: 3_000, scale: 'css' })
          if (bytes.length > previewImageLimits.bytes) bytes = await page.screenshot({ type: 'jpeg', quality: 48, timeout: 3_000, scale: 'css' })
          const frame = bytes.length <= previewImageLimits.bytes ? images.push({ bytes, width: selected.width, height: selected.height }) : undefined
          samples.push({ timeMs, frame, ...layout })
        }
        signal.throwIfAborted()
        return { ok: true, untrusted: true, width: selected.width, height: selected.height, samples, renderMs: Math.round(performance.now() - started),
          runtimeErrors, consoleErrors, errorKinds: [...errorKinds], blockedRequests, [toolImages]: images }
      } catch {
        return { ok: false, stage, error: signal.aborted ? 'Preview interrupted or timed out.' : `Preview failed during ${stage}.` }
      } finally {
        signal.removeEventListener('abort', cancel)
        await close()
      }
    },
  }]
}
