import type { OAuthAuth } from '@earendil-works/pi-ai'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { customRoute, isCustomRoute, parseGrokCredential, validCustomModel } from '../../shared/contracts/provider-setup.ts'
import type { CustomProviderCredential, CustomProviderTest, GrokCredential, GrokLoginProgress } from '../../shared/contracts/provider-setup.ts'
import type { ManagedProvider } from '../../shared/contracts/management.ts'
import { boundedJson } from './model-management.ts'
import { ModelUnavailableError } from './execution.ts'

const noPricing = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const noKey = 'zlo-custom-no-key'

export async function testCustomProvider(config: CustomProviderCredential, request: typeof fetch): Promise<CustomProviderTest> {
  try {
    const response = await request(config.baseUrl + '/models', {
      headers: { Accept: 'application/json', ...(config.key ? { Authorization: 'Bearer ' + config.key } : {}) },
      redirect: 'error', signal: AbortSignal.timeout(7_000),
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      return { state: [401, 403].includes(response.status) ? 'unauthorized' : 'unavailable', models: [] }
    }
    const body = await boundedJson(response)
    if (!Array.isArray(body?.data)) return { state: 'unavailable', models: [] }
    const models = body.data.map((entry: { id?: unknown } | null) => entry?.id).filter(validCustomModel)
    return { state: 'connected', models: [...new Set<string>(models)].slice(0, 200) }
  } catch {
    return { state: 'unavailable', models: [] }
  }
}

export class CustomProviderRegistry {
  readonly #configs = new Map<string, CustomProviderCredential>()

  async apply(runtime: ModelRuntime, id: string, config: CustomProviderCredential | null) {
    const provider = customRoute(id)
    if (config) {
      if (!this.#configs.has(id) && runtime.getProvider(provider)) throw new ModelUnavailableError('Provider ID is reserved')
      runtime.registerProvider(provider, {
        name: config.name, baseUrl: config.baseUrl, api: 'openai-completions',
        // Pi requires an auth source for custom models, including keyless local servers.
        apiKey: noKey,
        models: config.models.map(model => ({
          id: model, name: model, input: ['text'], reasoning: false,
          contextWindow: 32768, maxTokens: 4096, cost: noPricing,
          compat: { supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens' },
        })),
      })
      await runtime.setRuntimeApiKey(provider, config.key ?? noKey)
      this.#configs.set(id, config)
    } else if (this.#configs.has(id)) {
      await runtime.removeRuntimeApiKey(provider)
      runtime.unregisterProvider(provider)
      this.#configs.delete(id)
    }
  }

  has(provider: string): boolean {
    return isCustomRoute(provider) && this.#configs.has(provider.slice('custom-'.length))
  }

  async test(id: string, request: typeof fetch): Promise<CustomProviderTest> {
    const config = this.#configs.get(id)
    if (!config) throw new ModelUnavailableError('Unknown custom provider')
    return testCustomProvider(config, request)
  }

  request(provider: string, fetcher: typeof fetch): typeof fetch {
    return (input, init) => {
      const config = this.#configs.get(provider.slice('custom-'.length))
      const url = new URL(input instanceof Request ? input.url : input)
      if (!config || url.href !== config.baseUrl + '/chat/completions') {
        throw new ModelUnavailableError('Custom provider endpoint changed')
      }
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      if (config.key) headers.set('authorization', 'Bearer ' + config.key)
      else headers.delete('authorization')
      return fetcher(input, { ...init, headers, redirect: 'error' })
    }
  }

  summaries(): ManagedProvider<string>[] {
    return [...this.#configs.values()].map(({ id, name, key, models }) => ({
      id: customRoute(id), name, credential: key ? 'stored' : 'missing', connection: 'untested',
      models: models.map(model => ({ route: { provider: customRoute(id), model }, name: model })),
    }))
  }
}

export class GrokLogin {
  #pending?: { controller: AbortController; progress: GrokLoginProgress }
  readonly #oauth: OAuthAuth

  constructor(oauth: OAuthAuth) { this.#oauth = oauth }

  start(): void {
    this.cancel()
    const controller = new AbortController()
    const attempt = { controller, progress: { state: 'pending' } as GrokLoginProgress }
    this.#pending = attempt
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)])
    void this.#oauth.login({
      signal,
      prompt: async () => { throw new Error('Unexpected Grok OAuth prompt') },
      notify: event => {
        if (event.type === 'device_code' && !signal.aborted) {
          attempt.progress = { state: 'pending', verification: { url: event.verificationUri, code: event.userCode } }
        }
      },
    }).then(value => {
      const credential = parseGrokCredential(value)
      attempt.progress = credential && !signal.aborted ? { state: 'complete', credential } : { state: 'failed' }
    }, () => { attempt.progress = { state: 'failed' } })
  }

  poll(): GrokLoginProgress {
    const result = this.#pending?.progress ?? { state: 'failed' }
    if (result.state !== 'pending') this.#pending = undefined
    return result
  }

  cancel(): void {
    this.#pending?.controller.abort()
    this.#pending = undefined
  }

  async refresh(input: unknown): Promise<GrokCredential> {
    const credential = parseGrokCredential(input)
    if (!credential) throw new ModelUnavailableError('Invalid Grok credential')
    const refreshed = await this.#oauth.refresh({ ...credential }, AbortSignal.timeout(8_000))
    const result = parseGrokCredential(refreshed)
    if (!result) throw new ModelUnavailableError('Invalid Grok credential')
    return result
  }
}
