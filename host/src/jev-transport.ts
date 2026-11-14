import { fetch as proxyFetch, ProxyAgent } from 'undici'
import type { RequestInit as ProxyRequestInit } from 'undici'
import { openCodeJudgeEndpoint } from '../../shared/contracts/jev.ts'

export function openCodeJudgeFetch(proxy: string | undefined, request: typeof fetch = fetch,
  proxied: typeof proxyFetch = proxyFetch): typeof fetch | undefined {
  if (!proxy || proxy.length > 256) return
  const url = URL.parse(proxy)
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    url.pathname !== '/' || url.search || url.hash) return
  const dispatcher = new ProxyAgent(url.href)
  return async (input, options) => {
    if (input !== openCodeJudgeEndpoint) return request(input, options)
    // The bundled Node fetch and installed Undici can use different dispatcher interfaces.
    const result = await proxied(input, { ...options as ProxyRequestInit, redirect: 'error', dispatcher })
    return new Response(result.body as ReadableStream<Uint8Array> | null, { status: result.status, statusText: result.statusText })
  }
}
