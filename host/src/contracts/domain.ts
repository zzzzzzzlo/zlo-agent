export type { EndReason, ModelRoute, TaskStatus, VerificationCheck, VerificationResult } from '../../../shared/contracts/domain.ts'

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
