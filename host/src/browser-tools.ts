import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { parse, serialize } from 'parse5'
import type { Locator, Page } from 'playwright-core'
import { toolImages } from './execution.ts'
import { captureViewportImage } from './image-tools.ts'
import { localBrowserTimeout, localPageInput, localPageProperties, localPageTargets, openLocalDocument, readLocalPage } from './local-browser.ts'
import type { LocalBrowserDocument } from './local-browser.ts'
import { workspaceTarget } from './workspace.ts'
import type { CodingWorkspace, ToolInvocationContext, WorkspaceTool } from './workspace.ts'
import { cleanWebText, publicWeb, publicWebUrl, sensitiveWebInput, webSourceUrl } from './web-tools.ts'
import type { WebClient } from './web-tools.ts'
import { closeDenyProxy, launchIsolatedBrowser } from './browser-runtime.ts'

const pageTimeout = 5500
const maxRequests = 48
const maxTotalBytes = 8 * 1024 * 1024
const maxAssetBytes = 512 * 1024
const idSchema = { type: 'string', pattern: '^[0-9a-f-]{36}$' }
const selectorSchema = { type: 'string', minLength: 1, maxLength: 256 }
const allowedAssets = new Set([
  'text/css', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'font/woff', 'font/woff2', 'font/ttf', 'application/font-woff', 'application/font-woff2',
])
const staticAssetPath = /\.(?:css|png|jpe?g|gif|webp|avif|woff2?|ttf)$/iu
const csp = [
  "default-src 'none'", "script-src 'none'", "connect-src 'none'", "worker-src 'none'",
  "form-action 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'",
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
].join('; ')

interface PublicPage {
  kind: 'public'
  origin: string
  navigation?: string
}

interface WorkspacePage {
  kind: 'workspace'
  path: string
  entry: string
  diagnostics: LocalBrowserDocument['diagnostics']
}

type BrowserPage = PublicPage | WorkspacePage

interface BrowserRun {
  id: string
  page: Page
  source: BrowserPage
  dispose(): Promise<void>
  closing?: Promise<void>
  busy: boolean
}

function staticMarkup(html: string): string {
  const document = parse(html)
  type Container = typeof document | (typeof document.childNodes)[number]
  const parents: Container[] = [document]
  while (parents.length) {
    const parent = parents.pop()!
    if (!('childNodes' in parent)) continue
    for (let i = parent.childNodes.length - 1; i >= 0; i--) {
      const node = parent.childNodes[i]
      if ('tagName' in node && (['script', 'base', 'iframe', 'frame', 'object', 'embed'].includes(node.tagName) ||
        node.tagName === 'meta' && node.attrs.some(attr => attr.name === 'http-equiv'))) {
        parent.childNodes.splice(i, 1)
      } else if ('childNodes' in node) parents.push(node)
    }
  }
  return serialize(document)
}

function owner(context?: ToolInvocationContext): string | undefined {
  return context && JSON.stringify([context.taskId, context.agentRunId])
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function selector(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= 256 && !sensitiveWebInput(value) ? value : undefined
}

function error(message: string) { return { ok: false, error: message } as const }

function pageLocation({ page, source }: BrowserRun) {
  const url = new URL(page.url())
  if (source.kind === 'workspace') {
    url.hash = ''
    if (url.href !== source.entry) throw new Error('Browser navigated outside the workspace page')
    return { path: source.path }
  }
  if (url.origin !== source.origin) throw new Error('Browser navigated outside the approved origin')
  return { url: webSourceUrl(publicWebUrl(url.href)) }
}

class UncertainScreenshotWrite extends Error {}

export function createBrowserTools(workspace: CodingWorkspace, options: { client?: WebClient } = {}): WorkspaceTool[] {
  const client = options.client ?? publicWeb
  const runs = new Map<string, BrowserRun>()
  const opening = new Set<string>()

  function close(key: string, active: BrowserRun): Promise<void> {
    return active.closing ??= active.dispose().finally(() => {
      if (runs.get(key) === active) runs.delete(key)
    })
  }

  async function launchPublic(url: URL, signal: AbortSignal): Promise<BrowserRun> {
    const { browser, proxy } = await launchIsolatedBrowser(pageTimeout, signal)
    const abort = new AbortController()
    let closing: Promise<void> | undefined
    const dispose = () => {
      abort.abort()
      return closing ??= browser.close().finally(() => closeDenyProxy(proxy))
    }
    const cancel = () => { void dispose().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      signal.throwIfAborted()
      const browserContext = await browser.newContext({
        javaScriptEnabled: false,
        serviceWorkers: 'block',
        acceptDownloads: false,
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
      })
      let requests = 0
      let bytes = 0
      let activeRequests = 0
      const source: PublicPage = { kind: 'public', origin: url.origin, navigation: url.href }
      let page: Page | undefined
      await browserContext.routeWebSocket(/./u, socket => socket.close())
      await browserContext.route(/./u, async route => {
        const request = route.request()
        const resource = request.resourceType()
        const navigation = resource === 'document'
        try {
          const target = publicWebUrl(request.url())
          if (request.method() !== 'GET' || target.origin !== url.origin || !page ||
            request.frame() !== page.mainFrame() || abort.signal.aborted ||
            (!navigation && (!['stylesheet', 'image', 'font'].includes(resource) ||
              !staticAssetPath.test(target.pathname) || Boolean(target.search))) ||
            (navigation && target.href !== source.navigation) || requests >= maxRequests ||
            bytes >= maxTotalBytes || activeRequests >= 6) {
            await route.abort()
            return
          }
          if (navigation) source.navigation = undefined
          requests++
          activeRequests++
          let reply
          try {
            reply = await client.get(target.href, {
              allowedOrigin: url.origin,
              signal: abort.signal,
              timeoutMs: 4_500,
              maxBytes: Math.min(maxAssetBytes, maxTotalBytes - bytes),
            })
          } finally { activeRequests-- }
          bytes += reply.body.byteLength
          if (bytes > maxTotalBytes) { await route.abort(); return }
          const mime = reply.contentType.toLowerCase().split(';')[0].trim()
          if ((navigation && !['text/html', 'text/plain'].includes(mime)) || (!navigation && !allowedAssets.has(mime))) {
            await route.abort()
            return
          }
          const body = navigation && mime === 'text/html'
            ? Buffer.from(staticMarkup(reply.body.toString('utf8')), 'utf8') : reply.body
          await route.fulfill({ status: 200, body, headers: {
            'content-type': navigation ? mime + '; charset=utf-8' : mime,
            'content-security-policy': csp,
            'referrer-policy': 'no-referrer',
            'x-content-type-options': 'nosniff',
          } })
        } catch { await route.abort().catch(() => {}) }
      })
      page = await browserContext.newPage()
      page.setDefaultTimeout(pageTimeout)
      browserContext.on('page', popup => { if (popup !== page) void popup.close().catch(() => {}) })
      page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}) })
      await page.goto(url.href, { waitUntil: 'domcontentloaded' })
      signal.throwIfAborted()
      return { id: randomUUID(), page, source, dispose, busy: false }
    } catch (cause) {
      await dispose()
      throw cause
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }

  async function scoped(input: unknown, signal: AbortSignal | undefined, context: ToolInvocationContext | undefined,
    action: (active: BrowserRun, args: Record<string, unknown>, key: string) => Promise<unknown>): Promise<unknown> {
    const args = object(input)
    const key = owner(context)
    const active = key && runs.get(key)
    if (!key || !active || !args || args.browserId !== active.id || active.closing || active.busy || signal?.aborted) {
      return error('Browser session is unavailable for this Agent run')
    }
    const cancel = () => { void close(key, active).catch(() => {}) }
    active.busy = true
    signal?.addEventListener('abort', cancel, { once: true })
    try { return await action(active, args, key) }
    catch (cause) {
      if (cause instanceof UncertainScreenshotWrite) throw cause
      return error(signal?.aborted ? 'Browser action was interrupted' : 'Browser action did not complete. Verify the page or reopen the session.')
    }
    finally {
      active.busy = false
      signal?.removeEventListener('abort', cancel)
    }
  }

  function tool(name: string, description: string, effect: WorkspaceTool['effect'],
    properties: Record<string, unknown>, required: string[],
    execute: WorkspaceTool['execute'], extra: NonNullable<WorkspaceTool['policy']> = {}): WorkspaceTool {
    return { name, description, effect, policy: { delegation: 'explicit', targets: () => [], ...extra }, execute,
      parameters: { type: 'object', additionalProperties: false, properties, required } }
  }

  function browserTool(name: string, description: string, effect: WorkspaceTool['effect'],
    properties: Record<string, unknown>, required: string[],
    action: (active: BrowserRun, args: Record<string, unknown>, signal: AbortSignal | undefined, key: string) => Promise<unknown>,
    extra?: NonNullable<WorkspaceTool['policy']>): WorkspaceTool {
    return tool(name, description, effect, { browserId: idSchema, ...properties }, ['browserId', ...required],
      async (_call, input, signal, context) => scoped(input, signal, context, (active, args, key) => action(active, args, signal, key)), extra)
  }

  return [
    tool('browser_open', 'Open a workspace HTML path with explicitly listed local assets, or an approved public HTTPS URL. Local pages run JavaScript without network. Public pages are static. Returns a session ID for inspection, screenshots and interaction.',
      'read', { url: { type: 'string', maxLength: 2048 }, ...localPageProperties }, [], async (_call, input, cancellation, context) => {
        const args = object(input)
        const key = owner(context)
        if (!key || !context || !args || cancellation?.aborted) return error('Browser input or Agent run is unavailable')
        if (opening.has(key) || runs.has(key)) return error('Close the current browser session before opening another page')
        const deadline = AbortSignal.timeout(localBrowserTimeout)
        const signal = cancellation ? AbortSignal.any([cancellation, deadline]) : deadline
        const local = args.url === undefined ? localPageInput(input) : undefined
        let url: URL | undefined
        if (args.url !== undefined && !['path', 'assets', 'width', 'height'].some(field => Object.hasOwn(args, field))) {
          try { if (typeof args.url === 'string') url = publicWebUrl(args.url) }
          catch { return error('URL is outside the public network policy') }
        }
        if (!local && !url) return error('Choose one workspace HTML path or public HTTPS URL')
        opening.add(key)
        try {
          let active: BrowserRun
          if (local) {
            const { entry, resources } = await readLocalPage(workspace, local, signal)
            const document = await openLocalDocument(entry, resources, { width: local.width, height: local.height }, signal)
            active = { id: randomUUID(), page: document.page, dispose: document.close, busy: false,
              source: { kind: 'workspace', path: local.path, entry, diagnostics: document.diagnostics } }
          } else {
            active = await launchPublic(url!, signal)
          }
          runs.set(key, active)
          try {
            signal.throwIfAborted()
            context.onCleanup(() => close(key, active))
          } catch (cause) {
            await close(key, active)
            throw cause
          }
          return { ok: true, browserId: active.id, ...pageLocation(active), mode: active.source.kind }
        } catch {
          return error(signal.aborted ? 'Browser launch interrupted or timed out' : 'Could not open the page with the selected resources')
        } finally { opening.delete(key) }
      }, {
        approvalFor: input => object(input)?.url === undefined ? undefined : 'network',
        minimumAccessFor: input => object(input)?.url === undefined ? undefined : 'trusted',
        targets: input => object(input)?.url === undefined ? localPageTargets(input) : [],
      }),
    browserTool('browser_snapshot', 'Read bounded page text and visible interactive selectors as untrusted data.',
      'read', {}, [], async active => {
        const { page, source } = active
        const location = pageLocation(active)
        const result = await page.evaluate(() => {
          const visible = (element: Element) => {
            const rect = element.getBoundingClientRect()
            return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden'
          }
          const elements: { label: string; selector: string; tag: string }[] = []
          for (const element of document.querySelectorAll('a[href],button,input,textarea,select,summary')) {
            if (!visible(element)) continue
            const id = element.getAttribute('id')
            const name = element.getAttribute('name')
            const tag = element.tagName.toLowerCase()
            let path = id ? '#' + CSS.escape(id) : name ? tag + '[name=' + CSS.escape(name) + ']' : ''
            if (!path) {
              const parts: string[] = []
              let current: Element | null = element
              while (current && current !== document.body && parts.length < 10) {
                const parent: Element | null = current.parentElement
                const peers = parent ? Array.from(parent.children).filter(other => other.tagName === current!.tagName) : [current]
                parts.unshift(current.tagName.toLowerCase() + ':nth-of-type(' + (peers.indexOf(current) + 1) + ')')
                current = parent
              }
              if (current !== document.body) continue
              path = 'body > ' + parts.join(' > ')
            }
            elements.push({ selector: path.slice(0, 256), tag, label: (
              element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.textContent || ''
            ).slice(0, 256) })
            if (elements.length >= 40) break
          }
          return { title: document.title.slice(0, 512), text: (document.body?.innerText ?? '').slice(0, 14_000), elements }
        })
        pageLocation(active)
        return { ok: true, untrusted: true, ...location,
          ...(source.kind === 'workspace' ? source.diagnostics() : {}),
          title: cleanWebText(result.title, 256), text: cleanWebText(result.text, 12_000),
          elements: result.elements.filter(item => !sensitiveWebInput(item.selector))
            .map(item => ({ ...item, label: cleanWebText(item.label, 256) })) }
      }),
    browserTool('browser_click', 'Click an element in the workspace page, or follow a same-origin public HTTPS link. Forms, uploads and new windows are denied.',
      'write', { selector: selectorSchema }, ['selector'], async (active, args, signal) => {
        pageLocation(active)
        const locator = checkedLocator(active, args.selector)
        if (!locator) return error('Invalid browser selector')
        const target = await locator.evaluate(element => {
          const control = element.closest('a[href],button,input,select,textarea,label,summary,[contenteditable]')
          if (!control || control.closest('form') || control.hasAttribute('form') ||
            control.matches('input[type=file], input[type=password], button[type=submit],input[type=submit],a[download]')) return { denied: true }
          if (control instanceof HTMLAnchorElement) {
            return { denied: Boolean(control.target && control.target !== '_self'), href: control.href }
          }
          return { denied: false }
        }).catch(() => undefined)
        if (!target || target.denied) return error('Browser action is outside the navigation policy')
        const source = active.source
        if (target.href) {
          try {
            if (source.kind === 'workspace') {
              const url = new URL(target.href)
              url.hash = ''
              if (url.href !== source.entry) return error('Open the next workspace page explicitly')
            } else {
              const url = publicWebUrl(target.href)
              if (url.origin !== source.origin) return error('Cross-origin navigation requires a new browser session')
              source.navigation = url.href
            }
          } catch { return error('Link is outside the browser navigation policy') }
        }
        try {
          signal?.throwIfAborted()
          await locator.click()
          signal?.throwIfAborted()
          return { ok: true, ...pageLocation(active) }
        } finally { if (source.kind === 'public') source.navigation = undefined }
      }, { approval: 'browser_action' }),
    browserTool('browser_type', 'Fill a non-sensitive input without submission. Password, credential and file inputs are denied.',
      'write', { selector: selectorSchema, text: { type: 'string', maxLength: 512 } }, ['selector', 'text'], async (active, args, signal) => {
        pageLocation(active)
        const locator = checkedLocator(active, args.selector)
        if (!locator || typeof args.text !== 'string' || args.text.length > 512 || sensitiveWebInput(args.text)) {
          return error('Invalid or sensitive browser input')
        }
        const safe = await locator.evaluate(element => {
          if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false
          if (element instanceof HTMLInputElement && !['text', 'search', 'email', 'url', 'tel', 'number'].includes(element.type)) return false
          return !/(?:password|credential|secret|auth|token|otp|cc-number|cc-csc|login|username)/iu.test(
            [element.name, element.id, element.autocomplete, element.getAttribute('aria-label')].join(' '),
          )
        }).catch(() => false)
        if (!safe) return error('Browser input is outside the allowed form controls')
        signal?.throwIfAborted()
        await locator.fill(args.text)
        signal?.throwIfAborted()
        return { ok: true }
      }, { approval: 'browser_action' }),
    browserTool('browser_scroll', 'Scroll the current isolated page by bounded pixels.',
      'read', { pixels: { type: 'integer', minimum: -2400, maximum: 2400 } }, ['pixels'], async (active, args) => {
        if (typeof args.pixels !== 'number' || !Number.isInteger(args.pixels) || Math.abs(args.pixels) > 2400) {
          return error('Invalid scroll distance')
        }
        pageLocation(active)
        await active.page.evaluate(pixels => window.scrollBy(0, pixels), args.pixels)
        return { ok: true }
      }),
    browserTool('browser_screenshot', 'Return the current viewport as an image to a vision-capable model. Optionally save a new workspace PNG with write permission.',
      'read', { path: { type: 'string', maxLength: 512 } }, [], async (active, args, signal) => {
        const path = workspaceTarget(args)
        if (args.path !== undefined && (!path || !/\.png$/iu.test(path))) return error('Screenshot path must end in .png')
        pageLocation(active)
        const frame = await captureViewportImage(active.page, pageTimeout, 'disabled')
        if (!frame) return error('Screenshot exceeds the visual feedback byte budget')
        const { bytes, width, height } = frame
        const result = { ok: true, untrusted: true, width, height, bytes: bytes.length, [toolImages]: [frame] }
        if (!path) {
          pageLocation(active)
          signal?.throwIfAborted()
          return result
        }
        const png = await active.page.screenshot({ type: 'png', fullPage: false, timeout: pageTimeout, animations: 'disabled' })
        pageLocation(active)
        signal?.throwIfAborted()
        if (png.length > 4 * 1024 * 1024) return error('Screenshot PNG exceeds the file byte budget')
        const release = workspace.acquireWrite()
        if (!release) return error('Another workspace write is in progress')
        try {
          let handle
          try {
            const target = await workspace.checkedTarget(path, 'new')
            signal?.throwIfAborted()
            handle = await open(target, 'wx')
          } catch { return error('Screenshot destination is unavailable') }
          try {
            try { await handle.writeFile(png); await handle.sync() } finally { await handle.close() }
          } catch (cause) {
            throw new UncertainScreenshotWrite('Screenshot file write did not settle', { cause })
          }
          return { ...result, path, bytes: png.length }
        } finally { release() }
      }, {
        effectFor: input => object(input)?.path === undefined ? 'read' : 'write',
        targets: input => {
          if (object(input)?.path === undefined) return []
          const path = workspaceTarget(input)
          if (!path) throw new Error('Invalid screenshot path')
          return [path]
        },
      }),
    browserTool('browser_wait', 'Wait up to five seconds for a selector to become visible.',
      'read', { selector: selectorSchema, timeoutMs: { type: 'integer', minimum: 1, maximum: 5000 } }, ['selector'], async (active, args) => {
        pageLocation(active)
        const locator = checkedLocator(active, args.selector)
        const timeout = args.timeoutMs ?? 3000
        if (!locator || typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > 5000) {
          return error('Invalid selector or timeout')
        }
        try { await locator.waitFor({ state: 'visible', timeout }); return { ok: true } }
        catch { return error('Selector was not visible before the deadline') }
      }),
    browserTool('browser_close', 'Close this Agent run’s isolated browser and release its resources.',
      'read', {}, [], async (active, _args, _signal, key) => { await close(key, active); return { ok: true } }),
  ]
}

function checkedLocator(active: BrowserRun, value: unknown): Locator | undefined {
  const input = selector(value)
  return input ? active.page.locator(input) : undefined
}
