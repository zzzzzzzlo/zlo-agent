import { randomUUID } from 'node:crypto'
import type { EventDraft, ModelRoute } from './contracts/domain.ts'
import type { AgentExecution, ModelCandidate, ModelRequest, RuntimeEvent } from './execution.ts'
import type { LocalJudgment } from './judgment.ts'
import type { LocalStore } from './store.ts'

type Role = 'root' | 'team' | 'worker'
type Usage = Extract<RuntimeEvent, { type: 'model.usage' }>
export type TaskRoleHint = 'planning' | 'research' | 'coding' | 'review' | 'general'
export interface AllocateOptions {
  /** 'resume' restricts to the existing Session's provider; 'fresh' enables cross-provider Worker routing. */
  sessionMode?: 'resume' | 'fresh'
  /** Existing session's route when resuming a persisted Team Session across a different parent route. */
  sessionRoute?: ModelRoute
  taskRole?: TaskRoleHint
  remainingRequests?: number
  allowFallback?: boolean
  excludeRoutes?: readonly ModelRoute[]
}
export interface ModelLimits { requests: number; activeAgents: number }
interface BudgetScope { nodeId: string; requests: number }
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
const defaults: ModelLimits = { requests: 96, activeAgents: 5 }
const emptyBudget: Budget = { requests: 0, confirmed: 0, reserved: 0, uncertain: 0 }
const routeCooldownMs = 60_000

export class ModelBudgetError extends Error {}

function routeKey(route: ModelRoute): string {
  return route.provider + '\0' + route.model
}

function sameRoutePair(a: ModelRoute, b: ModelRoute): boolean {
  return a.provider === b.provider && a.model === b.model
}

export function inferTaskRole(goal?: string, independent = false): TaskRoleHint {
  if (!independent) return 'planning'
  const text = (goal ?? '').toLowerCase()
  if (/\b(?:review|audit|verify|verification|check|critique|inspect diff)\b|复核|审查|评审/u.test(text)) return 'review'
  if (/\b(?:research|read|search|explore|find|investigate|analyze|inspect|summarize)\b|调研|检索|查阅|阅读|分析/u.test(text)) return 'research'
  if (/\b(?:edit|write|create|fix|patch|implement|refactor|build|code|test)\b|编写|修改|修复|实现|重构/u.test(text)) return 'coding'
  return 'general'
}

function scoreCandidate(candidate: ModelCandidate, parent: ModelRoute, taskRole: TaskRoleHint, tightBudget: boolean): number {
  const cost = candidate.estimatedCost ?? 10
  const windowBonus = Math.min(candidate.contextWindow, 256_000) / 16_384
  if (tightBudget) return cost * 10 - windowBonus * 0.1
  switch (taskRole) {
    case 'research':
      return cost - windowBonus * 0.5
    case 'coding':
      return cost - (candidate.reasoning ? 2 : 0) - windowBonus * 0.15
    case 'review':
      return cost - (candidate.route.provider !== parent.provider ? 2.5 : 0) - (candidate.reasoning ? 1.5 : 0)
    case 'planning':
      return cost - (candidate.reasoning ? 3 : 0) - windowBonus * 0.2
    default:
      return cost - windowBonus * 0.1
  }
}

export class LocalModelScheduler {
  readonly #active = new Set<string>()
  readonly #pending = new Map<string, Reservation>()
  readonly #failedRoutes = new Map<string, number>()
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
    this.#limits = { requests: limits.requests ?? defaults.requests, activeAgents: limits.activeAgents ?? defaults.activeAgents }
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

  /** Session resume / in-session hot switching must stay on the same Provider. */
  canSwitch(current: ModelRoute, target: ModelRoute): boolean {
    return current.provider === target.provider
  }

  canResumeSession(current: ModelRoute, target: ModelRoute): boolean {
    return this.canSwitch(current, target)
  }

  markRouteFailed(route: ModelRoute): void {
    this.#failedRoutes.set(routeKey(route), Date.now())
  }

  markRouteSucceeded(route: ModelRoute): void {
    this.#failedRoutes.delete(routeKey(route))
  }

  #isRouteHealthy(route: ModelRoute): boolean {
    const failedAt = this.#failedRoutes.get(routeKey(route))
    if (failedAt === undefined) return true
    if (Date.now() - failedAt > routeCooldownMs) {
      this.#failedRoutes.delete(routeKey(route))
      return true
    }
    return false
  }

  async discoverModels(provider?: string): Promise<readonly ModelCandidate[]> {
    return this.#execution.discoverModels?.(provider) ?? []
  }

  hasBudget(taskId: string, scopes: readonly BudgetScope[] = []): boolean {
    const taskBudget = this.budget(taskId)
    if (taskBudget.requests >= this.#limits.requests) return false
    return scopes.every(scope => {
      const key = JSON.stringify([taskId, scope.nodeId])
      const ledger = this.#store.get<Budget>(scopedBudgets, key) ?? emptyBudget
      return ledger.requests < scope.requests
    })
  }

  async allocate(event: EventDraft, parent: ModelRoute, requested?: ModelRoute, independent = false, goal?: string,
    signal?: AbortSignal, options: AllocateOptions = {}): Promise<ModelRoute> {
    const automatic = this.#automatic()
    const sessionMode = options.sessionMode ?? (independent ? 'fresh' : 'resume')
    const sessionAnchor = options.sessionRoute ?? parent
    if (!automatic) {
      independent = false
      if (sessionMode === 'resume' || !requested) requested = sessionAnchor
    }
    const requestedRoute = requested ?? (sessionMode === 'resume' ? sessionAnchor : parent)
    if (sessionMode === 'resume' && !this.canSwitch(sessionAnchor, requestedRoute)) {
      throw new Error('Cross-provider context transfer is not authorized')
    }

    const budget = this.budget(event.taskId)
    const taskRemaining = Math.max(0, this.#limits.requests - budget.requests)
    const remainingRequests = options.remainingRequests !== undefined
      ? Math.min(taskRemaining, options.remainingRequests) : taskRemaining
    if (remainingRequests <= 0) throw new ModelBudgetError('Model request budget exhausted')

    const excluded = options.excludeRoutes ?? []
    const isExcluded = (route: ModelRoute) => excluded.some(item => sameRoutePair(item, route))
    const allowAutoFallback = options.allowFallback ?? (sessionMode === 'fresh' && !requested)

    let primaryValid = !isExcluded(requestedRoute)
    if (primaryValid) {
      try {
        await this.validateRoute(requestedRoute)
      } catch (error) {
        if (!allowAutoFallback) throw error
        primaryValid = false
      }
    } else if (!allowAutoFallback) {
      throw new Error('Requested model route is excluded')
    }

    const taskRole = options.taskRole ?? inferTaskRole(goal, independent)
    const tightBudget = remainingRequests <= 6
    const discoverScope = sessionMode === 'resume' ? sessionAnchor.provider : undefined
    const eligible = independent && (!requested || !primaryValid) && automatic
      ? (await this.discoverModels(discoverScope)).filter(model =>
        (sessionMode === 'fresh' || model.route.provider === sessionAnchor.provider) &&
        model.input.includes('text') && model.contextWindow >= 8192 &&
        !isExcluded(model.route))
      : []

    const alternatives = [...eligible].sort((a, b) => {
      const aHealthy = this.#isRouteHealthy(a.route) ? 0 : 1
      const bHealthy = this.#isRouteHealthy(b.route) ? 0 : 1
      if (aHealthy !== bHealthy) return aHealthy - bHealthy
      return scoreCandidate(a, parent, taskRole, tightBudget) - scoreCandidate(b, parent, taskRole, tightBudget) ||
        b.contextWindow - a.contextWindow || a.route.provider.localeCompare(b.route.provider) ||
        a.route.model.localeCompare(b.route.model)
    })

    const requestedMetadata = eligible.find(({ route }) => sameRoutePair(route, requestedRoute))
    const modelFeatures = (route: ModelRoute, metadata?: ModelCandidate) => ({
      ...route, contextWindow: metadata?.contextWindow, supportsText: metadata?.input.includes('text'),
      supportsVision: metadata?.input.includes('image'), estimatedCost: metadata?.estimatedCost,
    })

    const validatedAlternatives: ModelCandidate[] = []
    const seen = new Set<string>(primaryValid ? [routeKey(requestedRoute)] : [])
    for (const model of alternatives.slice(0, 24)) {
      if (validatedAlternatives.length === (primaryValid ? 7 : 8)) break
      const key = routeKey(model.route)
      if (seen.has(key)) continue
      seen.add(key)
      try { await this.validateRoute(model.route) } catch { continue }
      validatedAlternatives.push(model)
    }

    const candidates: ModelCandidate[] = primaryValid
      ? [{ route: requestedRoute, contextWindow: requestedMetadata?.contextWindow ?? 8192,
          input: requestedMetadata?.input ?? ['text'], reasoning: requestedMetadata?.reasoning ?? false,
          estimatedCost: requestedMetadata?.estimatedCost }, ...validatedAlternatives]
      : validatedAlternatives

    if (!candidates.length) {
      await this.validateRoute(requestedRoute)
      return requestedRoute
    }

    const primaryEntry = candidates[0]!
    const bestAlternative = validatedAlternatives[0]
    const shouldSwitchBaseline = independent && !requested && (
      !primaryValid ||
      !this.#isRouteHealthy(primaryEntry.route) ||
      (bestAlternative !== undefined && (
        (bestAlternative.estimatedCost !== undefined &&
          (primaryEntry.estimatedCost === undefined || bestAlternative.estimatedCost < primaryEntry.estimatedCost)) ||
        (taskRole === 'review' && bestAlternative.route.provider !== parent.provider &&
          scoreCandidate(bestAlternative, parent, taskRole, tightBudget) < scoreCandidate(primaryEntry, parent, taskRole, tightBudget))
      ))
    )
    const baselineIndex = shouldSwitchBaseline && candidates.length > 1 ? 1 : 0

    const selected = await this.#judgment.decide(event, 'model.task_fit', {
      candidates: candidates.map(item => modelFeatures(item.route, item)),
      independent, requested: Boolean(requested), goal, taskRole, budgetRemaining: remainingRequests,
    }, baselineIndex, candidates.map((_, index) => index), [], { signal })

    const orderedCandidates = [candidates[selected]!, ...candidates.filter((_, index) => index !== selected)]
    let lastError: unknown
    for (const candidate of orderedCandidates) {
      try {
        await this.validateRoute(candidate.route)
        return candidate.route
      } catch (error) {
        lastError = error
        if (!allowAutoFallback) throw error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('No authorized model route is available')
  }

  async allocateFallback(event: EventDraft, parent: ModelRoute, failedRoute: ModelRoute, goal?: string,
    signal?: AbortSignal, options: Omit<AllocateOptions, 'requested'> = {}): Promise<ModelRoute | undefined> {
    this.markRouteFailed(failedRoute)
    try {
      return await this.allocate(event, parent, undefined, true, goal, signal, {
        ...options,
        sessionMode: 'fresh',
        allowFallback: true,
        excludeRoutes: [...(options.excludeRoutes ?? []), failedRoute],
      })
    } catch {
      return undefined
    }
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
          if (budget.requests >= this.#limits.requests) {
            throw new ModelBudgetError('Task model budget exhausted')
          }
          const ledgers = scopes.map(scope => {
            const key = JSON.stringify([event.taskId, scope.nodeId])
            const ledger = this.#store.get<Budget>(scopedBudgets, key) ?? emptyBudget
            if (ledger.requests >= scope.requests) {
              throw new ModelBudgetError('Delegated model budget exhausted')
            }
            return { key, ledger }
          })
          const entry = { id: randomUUID(), event, request, tokens, started: performance.now(),
            status: 'pending' as const, scopeKeys: ledgers.map(({ key }) => key) }
          for (const { key, ledger } of ledgers) {
            this.#store.put(scopedBudgets, key, { ...ledger, requests: ledger.requests + 1, reserved: ledger.reserved + tokens })
          }
          this.#store.put(budgets, event.taskId, { ...budget, requests: budget.requests + 1, reserved: budget.reserved + tokens })
          this.#store.put(reservations, entry.id, entry)
          this.#store.append({ ...event, correlationId: entry.id, type: 'model.reserved', payload: { route: request.route, kind: request.kind,
            estimatedTokens: tokens, estimatedInputTokens: request.estimatedInputTokens, maxOutputTokens: request.maxOutputTokens,
            taskRequestLimit: this.#limits.requests } })
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

  getRouteStatus() { return { quota: 'unknown' as const, activeReservations: this.#active.size } }
}
