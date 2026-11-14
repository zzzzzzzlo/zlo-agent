import { createHash } from 'node:crypto'
import { jevModel, jevReasons } from '../../shared/contracts/jev.ts'
import type { DecisionPoint, JevDecisionStatus, JevReason, JudgmentMode } from '../../shared/contracts/jev.ts'
import type { EventDraft } from './contracts/domain.ts'
import type { LocalStore } from './store.ts'

export type { DecisionPoint, JudgmentMode } from '../../shared/contracts/jev.ts'
type Choice = string | number | boolean

export interface JudgeRequest {
  id: DecisionPoint
  schemaVersion: 1
  input: Readonly<Record<string, unknown>>
  baseline: Choice
  allowed: readonly Choice[]
  evidenceRefs: readonly string[]
}

export interface JudgeResponse {
  output: unknown
  usage?: { input: number; output: number; estimatedCostUsd?: number }
  reason?: JevReason
  model?: string
  requestSent?: boolean
}

export interface JudgmentItem {
  readonly baseline: boolean
  readonly excerpt?: string
  readonly label?: string
}

export interface JudgeBatchRequest {
  id: DecisionPoint
  schemaVersion: 1
  input: Readonly<Record<string, unknown>>
  items: readonly JudgmentItem[]
  evidenceRefs: readonly string[]
}

export interface JudgeBatchResponse extends Omit<JudgeResponse, 'output'> {
  items?: readonly { output?: unknown; reason?: JevReason }[]
}

export interface Judge {
  evaluate(request: JudgeRequest, signal: AbortSignal): Promise<JudgeResponse>
  evaluateBatch?(request: JudgeBatchRequest, signal: AbortSignal): Promise<JudgeBatchResponse>
}

export interface JudgmentOptions {
  modes?: Partial<Record<DecisionPoint, JudgmentMode>>
  judge?: Judge
  timeoutMs?: number
  policy?: (point: DecisionPoint, taskId: string) => {
    mode: JudgmentMode
    judge?: Judge
    signal?: AbortSignal
    allowScopedEvidence?: boolean
  }
  observe?: (point: DecisionPoint, status: JevDecisionStatus) => void
}

type JudgeStatus = 'baseline' | 'valid' | 'invalid' | 'failed' | 'timed_out' | 'busy'
interface Candidate {
  status: JudgeStatus
  output?: Choice
  usage?: JudgeResponse['usage']
  reason?: JevReason
  model?: string
  requestSent?: boolean
  items?: readonly { output?: boolean; reason?: JevReason }[]
}

export const maxJudgmentItems = 8
const maxConcurrentJudgeCalls = 4
const referencePattern = /^[a-zA-Z0-9_.:-]{1,128}$/
const commandReference = /^(?:team|plan|replan):[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:[a-f0-9]{32}$/

interface JudgmentLinks {
  planRequestId?: string
  delegationReceiptId?: string
  signal?: AbortSignal
  scopedEvidence?: () => Record<string, unknown>
}

function digest(value: string): string {
  return 'sha256:' + createHash('sha256').update(value).digest('hex')
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000 ? value : undefined
}

function flag(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function cost(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10_000_000 ? value : undefined
}

function category(value: unknown, allowed: readonly string[]): string | undefined {
  return typeof value === 'string' && allowed.includes(value) ? value : undefined
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function candidates(input: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(input.candidates) ? input.candidates.slice(0, 8).map(record) : []
}

function routeKey(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 200 ? digest(value) : undefined
}

function publicChoice(point: DecisionPoint, choice: Choice, choices: readonly Choice[]): Choice {
  if (typeof choice !== 'string' || (point === 'collaboration.mode' && (choice === 'worker' || choice === 'team'))) return choice
  return 'opaque:' + choices.indexOf(choice)
}

function publicFeatures(point: DecisionPoint, input: Record<string, unknown>): Record<string, unknown> {
  switch (point) {
    case 'collaboration.mode': return {
      nodeCount: count(input.nodeCount), nodeOrdinal: count(input.nodeOrdinal),
      teamCandidate: flag(input.teamCandidate), hasDependencies: flag(input.hasDependencies),
    }
    case 'delegation.worth': return {
      role: category(input.role, ['root', 'team']), goalLength: count(input.goalLength), nonEmptyGoal: flag(input.nonEmptyGoal),
    }
    case 'model.task_fit': return {
      independent: flag(input.independent), requested: flag(input.requested),
      candidates: candidates(input).map((candidate, index) => ({
        index, providerKey: routeKey(candidate.provider), modelKey: routeKey(candidate.model),
        contextWindow: count(candidate.contextWindow), supportsText: flag(candidate.supportsText),
        estimatedCost: cost(candidate.estimatedCost),
      })),
    }
    case 'context.relevance': return {
      candidates: candidates(input).map((candidate, index) => ({
        index, kind: category(candidate.kind, ['fact', 'experience']), rank: count(candidate.rank),
        evidenceCount: count(candidate.evidenceCount), estimatedBytes: count(candidate.estimatedBytes),
      })),
    }
    case 'handoff.sufficiency': return {
      role: category(input.role, ['team', 'worker']), access: category(input.access, ['read', 'write', 'trusted']),
      evidenceCount: count(input.evidenceCount), artifactCount: count(input.artifactCount), completedChildren: count(input.completedChildren),
      checked: flag(input.checked), checkPassed: flag(input.checkPassed),
    }
    case 'task.replan': return {
      status: category(input.status, ['missing', 'ready', 'running', 'failed', 'succeeded']), requested: flag(input.requested),
      hasWrite: flag(input.hasWrite), replanCount: count(input.replanCount), isRootChild: flag(input.isRootChild),
    }
    default: return {
      evidenceCount: count(input.evidenceCount), failedCount: count(input.failedCount),
      writeCount: count(input.writeCount), checkConfigured: flag(input.checkConfigured),
      checkPassed: flag(input.checkPassed), toolCount: count(input.toolCount),
      length: count(input.length), initial: flag(input.initial),
      tool: category(input.tool, ['web_search', 'web_fetch', 'browser_snapshot', 'process_output',
        'search_files', 'search_content', 'read_text_file', 'git_diff']),
    }
  }
}

function usageFor(response: Pick<JudgeResponse, 'usage'>): JudgeResponse['usage'] {
  const usage = response.usage
  if (!usage || !Number.isSafeInteger(usage.input) || !Number.isSafeInteger(usage.output) ||
    usage.input < 0 || usage.output < 0) return undefined
  const estimatedCostUsd = cost(usage.estimatedCostUsd)
  return { input: usage.input, output: usage.output, ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }) }
}

function publicRefs(evidenceRefs: string[]) {
  return Object.freeze([...new Set(evidenceRefs.filter(ref => referencePattern.test(ref)))].slice(0, 16).map(digest))
}

function resultMetadata(response: Omit<JudgeResponse, 'output'>) {
  return {
    usage: usageFor(response),
    model: jevModel(response.model) ? response.model : undefined,
    requestSent: response.requestSent === true,
  }
}

function fallback(reason: unknown): JevReason {
  return jevReasons.includes(reason as JevReason) ? reason as JevReason : 'invalid_response'
}

function failedCandidate(reason: JevReason, metadata: Partial<Candidate> = {}): Candidate {
  return { ...metadata, status: reason === 'invalid_response' || reason === 'uncertain' ? 'invalid' : 'failed', reason }
}

export class LocalJudgment {
  readonly #store: LocalStore
  readonly #modes: JudgmentOptions['modes']
  readonly #judge: Judge | undefined
  readonly #timeoutMs: number
  readonly #policy: JudgmentOptions['policy']
  readonly #observe: JudgmentOptions['observe']
  #active = 0

  constructor(store: LocalStore, options: JudgmentOptions = {}) {
    this.#store = store
    this.#modes = { ...options.modes }
    this.#judge = options.judge
    this.#timeoutMs = options.timeoutMs ?? 1000
    this.#policy = options.policy
    this.#observe = options.observe
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 10000) {
      throw new RangeError('Invalid judge deadline')
    }
  }

  mode(point: DecisionPoint, taskId: string): JudgmentMode {
    return this.#policy?.(point, taskId)?.mode ?? this.#modes?.[point] ?? 'off'
  }

  async decide<O extends Choice>(
    event: EventDraft,
    point: DecisionPoint,
    input: Record<string, unknown>,
    baseline: O,
    allowed: readonly O[],
    evidenceRefs: string[] = [],
    links: JudgmentLinks = {},
  ): Promise<O> {
    const started = performance.now()
    const choices: readonly O[] = Object.freeze([...new Set(allowed)])
    if (!choices.includes(baseline) || choices.length > 16 || choices.some((choice) => !validChoice(choice))) {
      throw new Error('Judgment requires an allowed rule baseline and bounded choices')
    }
    const refs = publicRefs(evidenceRefs)
    const policy = this.#policy?.(point, event.taskId)
    const mode = policy?.mode ?? this.#modes?.[point] ?? 'off'
    const judge = policy ? policy.judge : this.#judge
    let candidate: Candidate = { status: 'baseline' }
    if (mode !== 'off' && judge) {
      const signals = [policy?.signal, links.signal].filter(signal => signal !== undefined)
      const judgeInput = policy?.allowScopedEvidence && choices.length > 1 ? { ...input, ...links.scopedEvidence?.() } : input
      candidate = await this.#evaluate(async signal => {
        const response = await judge.evaluate({ id: point, schemaVersion: 1, input: structuredClone(judgeInput),
          baseline, allowed: choices, evidenceRefs: refs }, signal)
        const output = choices.find(choice => choice === response.output)
        const metadata = resultMetadata(response)
        if (response.reason) return failedCandidate(fallback(response.reason), metadata)
        return output === undefined ? failedCandidate('invalid_response', metadata) : { ...metadata, status: 'valid', output }
      }, signals)
    }
    if (policy?.signal?.aborted) candidate = { ...candidate, status: 'failed', reason: 'configuration_changed' }
    if (links.signal?.aborted) candidate = { ...candidate, status: 'failed', reason: 'cancelled' }
    const chosen = candidate.status === 'valid' ? candidate.output as O : undefined
    const output = mode === 'active' && chosen !== undefined ? chosen : baseline
    this.#publish(event, point, mode, input, refs, links, candidate, started, Boolean(policy), {
      candidates: choices.map(choice => publicChoice(point, choice, choices)),
      baseline: publicChoice(point, baseline, choices),
      output: publicChoice(point, output, choices),
      ...(chosen !== undefined ? { judgeOutput: publicChoice(point, chosen, choices), disagreement: chosen !== baseline } : {}),
      ...(mode === 'shadow' && chosen !== undefined ? { shadow: publicChoice(point, chosen, choices) } : {}),
    })
    return output
  }

  async decideBatch(
    event: EventDraft,
    point: DecisionPoint,
    input: Record<string, unknown>,
    items: readonly JudgmentItem[],
    evidenceRefs: string[] = [],
    links: JudgmentLinks = {},
  ): Promise<readonly boolean[]> {
    if (items.length > maxJudgmentItems || items.some(item => typeof item.baseline !== 'boolean')) {
      throw new RangeError('Judgment requires at most eight boolean baselines')
    }
    const baseline = items.map(item => item.baseline)
    if (!baseline.length) return baseline
    const started = performance.now()
    const policy = this.#policy?.(point, event.taskId)
    const mode = policy?.mode ?? this.#modes?.[point] ?? 'off'
    const judge = policy ? policy.judge : this.#judge
    const refs = publicRefs(evidenceRefs)
    let candidate: Candidate = { status: 'baseline' }
    if (mode !== 'off' && judge) {
      const signals = [policy?.signal, links.signal].filter(signal => signal !== undefined)
      const judgeInput = policy?.allowScopedEvidence ? { ...input, ...links.scopedEvidence?.() } : input
      const judgeItems = items.map(item => policy?.allowScopedEvidence ? {
        baseline: item.baseline, label: item.label, excerpt: item.excerpt,
      } : { baseline: item.baseline })
      candidate = await this.#evaluate(async signal => {
        if (!judge.evaluateBatch) return failedCandidate('no_choice')
        const response = await judge.evaluateBatch({ id: point, schemaVersion: 1, input: structuredClone(judgeInput),
          items: judgeItems, evidenceRefs: refs }, signal)
        const metadata = resultMetadata(response)
        if (response.reason) return failedCandidate(fallback(response.reason), metadata)
        if (!Array.isArray(response.items) || response.items.length !== baseline.length) return failedCandidate('invalid_response', metadata)
        const results = baseline.map((_, index) => {
          const result = response.items?.[index]
          if (result?.reason) return { reason: fallback(result.reason) }
          return typeof result?.output === 'boolean' ? { output: result.output } : { reason: 'invalid_response' as const }
        })
        if (results.every(item => item.output === undefined)) return failedCandidate(results[0].reason ?? 'invalid_response', { ...metadata, items: results })
        return { ...metadata, status: 'valid', items: results }
      }, signals)
    }
    if (policy?.signal?.aborted) candidate = { ...candidate, status: 'failed', reason: 'configuration_changed', items: undefined }
    if (links.signal?.aborted) candidate = { ...candidate, status: 'failed', reason: 'cancelled', items: undefined }
    const judgeOutput = baseline.map((_, index) => candidate.items?.[index]?.output ?? null)
    const fallbackReasons = baseline.map((_, index) => candidate.items?.[index]?.reason ?? candidate.reason ?? null)
    const output = baseline.map((value, index) => mode === 'active' ? judgeOutput[index] ?? value : value)
    this.#publish(event, point, mode, input, refs, links, candidate, started, Boolean(policy), {
      batch: { baseline, output, judgeOutput, fallbackReasons },
      ...(judgeOutput.some(value => value !== null)
        ? { disagreement: judgeOutput.some((value, index) => value !== null && value !== baseline[index]) } : {}),
    })
    return output
  }

  #publish(event: EventDraft, point: DecisionPoint, mode: JudgmentMode, input: Record<string, unknown>,
    refs: readonly string[], links: JudgmentLinks, candidate: Candidate, started: number, managed: boolean,
    decision: Record<string, unknown>): void {
    this.#store.transaction(() => {
      if (mode !== 'off') this.#observe?.(point, { mode, at: new Date().toISOString(), reason: candidate.reason, model: candidate.model })
      this.#store.append({
        ...event,
        type: 'judgment.evaluated',
        payload: {
          id: point,
          schemaVersion: 1,
          featureSchemaVersion: 1,
          mode,
          features: publicFeatures(point, input),
          ...decision,
          evidenceRefs: refs,
          resultLink: {
            taskRunId: event.taskRunId, taskNodeId: event.taskNodeId, taskAttemptId: event.taskAttemptId,
            agentRunId: event.agentRunId,
            ...(links.planRequestId && commandReference.test(links.planRequestId) ? { planRequestId: links.planRequestId } : {}),
            ...(links.delegationReceiptId ? { delegationReceiptKey: digest(links.delegationReceiptId) } : {}),
          },
          elapsedMs: Math.round(performance.now() - started),
          judgeStatus: candidate.status,
          ...(candidate.reason ? { fallbackReason: candidate.reason } : {}),
          ...(candidate.model ? { judgeModel: candidate.model } : {}),
          ...(managed && mode !== 'off' ? { requestSent: candidate.requestSent ?? candidate.status === 'timed_out' } : {}),
          ...(candidate.usage ? { usage: candidate.usage } : {}),
        },
      })
    })
  }

  async #evaluate(run: (signal: AbortSignal) => Promise<Candidate>, signals: AbortSignal[]): Promise<Candidate> {
    if (signals.some(signal => signal.aborted)) return failedCandidate('cancelled')
    if (this.#active >= maxConcurrentJudgeCalls) return { status: 'busy', reason: 'busy' }
    this.#active++
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, ...signals])
    const evaluation = Promise.resolve().then(async (): Promise<Candidate> => {
      try {
        signal.throwIfAborted()
        return await run(signal)
      } catch {
        return { status: 'failed', reason: 'unavailable' }
      } finally {
        this.#active--
      }
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<Candidate>((resolve) => {
      timer = setTimeout(() => {
        resolve({ status: 'timed_out', reason: 'timeout' })
        controller.abort()
      }, this.#timeoutMs)
    })
    try {
      return await Promise.race([evaluation, timeout])
    } finally {
      clearTimeout(timer)
    }
  }
}

function validChoice(choice: unknown): choice is Choice {
  return typeof choice === 'boolean' ||
    (typeof choice === 'number' && Number.isSafeInteger(choice)) ||
    (typeof choice === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(choice))
}
