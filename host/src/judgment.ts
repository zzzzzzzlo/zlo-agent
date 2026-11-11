import { createHash } from 'node:crypto'
import type { EventDraft } from './contracts/domain.ts'
import type { LocalStore } from './store.ts'

export type DecisionPoint =
  | 'collaboration.mode'
  | 'delegation.worth'
  | 'model.task_fit'
  | 'context.relevance'
  | 'handoff.sufficiency'
  | 'task.replan'
export type JudgmentMode = 'off' | 'shadow' | 'active'
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
}

export interface Judge {
  evaluate(request: JudgeRequest, signal: AbortSignal): Promise<JudgeResponse>
}

export interface JudgmentOptions {
  modes?: Partial<Record<DecisionPoint, JudgmentMode>>
  judge?: Judge
  timeoutMs?: number
}

type JudgeStatus = 'baseline' | 'valid' | 'invalid' | 'failed' | 'timed_out' | 'busy'
interface Candidate {
  status: JudgeStatus
  output?: Choice
  usage?: JudgeResponse['usage']
}

const maxConcurrentJudgeCalls = 4
const referencePattern = /^[a-zA-Z0-9_.:-]{1,128}$/
const commandReference = /^(?:team|plan|replan):[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:[a-f0-9]{32}$/

interface JudgmentLinks {
  planRequestId?: string
  delegationReceiptId?: string
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
  }
}

function usageFor(response: JudgeResponse): JudgeResponse['usage'] {
  const usage = response.usage
  if (!usage || !Number.isSafeInteger(usage.input) || !Number.isSafeInteger(usage.output) ||
    usage.input < 0 || usage.output < 0) return undefined
  const estimatedCostUsd = cost(usage.estimatedCostUsd)
  return { input: usage.input, output: usage.output, ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }) }
}

export class LocalJudgment {
  readonly #store: LocalStore
  readonly #modes: JudgmentOptions['modes']
  readonly #judge: Judge | undefined
  readonly #timeoutMs: number
  #active = 0

  constructor(store: LocalStore, options: JudgmentOptions = {}) {
    this.#store = store
    this.#modes = { ...options.modes }
    this.#judge = options.judge
    this.#timeoutMs = options.timeoutMs ?? 1000
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 10000) {
      throw new RangeError('Invalid judge deadline')
    }
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
    const refs = Object.freeze([...new Set(evidenceRefs.filter((ref) => referencePattern.test(ref)))].slice(0, 16).map(digest))
    const mode = this.#modes?.[point] ?? 'off'
    let candidate: Candidate = { status: 'baseline' }
    if (mode !== 'off' && this.#judge) {
      candidate = await this.#evaluate(this.#judge, { id: point, schemaVersion: 1, input, baseline, allowed: choices, evidenceRefs: refs })
    }
    const output = mode === 'active' && candidate.status === 'valid' ? candidate.output as O : baseline
    this.#store.transaction(() => {
      this.#store.append({
        ...event,
        type: 'judgment.evaluated',
        payload: {
          id: point,
          schemaVersion: 1,
          featureSchemaVersion: 1,
          mode,
          features: publicFeatures(point, input),
          candidates: choices.map(choice => publicChoice(point, choice, choices)),
          baseline: publicChoice(point, baseline, choices),
          output: publicChoice(point, output, choices),
          evidenceRefs: refs,
          resultLink: {
            taskRunId: event.taskRunId, taskNodeId: event.taskNodeId, taskAttemptId: event.taskAttemptId,
            agentRunId: event.agentRunId,
            ...(links.planRequestId && commandReference.test(links.planRequestId) ? { planRequestId: links.planRequestId } : {}),
            ...(links.delegationReceiptId ? { delegationReceiptKey: digest(links.delegationReceiptId) } : {}),
          },
          elapsedMs: Math.round(performance.now() - started),
          judgeStatus: candidate.status,
          ...(mode === 'shadow' && candidate.output !== undefined ? { shadow: publicChoice(point, candidate.output, choices) } : {}),
          ...(candidate.usage ? { usage: candidate.usage } : {}),
        },
      })
    })
    return output
  }

  async #evaluate(judge: Judge, request: JudgeRequest): Promise<Candidate> {
    if (this.#active >= maxConcurrentJudgeCalls) return { status: 'busy' }
    this.#active++
    const controller = new AbortController()
    const evaluation = Promise.resolve().then(async (): Promise<Candidate> => {
      try {
        const response = await judge.evaluate({ ...request, input: structuredClone(request.input) }, controller.signal)
        const output = request.allowed.find((choice) => choice === response.output)
        const usage = usageFor(response)
        return output === undefined ? { status: 'invalid', usage } : { status: 'valid', output, usage }
      } catch {
        return { status: 'failed' }
      } finally {
        this.#active--
      }
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<Candidate>((resolve) => {
      timer = setTimeout(() => {
        resolve({ status: 'timed_out' })
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
