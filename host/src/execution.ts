import type { ModelRoute, SessionRef } from './contracts/domain.ts'
export type { ModelRoute, SessionRef } from './contracts/domain.ts'

export interface ExecutionTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(callId: string, input: unknown, signal?: AbortSignal): Promise<unknown>
}

export type RuntimeEvent =
  | { type: 'message.delta'; delta: string }
  | { type: 'instruction.applied'; instructionId: string }
  | { type: 'model.request_started' }
  | { type: 'model.output_recovery'; trigger: 'automatic' | 'resume' }
  | { type: 'model.usage'; input: number; output: number; cacheRead: number; cacheWrite: number; estimatedCostUsd?: number }
  | { type: 'model.route_changed'; route: ModelRoute }
  | { type: 'context.compacted'; tokensBefore: number; estimatedTokensAfter?: number }

export interface ModelCandidate {
  route: ModelRoute
  contextWindow: number
  input: readonly string[]
  reasoning: boolean
  estimatedCost?: number
}

export interface ModelRequest {
  route: ModelRoute
  estimatedInputTokens: number
  maxOutputTokens: number
  kind: 'prompt' | 'compaction'
}

export interface ExecutionConfig {
  cwd: string
  correlationId?: string
  role?: 'root' | 'team' | 'worker'
  sessionDirectory: string
  session?: SessionRef
  route?: ModelRoute
  tools: ExecutionTool[]
  systemPrompt: string
  resumeAfterOutputLimit?: boolean
  canRecoverModelOutput?(): boolean
  reserveRequest?(request: ModelRequest): void
  onEvent(event: RuntimeEvent): void
}

export type ExecutionResult =
  | { status: 'completed'; text: string }
  | { status: 'interrupted' | 'model_error' | 'model_output_limit' | 'runtime_error' }

export interface ExecutionSession {
  readonly ref: SessionRef
  readonly route: ModelRoute
  run(prompt: string): Promise<ExecutionResult>
  steer(text: string, instructionId?: string): Promise<void>
  requestStop(): Promise<void>
  checkpoint(): Promise<void>
  dispose(): Promise<void>
}

export interface AgentExecution {
  open(config: ExecutionConfig): Promise<ExecutionSession>
  validateRoute(route: ModelRoute): Promise<void>
  discoverModels?(provider?: string): Promise<readonly ModelCandidate[]>
}

export class ModelUnavailableError extends Error {}
