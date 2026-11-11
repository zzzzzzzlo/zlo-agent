export interface ModelRoute {
  provider: string
  model: string
}

export interface ModelCatalogEntry {
  route: ModelRoute
  name: string
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

export type VerificationVerdict = 'verified' | 'unverified' | 'failed' | 'not_applicable'

export interface VerificationResult {
  passed: boolean
  evidence: string
  verdict?: VerificationVerdict
  basis?: 'workspace_path' | 'project_command' | 'handoff' | 'none'
}

const legacyCheckEvidence = new Set([
  'workspace_text_file_exists', 'workspace_file_contains_expected_text', 'workspace_command_passed', 'project_command_exit_zero',
])

export function verificationVerdict(result: VerificationResult): VerificationVerdict {
  switch (result.verdict) {
    case 'unverified':
    case 'failed':
    case 'not_applicable': return result.verdict
    case 'verified': return result.passed === true ? 'verified' : 'failed'
  }
  if (result.passed !== true) return 'failed'
  return legacyCheckEvidence.has(result.evidence) ? 'verified' : 'unverified'
}

export function normalizeVerification(result: VerificationResult): VerificationResult {
  const verdict = verificationVerdict(result)
  return { ...result, verdict, passed: verdict === 'verified' }
}

export type TaskStatus = 'ready' | 'running' | 'verifying' | 'succeeded' | 'failed' |
  'blocked' | 'stop_requested' | 'stopping' | 'stopped' | 'needs_reconciliation'

export type EndReason = 'user_stop' | 'host_shutdown' | 'process_interrupted' | 'model_error' |
  'model_interrupted' | 'runtime_error' | 'verification_failed' | 'unknown_effect' | 'checkpoint_error' |
  'stop_timeout' | 'budget_exhausted' | 'model_output_limit'
