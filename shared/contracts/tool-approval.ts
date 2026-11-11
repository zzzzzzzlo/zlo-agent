export const approvalKinds = ['shell', 'destructive', 'git', 'browser_action', 'export', 'network'] as const
export type ApprovalKind = typeof approvalKinds[number]

export interface ToolApprovalRequest {
  id: string
  kind: ApprovalKind
  tool: string
  detail: string
  workspace: string
  suggestedName?: string
}

export type ToolApprovalDecision = { approved: false } | { approved: true; destination?: string }

export interface ToolApprovalCommand {
  schemaVersion: 1
  type: 'resolveToolApproval'
  approvalId: string
  decision: ToolApprovalDecision
}
