import { ProxyAgent } from 'undici'
import { openCodeJudgeEndpoint } from '../../shared/contracts/jev.ts'

export function openCodeJudgeFetch(proxy: string | undefined, request: typeof fetch = fetch): typeof fetch | undefined {
  if (!proxy || proxy.length > 256) return
  const url = URL.parse(proxy)
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
    url.pathname !== '/' || url.search || url.hash) return
  const dispatcher = new ProxyAgent(url.href)
  return (input, options) => {
    if (input !== openCodeJudgeEndpoint) return request(input, options)
    return request(input, { ...options, redirect: 'error', dispatcher } as RequestInit)
  }
}
