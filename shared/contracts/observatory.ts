import type { ModelRoute } from './domain.ts'

export interface TelemetryEvent {
  schemaVersion: 1
  id: string
  seq: number
  occurredAt: string
  taskId: string
  type: string
  payload: Record<string, unknown>
  taskRunId?: string
  taskNodeId?: string
  taskAttemptId?: string
  agentId?: string
  agentRunId?: string
  parentAgentRunId?: string
  correlationId?: string
  causationId?: string
}

export interface TelemetryVerification {
  verdict: string
  passed: boolean
  basis?: string
  evidence?: string
}

export interface TelemetryNode {
  id: string
  parentNodeId: string
  dependencies: string[]
  status: string
  attemptId?: string
  role?: 'team' | 'worker'
  route?: ModelRoute
  verification?: TelemetryVerification
  replans?: number
}

export interface TelemetryAttempt {
  id: string
  nodeId: string
  startedAt: string
  finishedAt?: string
  status: string
  reason?: string
  recoveries?: number
}

export interface TelemetryTask {
  id: string
  taskRunId: string
  rootNodeId: string
  status: string
  reason?: string
  route?: ModelRoute
  verification?: TelemetryVerification
  attemptCount: number
  planVersion: number
  cursor: number
  nodes: TelemetryNode[]
  attempts: TelemetryAttempt[]
}

export interface TelemetryTaskHead { id: string; cursor: number }

/** Explicitly requested, transient material. Never embed in telemetry or normal diagnostics. */
export interface EvaluationEvidence {
  taskId: string
  taskRunId: string
  nodeId?: string
  capturedAt: string
  goal: string
  constraints: string[]
  verification?: TelemetryVerification
  snapshotVerification?: TelemetryVerification
  artifacts: { path: string; digest: string; bytes: number; excerpt?: string; diff?: string }[]
  operations: { id: string; tool: string; status: string; effect?: string }[]
  structure: string[]
  limitations: string[]
}
