import { jevDefaultModel, jevEndpoint, judgmentPoints, parseJevSettings } from '../../shared/contracts/jev.ts'
import type { DecisionPoint, JevDecisionStatus, JevReason, JevSettings, JevStatus, JudgeCredentials } from '../../shared/contracts/jev.ts'
import { JevFailure, JevJudge } from './jev-judge.ts'
import type { Judge, JudgmentOptions } from './judgment.ts'
import type { LocalStore } from './store.ts'

const namespace = 'jev-configuration'
const settingsId = 'settings'
const connectionId = 'connection'
const probeTimeoutMs = 3500
const judgeTimeoutMs = 10_000

type BackoffReason = Extract<JevReason, 'rate_limited' | 'timeout' | 'unavailable' | 'invalid_response' | 'unauthorized' | 'billing' | 'invalid_model'>

export class JevConfiguration {
  readonly #store: LocalStore
  readonly #request: typeof fetch
  #settings: JevSettings
  readonly #keys: Map<string, string>
  #generation = new AbortController()
  readonly #pointControllers = new Map<DecisionPoint, AbortController>()
  #cooldown = 0
  #cooldownReason: BackoffReason = 'rate_limited'
  #consecutiveFailures = 0
  #rateLimitStreak = 0
  #probing = false

  constructor(store: LocalStore, key: string | null = null, request: typeof fetch = fetch, keys: JudgeCredentials = {}) {
    this.#store = store
    this.#request = request
    this.#keys = new Map(Object.entries(keys))
    if (key && !key.startsWith('oc_sk_') && !this.#keys.has(jevEndpoint)) this.#keys.set(jevEndpoint, key)
    this.#settings = parseJevSettings(store.get(namespace, settingsId), true) ?? {
      enabled: false, provider: 'typesafe', endpoint: jevEndpoint, model: jevDefaultModel,
      modes: Object.fromEntries(judgmentPoints.map(({ id }) => [id, 'off'])) as JevSettings['modes'],
    }
  }

  status(): JevStatus {
    const key = this.#keys.get(this.#settings.endpoint)
    return {
      settings: structuredClone(this.#settings),
      credential: key ? 'stored' : 'missing',
      connection: (key && this.#store.get<JevStatus['connection']>(namespace, connectionId)) || { state: 'untested' },
      decisions: Object.fromEntries(judgmentPoints.flatMap(({ id }) => {
        const status = this.#store.get<JevDecisionStatus>(namespace, id)
        return status ? [[id, status]] : []
      })),
    }
  }

  save(settings: JevSettings) {
    const routeChanged = settings.model !== this.#settings.model || settings.endpoint !== this.#settings.endpoint ||
      settings.provider !== this.#settings.provider
    const globalChanged = settings.enabled !== this.#settings.enabled
    this.#store.transaction(() => {
      this.#store.put(namespace, settingsId, settings)
      if (routeChanged) {
        this.#store.put(namespace, connectionId, { state: 'untested' })
        for (const { id } of judgmentPoints) this.#store.put(namespace, id, null)
      }
    })
    if (routeChanged || globalChanged) {
      this.#invalidate()
      this.#resetBackoff()
    } else for (const { id } of judgmentPoints) {
      if (settings.modes[id] === this.#settings.modes[id]) continue
      this.#pointControllers.get(id)?.abort()
      this.#pointControllers.delete(id)
    }
    this.#settings = settings
    return this.status()
  }

  setKey(key: string | null, endpoint = this.#settings.endpoint) {
    if (key === null) this.#keys.delete(endpoint)
    else this.#keys.set(endpoint, key)
    if (endpoint !== this.#settings.endpoint) return this.status()
    this.#invalidate()
    this.#resetBackoff()
    this.#store.transaction(() => this.#store.put(namespace, connectionId, { state: 'untested' }))
    return this.status()
  }

  #resetBackoff() {
    this.#cooldown = 0
    this.#consecutiveFailures = 0
    this.#rateLimitStreak = 0
  }

  #invalidate() {
    this.#generation.abort()
    this.#generation = new AbortController()
    this.#pointControllers.clear()
  }

  close() { this.#invalidate() }

  async test(): Promise<JevStatus> {
    if (this.#probing) return this.status()
    const configuration = this.#generation.signal
    const timeout = AbortSignal.timeout(probeTimeoutMs)
    const signal = AbortSignal.any([configuration, timeout])
    const at = new Date().toISOString()
    let connection: JevStatus['connection']
    this.#probing = true
    const route = this.#settings
    const key = this.#keys.get(route.endpoint)
    try {
      if (!key) throw new JevFailure('missing_key')
      this.#resetBackoff()
      const model = await new JevJudge(key, route, this.#request).test(signal)
      this.#resetBackoff()
      connection = { state: 'connected', at, model }
    } catch (error) {
      const reason = timeout.aborted ? 'timeout' : error instanceof JevFailure ? error.reason : 'unavailable'
      if (!configuration.aborted) this.#backoff(reason)
      connection = { state: 'degraded', at, reason }
    } finally {
      this.#probing = false
    }
    if (!configuration.aborted && key) {
      this.#store.transaction(() => this.#store.put(namespace, connectionId, connection))
    }
    return this.status()
  }

  #reserve() {
    if (Date.now() < this.#cooldown) throw new JevFailure(this.#cooldownReason)
  }

  #backoff(reason: JevDecisionStatus['reason']) {
    const now = Date.now()
    if (now < this.#cooldown) return
    if (reason === 'unauthorized' || reason === 'billing' || reason === 'invalid_model') {
      this.#cooldownReason = reason
      this.#cooldown = now + 60_000
      return
    }
    if (reason === 'rate_limited') {
      this.#rateLimitStreak++
      this.#cooldownReason = 'rate_limited'
      this.#cooldown = now + Math.min(60_000, 15_000 * 2 ** (this.#rateLimitStreak - 1))
      return
    }
    if (reason === 'timeout' || reason === 'unavailable' || reason === 'invalid_response') {
      this.#consecutiveFailures++
      if (this.#consecutiveFailures >= 2) {
        this.#cooldownReason = reason
        this.#cooldown = now + Math.min(60_000, 10_000 * 2 ** (this.#consecutiveFailures - 2))
      }
    }
  }

  judgmentOptions(): JudgmentOptions {
    return {
      timeoutMs: judgeTimeoutMs,
      policy: (point: DecisionPoint, _taskId: string) => {
        const mode = this.#settings.enabled ? this.#settings.modes[point] : 'off'
        if (mode === 'off') return { mode }
        const route = this.#settings
        const key = this.#keys.get(route.endpoint)
        let pointController = this.#pointControllers.get(point)
        if (!pointController) {
          pointController = new AbortController()
          this.#pointControllers.set(point, pointController)
        }
        const request = async <T>(signal: AbortSignal, operation: (judge: JevJudge) => Promise<T>) => {
          try {
            signal.throwIfAborted()
            if (!key) throw new JevFailure('missing_key')
            this.#reserve()
            return await operation(new JevJudge(key, route, this.#request))
          } catch (error) {
            const reason = error instanceof JevFailure ? error.reason : 'unavailable'
            return { output: undefined, reason, requestSent: error instanceof JevFailure && error.requestSent }
          }
        }
        const judge: Judge = {
          evaluate: (input, signal) => input.allowed.length >= 2
            ? request(signal, adapter => adapter.evaluate(input, signal))
            : Promise.resolve({ output: undefined, reason: 'no_choice', requestSent: false }),
          evaluateBatch: (input, signal) => request(signal, adapter => adapter.evaluateBatch(input, signal)),
        }
        return { mode, judge, signal: AbortSignal.any([this.#generation.signal, pointController.signal]), allowScopedEvidence: Boolean(key) }
      },
      observe: (point, status) => {
        if (status.reason === 'configuration_changed') return
        this.#store.put(namespace, point, status)
        const { at, reason, model } = status
        if (model && (!reason || reason === 'uncertain')) {
          this.#resetBackoff()
          this.#store.put(namespace, connectionId, { state: 'connected', at, model })
        } else if (reason && ['unauthorized', 'rate_limited', 'timeout', 'unavailable', 'invalid_response', 'invalid_model', 'billing'].includes(reason)) {
          this.#backoff(reason)
          this.#store.put(namespace, connectionId, { state: 'degraded', at, reason })
        }
      },
    }
  }
}
