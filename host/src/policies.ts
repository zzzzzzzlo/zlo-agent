import type { AgentExecution } from './execution.ts'
import type { ContextPackage, ModelRoute } from './contracts/domain.ts'

export interface ModelResourceScheduler {
  validateRoute(route: ModelRoute): Promise<void>
  canSwitch(current: ModelRoute, target: ModelRoute): boolean
  reserve(taskId: string, role: 'root' | 'worker'): () => void
  getRouteStatus(): { quota: 'unknown'; activeReservations: number }
}

export class LocalModelScheduler implements ModelResourceScheduler {
  readonly #execution: AgentExecution
  readonly #active = new Set<string>()

  constructor(execution: AgentExecution) { this.#execution = execution }

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

  reserve(taskId: string, role: 'root' | 'worker'): () => void {
    const key = taskId + ':' + role
    if (this.#active.has(key)) throw new Error('Agent capacity exhausted')
    this.#active.add(key)
    return () => { this.#active.delete(key) }
  }

  getRouteStatus() { return { quota: 'unknown' as const, activeReservations: this.#active.size } }
}

export interface ContextBuilder {
  worker(context: ContextPackage): string
}

export class LocalContextBuilder implements ContextBuilder {
  worker(context: ContextPackage): string {
    return [
      'Investigate this scoped task in the supplied workspace using the read-only tools.',
      'Return a concise factual summary with relative file references and remaining risks.',
      'Task goal: ' + context.goal,
      'Constraints: ' + context.constraints.join(' '),
      'Available tools: ' + context.availableTools.join(', '),
      'Model request budget: ' + context.maxModelRequests,
      ...(context.artifactRefs.length ? ['Relevant workspace artifacts: ' + context.artifactRefs.join(', ')] : []),
    ].join('\n')
  }
}

export interface MemoryCore {
  recall(query: { taskId: string; scope: string }): Promise<{ text: string; sourceRefs: string[] }[]>
  proposeCapture(source: { taskId: string; evidenceRefs: string[] }): Promise<void>
}

export class NoopMemoryCore implements MemoryCore {
  async recall() { return [] }
  async proposeCapture() {}
}

export interface DecisionSpec<I, O> {
  id: string
  schemaVersion: 1
  mode: 'off' | 'shadow' | 'active'
  baseline(input: I): O
}

export interface DecisionResult<O> {
  schemaVersion: 1
  id: string
  mode: DecisionSpec<never, O>['mode']
  baseline: O
  output: O
  elapsedMs: number
  evidenceRefs: string[]
  shadow?: O
}

export interface JudgmentKernel {
  evaluate<I, O>(spec: DecisionSpec<I, O>, input: I, evidenceRefs: string[]): Promise<DecisionResult<O>>
}

export class BaselineJudgment implements JudgmentKernel {
  async evaluate<I, O>(spec: DecisionSpec<I, O>, input: I, evidenceRefs: string[]): Promise<DecisionResult<O>> {
    const started = performance.now()
    const baseline = spec.baseline(input)
    return { schemaVersion: 1, id: spec.id, mode: spec.mode, output: baseline, baseline, evidenceRefs, elapsedMs: performance.now() - started }
  }
}

export interface SandboxProvider {
  prepare(policy: { cwd: string; network: 'deny' }): Promise<{ supported: false } | { supported: true; dispose(): Promise<void> }>
}

export class UnsupportedSandbox implements SandboxProvider {
  async prepare() { return { supported: false as const } }
}

export interface CapabilityGateway {
  authorize(role: 'root' | 'worker', effect: 'read' | 'write'): boolean
}

export interface CodingProfile {
  workspaceWrites: boolean
  delegation: boolean
}

export const defaultCodingProfile: Readonly<CodingProfile> = { workspaceWrites: true, delegation: true }

export class CodingCapabilities implements CapabilityGateway {
  readonly #profile: Readonly<CodingProfile>

  constructor(profile: Readonly<CodingProfile> = defaultCodingProfile) { this.#profile = profile }

  authorize(role: 'root' | 'worker', effect: 'read' | 'write') {
    return effect === 'read' || (role === 'root' && this.#profile.workspaceWrites)
  }
}
