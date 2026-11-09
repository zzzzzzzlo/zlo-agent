export interface ModelRoute {
  provider: string
  model: string
}

export interface VerificationCheck {
  path: string
  contains?: string
}

export interface VerificationResult {
  passed: boolean
  evidence: string
}

export type TaskStatus = 'ready' | 'running' | 'verifying' | 'succeeded' | 'failed' |
  'blocked' | 'stop_requested' | 'stopping' | 'stopped' | 'needs_reconciliation'

export type EndReason = 'user_stop' | 'host_shutdown' | 'process_interrupted' | 'model_error' |
  'model_interrupted' | 'runtime_error' | 'verification_failed' | 'unknown_effect' | 'checkpoint_error' |
  'stop_timeout' | 'budget_exhausted'

export interface SessionRef {
  id: string
  path: string
}

export interface EventDraft {
  taskId: string
  type: string
  taskRunId?: string
  taskNodeId?: string
  taskAttemptId?: string
  agentId?: string
  agentRunId?: string
  sessionId?: string
  parentAgentRunId?: string
  correlationId?: string
  causationId?: string
  payload: Record<string, unknown>
}

export interface AgentEvent extends EventDraft {
  schemaVersion: 1
  id: string
  seq: number
  occurredAt: string
}

export interface ContextPackage {
  taskId: string
  nodeId: string
  goal: string
  constraints: string[]
  sourceMessageIds: string[]
  artifactRefs: string[]
  availableTools: string[]
  maxModelRequests: number
}
