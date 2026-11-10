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
  usage?: { input: number; output: number }
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

function usageFor(response: JudgeResponse): JudgeResponse['usage'] {
  const usage = response.usage
  if (!usage || !Number.isSafeInteger(usage.input) || !Number.isSafeInteger(usage.output) ||
    usage.input < 0 || usage.output < 0) return undefined
  return { input: usage.input, output: usage.output }
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
  ): Promise<O> {
    const started = performance.now()
    const choices: readonly O[] = Object.freeze([...new Set(allowed)])
    if (!choices.includes(baseline) || choices.some((choice) => !validChoice(choice))) {
      throw new Error('Judgment requires an allowed rule baseline and bounded choices')
    }
    const refs = Object.freeze([...new Set(evidenceRefs.filter((ref) => referencePattern.test(ref)))].slice(0, 16))
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
          mode,
          baseline,
          output,
          evidenceRefs: refs,
          elapsedMs: Math.round(performance.now() - started),
          judgeStatus: candidate.status,
          ...(mode === 'shadow' && candidate.status === 'valid' ? { shadow: candidate.output } : {}),
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
