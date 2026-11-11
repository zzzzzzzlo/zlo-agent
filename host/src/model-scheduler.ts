import { randomUUID } from 'node:crypto'
import type { EventDraft, ModelRoute } from './contracts/domain.ts'
import type { AgentExecution, ModelCandidate, ModelRequest, RuntimeEvent } from './execution.ts'
import type { LocalJudgment } from './judgment.ts'
import type { LocalStore } from './store.ts'

type Role = 'root' | 'team' | 'worker'
type Usage = Extract<RuntimeEvent, { type: 'model.usage' }>
export interface ModelLimits { requests: number; tokens: number; activeAgents: number }
interface Budget { requests: number; confirmed: number; reserved: number; uncertain: number }
interface Reservation {
  id: string
  event: EventDraft
  request: ModelRequest
  tokens: number
  status: 'pending' | 'settled' | 'uncertain'
}
const budgets = 'model-budgets'
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

  constructor(execution: AgentExecution, store: LocalStore, judgment: LocalJudgment, limits: Partial<ModelLimits> = {}) {
    this.#execution = execution
    this.#store = store
    this.#judgment = judgment
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

  async allocate(event: EventDraft, parent: ModelRoute, requested?: ModelRoute, independent = false): Promise<ModelRoute> {
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
      estimatedCost: metadata?.estimatedCost,
    })
    const alternativesForDecision = alternatives.filter(({ route }) => route.model !== requestedRoute.model).slice(0, 7)
    const candidates = [requestedRoute, ...alternativesForDecision.map(({ route }) => route)]
    const selected = await this.#judgment.decide(event, 'model.task_fit', {
      candidates: [modelFeatures(requestedRoute, requestedMetadata), ...alternativesForDecision.map(model => modelFeatures(model.route, model))],
      independent, requested: Boolean(requested),
    },
      independent && candidates.length > 1 ? 1 : 0, candidates.map((_, index) => index))
    const route = candidates[selected]!
    await this.validateRoute(route)
    return route
  }

  reserve(currentEvent: () => EventDraft, role: Role) {
    const runId = currentEvent().agentRunId!
    if (this.#active.size >= this.#limits.activeAgents || this.#active.has(runId)) {
      throw new ModelBudgetError('Agent capacity exhausted')
    }
    this.#active.add(runId)
    let requests = 0
    return {
      request: (request: ModelRequest) => {
        const event = currentEvent()
        const tokens = request.estimatedInputTokens + request.maxOutputTokens
        if (!this.#active.has(runId) || this.#pending.has(runId) ||
          !Number.isSafeInteger(request.estimatedInputTokens) || request.estimatedInputTokens < 0 ||
          !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 ||
          !Number.isSafeInteger(tokens) || requests >= (role === 'root' ? 32 : 8)) {
          throw new ModelBudgetError('Model request budget exhausted')
        }
        const entry = { id: randomUUID(), event, request, tokens, status: 'pending' as const }
        this.#store.transaction(() => {
          const budget = this.budget(event.taskId)
          if (budget.requests >= this.#limits.requests ||
            budget.confirmed + budget.reserved + budget.uncertain + tokens > this.#limits.tokens) {
            throw new ModelBudgetError('Task model budget exhausted')
          }
          this.#store.put(budgets, event.taskId, { ...budget, requests: budget.requests + 1, reserved: budget.reserved + tokens })
          this.#store.put(reservations, entry.id, entry)
          this.#store.append({ ...event, correlationId: entry.id, type: 'model.reserved', payload: { route: request.route, kind: request.kind, estimatedTokens: tokens } })
        })
        requests++
        this.#pending.set(runId, entry)
      },
      usage: (usage: Usage) => {
        const entry = this.#pending.get(runId)
        if (entry) this.#settle(entry, usage)
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
    this.#store.transaction(() => {
      const budget = this.budget(entry.event.taskId)
      this.#store.put(budgets, entry.event.taskId, {
        ...budget, reserved: budget.reserved - entry.tokens, confirmed: budget.confirmed + (actual ?? 0),
        uncertain: budget.uncertain + (actual === undefined ? entry.tokens : 0),
      })
      this.#store.put(reservations, entry.id, { ...entry, status })
      this.#store.append({
        ...entry.event, correlationId: entry.id, type: 'model.reservation_settled',
        payload: { route: entry.request.route, kind: entry.request.kind, status, estimatedTokens: entry.tokens, actualTokens: actual,
          ...(actual !== undefined && usage?.estimatedCostUsd !== undefined && Number.isFinite(usage.estimatedCostUsd) &&
            usage.estimatedCostUsd >= 0 ? { estimatedCostUsd: usage.estimatedCostUsd } : {}) },
      })
    })
    this.#pending.delete(entry.event.agentRunId!)
  }

  budget(taskId: string): Budget { return this.#store.get<Budget>(budgets, taskId) ?? emptyBudget }

  getRouteStatus() { return { quota: 'unknown' as const, activeReservations: this.#active.size } }
}
