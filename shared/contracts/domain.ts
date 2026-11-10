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
