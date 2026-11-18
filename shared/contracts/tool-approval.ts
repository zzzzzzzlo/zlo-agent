export const approvalKinds = ['shell', 'destructive', 'git', 'browser_action', 'export', 'network'] as const
export type ApprovalKind = typeof approvalKinds[number]
export type ToolApprovalMode = 'ask' | 'routine' | 'unattended' | 'full'
export function isToolApprovalMode(value: unknown): value is ToolApprovalMode {
  return value === 'ask' || value === 'routine' || value === 'unattended' || value === 'full'
}

export interface DesktopToolApprovals {
  pending(): Promise<ToolApprovalRequest[]>
  decide(input: { id: string; approved: boolean }): Promise<boolean>
  onChange(listener: (requests: ToolApprovalRequest[]) => void): () => void
}

export interface ToolApprovalRequest {
  id: string
  kind: ApprovalKind
  tool: string
  detail: string
  workspace: string
  conversationId?: string
  conversationTitle?: string
  suggestedName?: string
}

export type ToolApprovalDecision = { approved: false } | { approved: true; destination?: string }

export interface ToolApprovalCommand {
  schemaVersion: 1
  type: 'resolveToolApproval'
  approvalId: string
  decision: ToolApprovalDecision
}
