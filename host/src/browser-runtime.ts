import { createServer } from 'node:net'
import type { Server } from 'node:net'
import type { Browser } from 'playwright-core'

function browserEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'LANG']) {
    const value = process.env[name]
    if (value) env[name] = value
  }
  return env
}

export function closeDenyProxy(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()))
}

export async function launchIsolatedBrowser(timeout: number, signal?: AbortSignal): Promise<{ browser: Browser; proxy: Server }> {
  signal?.throwIfAborted()
  const proxy = createServer(socket => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject)
    proxy.listen(0, '127.0.0.1', resolve)
  })
  let browser: Browser | undefined
  try {
    const address = proxy.address()
    if (!address || typeof address === 'string') throw new Error('Could not start browser relay')
    const { chromium } = await import('playwright-core')
    signal?.throwIfAborted()
    browser = await chromium.launch({
      channel: process.platform === 'win32' ? 'msedge' : undefined,
      chromiumSandbox: true, headless: true, timeout, env: browserEnvironment(),
      proxy: { server: 'http://127.0.0.1:' + address.port, bypass: '<-loopback>' },
      args: ['--disable-quic', '--disable-sync', '--disable-background-networking',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    })
    signal?.throwIfAborted()
    return { browser, proxy }
  } catch (error) {
    try { await browser?.close() } finally { await closeDenyProxy(proxy) }
    throw error
  }
}
