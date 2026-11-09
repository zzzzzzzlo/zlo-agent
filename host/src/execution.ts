export interface SessionRef {
  id: string
  path: string
}

export interface ModelRoute {
  provider: string
  model: string
}

export interface ExecutionTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(callId: string, input: unknown, signal?: AbortSignal): Promise<unknown>
}

export type RuntimeEvent =
  | { type: 'message.delta'; delta: string }
  | { type: 'model.request_started' }
  | { type: 'model.usage'; input: number; output: number; cacheRead: number; cacheWrite: number }
  | { type: 'model.route_changed'; route: ModelRoute }

export interface ExecutionConfig {
  cwd: string
  sessionDirectory: string
  session?: SessionRef
  route?: ModelRoute
  tools: ExecutionTool[]
  systemPrompt: string
  onEvent(event: RuntimeEvent): void
}

export type ExecutionResult =
  | { status: 'completed'; text: string }
  | { status: 'interrupted' | 'model_error' | 'runtime_error' }

export interface ExecutionSession {
  readonly ref: SessionRef
  readonly route: ModelRoute
  run(prompt: string): Promise<ExecutionResult>
  steer(text: string): Promise<void>
  requestStop(): Promise<void>
  checkpoint(): Promise<void>
  dispose(): Promise<void>
}

export interface AgentExecution {
  open(config: ExecutionConfig): Promise<ExecutionSession>
  validateRoute(route: ModelRoute): Promise<void>
}

export class ModelUnavailableError extends Error {}
