export interface ModelRoute {
  provider: string
  model: string
}

export type WorkspaceAccess = 'read' | 'write' | 'trusted'

export const projectCommands = ['npm_test', 'npm_build', 'npm_lint', 'npm_typecheck', 'node_script'] as const
export interface ProjectCommand {
  command: typeof projectCommands[number]
  path: string
  args?: string[]
}

export type VerificationCheck =
  | { path: string; contains?: string; command?: never }
  | { path?: never; contains?: never; command: ProjectCommand }

export interface VerificationResult {
  passed: boolean
  evidence: string
}

export type TaskStatus = 'ready' | 'running' | 'verifying' | 'succeeded' | 'failed' |
  'blocked' | 'stop_requested' | 'stopping' | 'stopped' | 'needs_reconciliation'

export type EndReason = 'user_stop' | 'host_shutdown' | 'process_interrupted' | 'model_error' |
  'model_interrupted' | 'runtime_error' | 'verification_failed' | 'unknown_effect' | 'checkpoint_error' |
  'stop_timeout' | 'budget_exhausted'
