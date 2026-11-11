import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import type { Server } from 'node:net'
import { parse, serialize } from 'parse5'
import type { Browser, Locator, Page } from 'playwright-core'
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

interface BrowserRun {
  id: string
  owner: string
  browser: Browser
  proxy: Server
  page: Page
  abort: AbortController
  origin: string
  navigation?: string
  close?: Promise<void>
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

export function createBrowserTools(workspace: CodingWorkspace, options: { client?: WebClient } = {}): WorkspaceTool[] {
  const client = options.client ?? publicWeb
  let run: BrowserRun | undefined
  let opening = false
  const policy = { rootOnly: true, minimumAccess: 'trusted' as const }

  async function close(active: BrowserRun): Promise<void> {
    active.close ??= (async () => {
      active.abort.abort()
      try { await active.browser.close() } finally {
        await closeDenyProxy(active.proxy)
        if (run === active) run = undefined
      }
    })()
    return active.close
  }

  async function launch(url: URL, context: ToolInvocationContext, signal?: AbortSignal): Promise<BrowserRun> {
    const { browser, proxy } = await launchIsolatedBrowser(pageTimeout, signal)
    const abort = new AbortController()
    try {
      const browserContext = await browser.newContext({
        javaScriptEnabled: false,
        serviceWorkers: 'block',
        acceptDownloads: false,
        viewport: { width: 1280, height: 800 },
      })
      let requests = 0
      let bytes = 0
      let activeRequests = 0
      let expectedNavigation: string | undefined = url.href
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
            (navigation && target.href !== expectedNavigation) || requests >= maxRequests ||
            bytes >= maxTotalBytes || activeRequests >= 6) {
            await route.abort()
            return
          }
          if (navigation) expectedNavigation = undefined
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
      const active: BrowserRun = {
        id: randomUUID(), owner: owner(context)!, browser, proxy, page,
        abort, origin: url.origin,
        get navigation() { return expectedNavigation },
        set navigation(value) { expectedNavigation = value },
      }
      const cancel = () => { void close(active).catch(() => {}) }
      if (signal?.aborted) cancel()
      else signal?.addEventListener('abort', cancel, { once: true })
      try {
        await page.goto(url.href, { waitUntil: 'domcontentloaded' })
        signal?.throwIfAborted()
      } finally { signal?.removeEventListener('abort', cancel) }
      return active
    } catch (cause) {
      abort.abort()
      try { await browser.close() } finally { await closeDenyProxy(proxy) }
      throw cause
    }
  }

  async function scoped(input: unknown, signal: AbortSignal | undefined, context: ToolInvocationContext | undefined,
    action: (active: BrowserRun, args: Record<string, unknown>) => Promise<unknown>): Promise<unknown> {
    const args = object(input)
    const active = run
    if (!active || active.owner !== owner(context) || !args || args.browserId !== active.id ||
      active.abort.signal.aborted || signal?.aborted) return error('Browser session is unavailable for this Agent run')
    const cancel = () => { void close(active).catch(() => {}) }
    signal?.addEventListener('abort', cancel, { once: true })
    try { return await action(active, args) } finally { signal?.removeEventListener('abort', cancel) }
  }

  function tool(name: string, description: string, effect: WorkspaceTool['effect'],
    properties: Record<string, unknown>, required: string[],
    execute: WorkspaceTool['execute'], extra: NonNullable<WorkspaceTool['policy']> = {}): WorkspaceTool {
    return { name, description, effect, policy: { ...policy, ...extra }, execute,
      parameters: { type: 'object', additionalProperties: false, properties, required } }
  }

  function browserTool(name: string, description: string, effect: WorkspaceTool['effect'],
    properties: Record<string, unknown>, required: string[],
    action: (active: BrowserRun, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
    extra?: NonNullable<WorkspaceTool['policy']>): WorkspaceTool {
    return tool(name, description, effect, { browserId: idSchema, ...properties }, ['browserId', ...required],
      async (_call, input, signal, context) => scoped(input, signal, context, (active, args) => action(active, args, signal)), extra)
  }

  return [
    tool('browser_open', 'Open a public HTTPS page in an isolated static browser session. Requires approval for network access.',
      'write', { url: { type: 'string', maxLength: 2048 } }, ['url'], async (_call, input, signal, context) => {
        const args = object(input)
        if (opening || run || !context || typeof args?.url !== 'string' || signal?.aborted) {
          return error('A single browser session is permitted per Agent run')
        }
        let url: URL
        try { url = publicWebUrl(args.url) } catch { return error('URL is outside the public network policy') }
        opening = true
        try {
          const active = await launch(url, context, signal)
          run = active
          try { context.onCleanup(() => close(active)) } catch (cause) {
            await close(active)
            throw cause
          }
          return { ok: true, browserId: active.id, url: webSourceUrl(url) }
        } catch { return error('Could not open an isolated browser or load the public page') }
        finally { opening = false }
      }, { approval: 'network' }),
    browserTool('browser_snapshot', 'Read bounded page text and visible interactive selectors as untrusted data.',
      'read', {}, [], async ({ page }) => {
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
        return { ok: true, untrusted: true, url: webSourceUrl(publicWebUrl(page.url())),
          title: cleanWebText(result.title, 256), text: cleanWebText(result.text, 12_000),
          elements: result.elements.filter(item => !sensitiveWebInput(item.selector))
            .map(item => ({ ...item, label: cleanWebText(item.label, 256) })) }
      }),
    browserTool('browser_click', 'Click a static element or same-origin public HTTPS link. Forms, uploads and new windows are denied.',
      'write', { selector: selectorSchema }, ['selector'], async (active, args, signal) => {
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
        if (!target || target.denied) return error('Browser action is outside the static navigation policy')
        if (target.href) {
          try {
            const url = publicWebUrl(target.href)
            if (url.origin !== active.origin) return error('Cross-origin navigation requires a new browser session')
            active.navigation = url.href
          } catch { return error('Link is outside the public network policy') }
        }
        try {
          signal?.throwIfAborted()
          await locator.click()
          if (active.page.url() !== 'about:blank') publicWebUrl(active.page.url())
          signal?.throwIfAborted()
          return { ok: true, url: webSourceUrl(publicWebUrl(active.page.url())) }
        } finally { active.navigation = undefined }
      }, { approval: 'browser_action' }),
    browserTool('browser_type', 'Fill a non-sensitive input without submission. Password, credential and file inputs are denied.',
      'write', { selector: selectorSchema, text: { type: 'string', maxLength: 512 } }, ['selector', 'text'], async (active, args, signal) => {
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
      'write', { pixels: { type: 'integer', minimum: -2400, maximum: 2400 } }, ['pixels'], async ({ page }, args) => {
        if (typeof args.pixels !== 'number' || !Number.isInteger(args.pixels) || Math.abs(args.pixels) > 2400) {
          return error('Invalid scroll distance')
        }
        await page.evaluate(pixels => window.scrollBy(0, pixels), args.pixels)
        return { ok: true }
      }),
    browserTool('browser_screenshot', 'Capture the current viewport to a new PNG file inside the workspace.',
      'write', { path: { type: 'string', maxLength: 512 } }, ['path'], async ({ page }, args, signal) => {
        if (typeof args.path !== 'string' || !/\.png$/iu.test(args.path)) return error('Screenshot path must end in .png')
        let path: string
        try { path = await workspace.checkedTarget(args.path, 'new') } catch { return error('Screenshot path is unavailable') }
        const image = await page.screenshot({ type: 'png', fullPage: false, timeout: pageTimeout, animations: 'disabled' })
        if (image.length > 4 * 1024 * 1024 || signal?.aborted) return error('Screenshot limit exceeded or operation interrupted')
        let handle
        try { handle = await open(path, 'wx') } catch { return error('Screenshot destination is unavailable') }
        try { await handle.writeFile(image); await handle.sync() } finally { await handle.close() }
        return { ok: true, path: args.path, bytes: image.length }
      }),
    browserTool('browser_wait', 'Wait up to five seconds for a selector to become visible.',
      'read', { selector: selectorSchema, timeoutMs: { type: 'integer', minimum: 1, maximum: 5000 } }, ['selector'], async (active, args) => {
        const locator = checkedLocator(active, args.selector)
        const timeout = args.timeoutMs ?? 3000
        if (!locator || typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > 5000) {
          return error('Invalid selector or timeout')
        }
        try { await locator.waitFor({ state: 'visible', timeout }); return { ok: true } }
        catch { return error('Selector was not visible before the deadline') }
      }),
    browserTool('browser_close', 'Close this Agent run’s isolated browser and release its resources.',
      'write', {}, [], async active => { await close(active); return { ok: true } }),
  ]
}

function checkedLocator(active: BrowserRun, value: unknown): Locator | undefined {
  const input = selector(value)
  return input ? active.page.locator(input) : undefined
}
