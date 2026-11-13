import { randomUUID } from 'node:crypto'
import type { EventDraft, ModelRoute } from './contracts/domain.ts'
import type { AgentExecution, ModelCandidate, ModelRequest, RuntimeEvent } from './execution.ts'
import type { LocalJudgment } from './judgment.ts'
import type { LocalStore } from './store.ts'

type Role = 'root' | 'team' | 'worker'
type Usage = Extract<RuntimeEvent, { type: 'model.usage' }>
export interface ModelLimits { requests: number; tokens: number; activeAgents: number }
interface BudgetScope { nodeId: string; tokens?: number; requests?: number }
interface Budget { requests: number; confirmed: number; reserved: number; uncertain: number }
interface Reservation {
  id: string
  event: EventDraft
  request: ModelRequest
  tokens: number
  started?: number
  scopeKeys?: string[]
  status: 'pending' | 'settled' | 'uncertain'
}
const budgets = 'model-budgets'
const scopedBudgets = 'model-node-budgets'
const reservations = 'model-reservations'
const defaults: ModelLimits = { requests: 96, tokens: 2_000_000, activeAgents: 5 }
const emptyBudget: Budget = { requests: 0, confirmed: 0, reserved: 0, uncertain: 0 }

export class ModelBudgetError extends Error {}

export class LocalModelScheduler {
  readonly #active = new Set<string>()
  readonly #pending = new Map<string, Reservation>()
  readonly #limits: ModelLimits
  readonly #execution: AgentExecution
  readonly #store: LocalStore
  readonly #judgment: LocalJudgment
  readonly #automatic: () => boolean

  constructor(execution: AgentExecution, store: LocalStore, judgment: LocalJudgment, limits: Partial<ModelLimits> = {},
    automatic: () => boolean = () => true) {
    this.#execution = execution
    this.#store = store
    this.#judgment = judgment
    this.#automatic = automatic
    this.#limits = { ...defaults, ...limits }
    if (Object.values(this.#limits).some(value => !Number.isSafeInteger(value) || value < 1)) {
      throw new Error('Invalid model budget limits')
    }
    for (const receipt of store.list<Reservation>(reservations)) {
      if (receipt.status === 'pending') this.#settle(receipt)
    }
  }

  validateRoute(route: ModelRoute): Promise<void> {
    if (typeof route?.provider !== 'string' || typeof route.model !== 'string' ||
      !/^[\w-]{1,80}$/.test(route.provider) || !/^[\w.:/-]{1,200}$/.test(route.model)) {
      throw new Error('Invalid model route')
    }
    return this.#execution.validateRoute(route)
  }

  canSwitch(current: ModelRoute, target: ModelRoute): boolean {
    return current.provider === target.provider
  }

  async discoverModels(provider?: string): Promise<readonly ModelCandidate[]> {
    return this.#execution.discoverModels?.(provider) ?? []
  }

  async allocate(event: EventDraft, parent: ModelRoute, requested?: ModelRoute, independent = false, goal?: string,
    signal?: AbortSignal): Promise<ModelRoute> {
    if (!this.#automatic()) {
      independent = false
      requested = parent
    }
    const requestedRoute = requested ?? parent
    if (!this.canSwitch(parent, requestedRoute)) throw new Error('Cross-provider context transfer is not authorized')
    await this.validateRoute(requestedRoute)
    const eligible = independent && !requested
      ? (await this.discoverModels(parent.provider)).filter(model =>
        model.route.provider === parent.provider && model.input.includes('text') && model.contextWindow >= 8192)
      : []
    const alternatives = [...eligible].sort((a, b) =>
      (a.estimatedCost ?? Infinity) - (b.estimatedCost ?? Infinity) ||
      b.contextWindow - a.contextWindow || a.route.model.localeCompare(b.route.model))
    const requestedMetadata = eligible.find(({ route }) => route.model === requestedRoute.model)
    const modelFeatures = (route: ModelRoute, metadata?: ModelCandidate) => ({
      ...route, contextWindow: metadata?.contextWindow, supportsText: metadata?.input.includes('text'),
      supportsVision: metadata?.input.includes('image'), estimatedCost: metadata?.estimatedCost,
    })
    const alternativesForDecision: ModelCandidate[] = []
    const seen = new Set([requestedRoute.model])
    for (const model of alternatives.slice(0, 24)) {
      if (alternativesForDecision.length === 7) break
      if (seen.has(model.route.model)) continue
      seen.add(model.route.model)
      try { await this.validateRoute(model.route) } catch { continue }
      alternativesForDecision.push(model)
    }
    const candidates = [requestedRoute, ...alternativesForDecision.map(({ route }) => route)]
    const selected = await this.#judgment.decide(event, 'model.task_fit', {
      candidates: [modelFeatures(requestedRoute, requestedMetadata), ...alternativesForDecision.map(model => modelFeatures(model.route, model))],
      independent, requested: Boolean(requested), goal,
    },
      independent && candidates.length > 1 ? 1 : 0, candidates.map((_, index) => index), [], { signal })
    const route = candidates[selected]!
    await this.validateRoute(route)
    return route
  }

  reserve(currentEvent: () => EventDraft, _role: Role, scopes: readonly BudgetScope[] = []) {
    const runId = currentEvent().agentRunId!
    if (this.#active.size >= this.#limits.activeAgents || this.#active.has(runId)) {
      throw new ModelBudgetError('Agent capacity exhausted')
    }
    this.#active.add(runId)
    return {
      request: (request: ModelRequest) => {
        const event = currentEvent()
        const tokens = request.estimatedInputTokens + request.maxOutputTokens
        if (!this.#active.has(runId) || this.#pending.has(runId) ||
          !Number.isSafeInteger(request.estimatedInputTokens) || request.estimatedInputTokens < 0 ||
          !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || !Number.isSafeInteger(tokens)) {
          throw new ModelBudgetError('Model request budget exhausted')
        }
        const entry = this.#store.transaction(() => {
          const budget = this.budget(event.taskId)
          const available = (limit: number, ledger: Budget) => limit - ledger.confirmed - ledger.reserved - ledger.uncertain
          const taskAvailable = available(this.#limits.tokens, budget)
          const minimum = request.estimatedInputTokens + (request.fixedMaxOutputTokens === false ? 1 : request.maxOutputTokens)
          if (budget.requests >= this.#limits.requests || taskAvailable < minimum) {
            throw new ModelBudgetError('Task model budget exhausted')
          }
          let granted = Math.min(tokens, taskAvailable)
          const ledgers = scopes.map(scope => {
            const key = JSON.stringify([event.taskId, scope.nodeId])
            const ledger = this.#store.get<Budget>(scopedBudgets, key) ?? emptyBudget
            const remaining = available(scope.tokens ?? Infinity, ledger)
            if (ledger.requests >= (scope.requests ?? Infinity) || remaining < minimum) {
              throw new ModelBudgetError('Delegated model budget exhausted')
            }
            granted = Math.min(granted, remaining)
            return { key, ledger }
          })
          const adjusted = { ...request, maxOutputTokens: granted - request.estimatedInputTokens }
          const entry = { id: randomUUID(), event, request: adjusted, tokens: granted, started: performance.now(),
            status: 'pending' as const, scopeKeys: ledgers.map(({ key }) => key) }
          for (const { key, ledger } of ledgers) {
            this.#store.put(scopedBudgets, key, { ...ledger, requests: ledger.requests + 1, reserved: ledger.reserved + granted })
          }
          this.#store.put(budgets, event.taskId, { ...budget, requests: budget.requests + 1, reserved: budget.reserved + granted })
          this.#store.put(reservations, entry.id, entry)
          this.#store.append({ ...event, correlationId: entry.id, type: 'model.reserved', payload: { route: request.route, kind: request.kind,
            estimatedTokens: granted, estimatedInputTokens: request.estimatedInputTokens, maxOutputTokens: adjusted.maxOutputTokens,
            taskTokenLimit: this.#limits.tokens, taskRequestLimit: this.#limits.requests } })
          return entry
        })
        this.#pending.set(runId, entry)
        return entry.request.maxOutputTokens
      },
      usage: (usage: Usage) => {
        const entry = this.#pending.get(runId)
        if (entry) this.#settle(entry, usage)
        return entry?.id
      },
      unknown: () => {
        const entry = this.#pending.get(runId)
        if (entry) this.#settle(entry)
        return entry?.id
      },
      release: () => {
        this.#active.delete(runId)
        const entry = this.#pending.get(runId)
        if (entry) this.#settle(entry)
      },
    }
  }

  #settle(entry: Reservation, usage?: Usage) {
    const counts = usage && [usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
    const actual = counts?.every(count => Number.isSafeInteger(count) && count >= 0)
      ? counts.reduce((sum, count) => sum + count, 0) : undefined
    const status = actual === undefined ? 'uncertain' : 'settled'
    const settle = (budget: Budget) => ({ ...budget, reserved: budget.reserved - entry.tokens,
      confirmed: budget.confirmed + (actual ?? 0), uncertain: budget.uncertain + (actual === undefined ? entry.tokens : 0) })
    this.#store.transaction(() => {
      this.#store.put(budgets, entry.event.taskId, settle(this.budget(entry.event.taskId)))
      for (const key of entry.scopeKeys ?? []) {
        this.#store.put(scopedBudgets, key, settle(this.#store.get<Budget>(scopedBudgets, key) ?? emptyBudget))
      }
      this.#store.put(reservations, entry.id, { ...entry, status })
      this.#store.append({
        ...entry.event, correlationId: entry.id, type: 'model.reservation_settled',
        payload: { route: entry.request.route, kind: entry.request.kind, status, estimatedTokens: entry.tokens, actualTokens: actual,
          ...(entry.started !== undefined && usage ? { durationMs: Math.round(performance.now() - entry.started) } : {}),
          ...(actual !== undefined && usage?.estimatedCostUsd !== undefined && Number.isFinite(usage.estimatedCostUsd) &&
            usage.estimatedCostUsd >= 0 ? { estimatedCostUsd: usage.estimatedCostUsd } : {}) },
      })
    })
    this.#pending.delete(entry.event.agentRunId!)
  }

  budget(taskId: string): Budget { return this.#store.get<Budget>(budgets, taskId) ?? emptyBudget }
  get tokenLimit(): number { return this.#limits.tokens }

  getRouteStatus() { return { quota: 'unknown' as const, activeReservations: this.#active.size } }
}
