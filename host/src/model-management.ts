import type { ManagedProvider, ProviderId } from '../../shared/contracts/management.ts'

export const managedProviderIds = ['deepseek', 'openai', 'anthropic', 'google'] as const

const endpoints = {
  deepseek: { name: 'DeepSeek', url: 'https://api.deepseek.com/models' },
  openai: { name: 'OpenAI', url: 'https://api.openai.com/v1/models' },
  anthropic: { name: 'Anthropic', url: 'https://api.anthropic.com/v1/models?limit=1000' },
  google: { name: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000' },
} satisfies Record<ProviderId, { name: string; url: string }>

export function isProviderId(value: unknown): value is ProviderId {
  return managedProviderIds.some(id => id === value)
}

export function providerName(provider: ProviderId): string { return endpoints[provider].name }

export function validProviderKey(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{8,2048}$/u.test(value)
}

export interface ProviderCatalog {
  connection: ManagedProvider['connection']
  ids?: Set<string>
}

export async function fetchProviderCatalog(provider: ProviderId, key: string, signal: AbortSignal,
  request: typeof fetch = fetch): Promise<ProviderCatalog> {
  const headers = new Headers({ Accept: 'application/json' })
  if (provider === 'anthropic') {
    headers.set('x-api-key', key)
    headers.set('anthropic-version', '2023-06-01')
  } else if (provider === 'google') {
    headers.set('x-goog-api-key', key)
  } else {
    headers.set('Authorization', `Bearer ${key}`)
  }
  try {
    const response = await request(endpoints[provider].url, { headers, signal, redirect: 'error' })
    if (!response.ok) {
      // The response body is untrusted and can contain request credentials.
      await response.body?.cancel().catch(() => {})
      return { connection: [401, 403].includes(response.status) || (provider === 'google' && response.status === 400)
        ? 'unauthorized' : 'unavailable' }
    }
    const data = await boundedJson(response)
    const entries = provider === 'google' ? data?.models : data?.data
    if (!Array.isArray(entries)) return { connection: 'unavailable' }
    const ids = new Set<string>()
    for (const entry of entries) {
      const id = provider === 'google' && typeof entry?.name === 'string'
        ? entry.name.replace(/^models\//u, '') : entry?.id
      if (typeof id === 'string' && /^[\w.:/-]{1,200}$/u.test(id)) ids.add(id)
    }
    return { connection: 'connected', ids }
  } catch {
    return { connection: 'unavailable' }
  }
}

export async function boundedJson(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) return undefined
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 2 * 1024 * 1024) {
        await reader.cancel()
        return undefined
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return JSON.parse(chunks.join(''))
  } finally {
    reader.releaseLock()
  }
}
