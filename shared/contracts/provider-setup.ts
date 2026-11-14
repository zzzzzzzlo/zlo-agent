import type { ModelCatalogEntry } from './domain.ts'

export interface CustomProviderConfig {
  id: string
  name: string
  baseUrl: string
  models: string[]
}

export interface CustomProviderSummary extends CustomProviderConfig {
  hasKey: boolean
}

/** Used only by Main and the private Host transport. */
export interface CustomProviderCredential extends CustomProviderConfig {
  key: string | null
}

/** Used only by Main and the private Host transport. */
export interface GrokCredential {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
}

export type GrokLoginProgress =
  | { state: 'pending'; verification?: { url: string; code: string } }
  | { state: 'complete'; credential: GrokCredential }
  | { state: 'failed' }

export type GrokStatus = {
  state: 'unavailable' | 'signed_out' | 'signing_in' | 'connected' | 'reauthorization_required'
  code?: string
  models: ModelCatalogEntry[]
}
export type CustomProviderTest = {
  state: 'connected' | 'unauthorized' | 'unavailable'
  models: string[]
}

export interface DesktopProviderSetupApi {
  listCustom(): Promise<CustomProviderSummary[]>
  saveCustom(input: CustomProviderConfig & { create: boolean }): Promise<CustomProviderSummary[]>
  setCustomKey(input: { id: string }): Promise<CustomProviderSummary[]>
  removeCustomKey(input: { id: string }): Promise<CustomProviderSummary[]>
  deleteCustom(input: { id: string }): Promise<CustomProviderSummary[]>
  testCustom(input: { id: string }): Promise<CustomProviderTest>
  grokStatus(): Promise<GrokStatus>
  grokSignIn(): Promise<GrokStatus>
  grokCancel(): Promise<GrokStatus>
  grokSignOut(): Promise<GrokStatus>
}

export const customProviderLimit = 16
export const grokProviderId = 'xai'
export const customRoute = (id: string) => 'custom-' + id
export const isCustomRoute = (provider: string) => provider.startsWith('custom-')
export function validCustomId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/u.test(value)
}
export function validCustomModel(value: unknown): value is string {
  return typeof value === 'string' && /^[\w.:/-]{1,160}$/u.test(value)
}

export function parseCustomProvider(value: unknown): CustomProviderConfig | undefined {
  if (!value || typeof value !== 'object') return
  const { id, name, baseUrl, models } = value as Record<string, unknown>
  if (!validCustomId(id) || typeof name !== 'string' || !name.trim() || name.length > 80 ||
    /[\u0000-\u001f\u007f]/u.test(name) || typeof baseUrl !== 'string' || baseUrl.length > 512 ||
    !Array.isArray(models) || models.length > 20 || !models.every(validCustomModel)) return
  try {
    const url = new URL(baseUrl)
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash || url.href.includes('?') || url.href.includes('#')) return
    return { id, name: name.trim(), baseUrl: url.href.replace(/\/+$/u, ''), models: [...new Set(models)] }
  } catch { return }
}

export function parseGrokCredential(value: unknown): GrokCredential | undefined {
  if (!value || typeof value !== 'object') return
  const { type, access, refresh, expires } = value as Record<string, unknown>
  if (type === 'oauth' && typeof access === 'string' && /^[\x21-\x7e]{8,16384}$/u.test(access) &&
    typeof refresh === 'string' && /^[\x21-\x7e]{8,16384}$/u.test(refresh) &&
    typeof expires === 'number' && Number.isSafeInteger(expires) && expires > 0) return { type, access, refresh, expires }
}

export function parseCustomCredential(value: unknown): CustomProviderCredential | undefined {
  const config = parseCustomProvider(value)
  const key = (value as { key?: unknown } | null)?.key
  if (config && (key === null || typeof key === 'string' && /^[\x21-\x7e]{8,2048}$/u.test(key))) return { ...config, key }
}
