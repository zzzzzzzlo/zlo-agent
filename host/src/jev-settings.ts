import { jevDefaultModel, judgmentPoints, parseJevSettings } from '../../shared/contracts/jev.ts'
import type { DecisionPoint, JevDecisionStatus, JevSettings, JevStatus } from '../../shared/contracts/jev.ts'
import { JevFailure, JevJudge } from './jev-judge.ts'
import type { Judge, JudgmentOptions } from './judgment.ts'
import type { LocalStore } from './store.ts'

const namespace = 'jev-configuration'
const settingsId = 'settings'
const connectionId = 'connection'
const taskRequestLimit = 32
const requestsPerMinute = 60
const probeTimeoutMs = 3500

export class JevConfiguration {
  readonly #store: LocalStore
  readonly #request: typeof fetch
  #settings: JevSettings
  #key: string | null
  #generation = new AbortController()
  readonly #pointControllers = new Map<DecisionPoint, AbortController>()
  #recent: number[] = []
  #cooldown = 0
  #probing = false

  constructor(store: LocalStore, key: string | null = null, request: typeof fetch = fetch) {
    this.#store = store
    this.#request = request
    this.#key = key
    this.#settings = parseJevSettings(store.get(namespace, settingsId)) ?? {
      enabled: false, model: jevDefaultModel,
      modes: Object.fromEntries(judgmentPoints.map(({ id }) => [id, 'off'])) as JevSettings['modes'],
    }
  }

  status(): JevStatus {
    return {
      settings: structuredClone(this.#settings),
      credential: this.#key ? 'stored' : 'missing',
      connection: (this.#key && this.#store.get<JevStatus['connection']>(namespace, connectionId)) || { state: 'untested' },
      decisions: Object.fromEntries(judgmentPoints.flatMap(({ id }) => {
        const status = this.#store.get<JevDecisionStatus>(namespace, id)
        return status ? [[id, status]] : []
      })),
    }
  }

  save(settings: JevSettings) {
    const modelChanged = settings.model !== this.#settings.model
    const globalChanged = settings.enabled !== this.#settings.enabled
    this.#store.transaction(() => {
      this.#store.put(namespace, settingsId, settings)
      if (modelChanged) this.#store.put(namespace, connectionId, { state: 'untested' })
    })
    if (modelChanged || globalChanged) this.#invalidate()
    else for (const { id } of judgmentPoints) {
      if (settings.modes[id] === this.#settings.modes[id]) continue
      this.#pointControllers.get(id)?.abort()
      this.#pointControllers.delete(id)
    }
    this.#settings = settings
    return this.status()
  }

  setKey(key: string | null) {
    this.#key = key
    this.#invalidate()
    this.#cooldown = 0
    this.#store.transaction(() => this.#store.put(namespace, connectionId, { state: 'untested' }))
    return this.status()
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
    try {
      if (!this.#key) throw new JevFailure('missing_key')
      this.#reserve()
      const model = await new JevJudge(this.#key, this.#settings.model, this.#request).test(signal)
      connection = { state: 'connected', at, model }
    } catch (error) {
      const reason = timeout.aborted ? 'timeout' : error instanceof JevFailure ? error.reason : 'unavailable'
      if (!configuration.aborted) this.#backoff(reason)
      connection = { state: 'degraded', at, reason }
    } finally {
      this.#probing = false
    }
    if (!configuration.aborted && this.#key) {
      this.#store.transaction(() => this.#store.put(namespace, connectionId, connection))
    }
    return this.status()
  }

  #reserve(taskId?: string) {
    const now = Date.now()
    if (now < this.#cooldown) throw new JevFailure('rate_limited')
    this.#recent = this.#recent.filter(time => time > now - 60_000)
    if (this.#recent.length >= requestsPerMinute) throw new JevFailure('budget_exhausted')
    if (taskId) this.#store.transaction(() => {
      const used = this.#store.get<number>('jev-budget', taskId) ?? 0
      if (used >= taskRequestLimit) throw new JevFailure('budget_exhausted')
      this.#store.put('jev-budget', taskId, used + 1)
    })
    this.#recent.push(now)
  }

  #backoff(reason: JevDecisionStatus['reason']) {
    if (reason === 'rate_limited') this.#cooldown = Date.now() + 15_000
  }

  judgmentOptions(): JudgmentOptions {
    return {
      timeoutMs: probeTimeoutMs,
      policy: (point: DecisionPoint, taskId: string) => {
        const mode = this.#settings.enabled ? this.#settings.modes[point] : 'off'
        if (mode === 'off') return { mode }
        const key = this.#key
        const model = this.#settings.model
        let pointController = this.#pointControllers.get(point)
        if (!pointController) {
          pointController = new AbortController()
          this.#pointControllers.set(point, pointController)
        }
        const judge: Judge = {
          evaluate: async (input, signal) => {
            try {
              signal.throwIfAborted()
              if (!key) throw new JevFailure('missing_key')
              if (input.allowed.length < 2) throw new JevFailure('no_choice')
              this.#reserve(taskId)
              return await new JevJudge(key, model, this.#request).evaluate(input, signal)
            } catch (error) {
              const reason = error instanceof JevFailure ? error.reason : 'unavailable'
              if (!signal.aborted) this.#backoff(reason)
              return { output: undefined, reason, requestSent: error instanceof JevFailure && error.requestSent }
            }
          },
        }
        return { mode, judge, signal: AbortSignal.any([this.#generation.signal, pointController.signal]), allowScopedEvidence: Boolean(key) }
      },
      observe: (point, status) => {
        this.#store.put(namespace, point, status)
        const { at, reason, model } = status
        if (model && (!reason || reason === 'uncertain')) {
          this.#store.put(namespace, connectionId, { state: 'connected', at, model })
        } else if (reason && ['unauthorized', 'rate_limited', 'timeout', 'unavailable', 'invalid_response', 'invalid_model', 'billing'].includes(reason)) {
          this.#store.put(namespace, connectionId, { state: 'degraded', at, reason })
        }
      },
    }
  }
}
