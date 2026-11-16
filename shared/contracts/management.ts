import type { EndReason, ModelCatalogEntry, ModelRoute, TaskStatus, VerificationResult, VerificationVerdict, WorkspaceAccess } from './domain.ts'
import type { ConversationSummary, UsageTotals } from './desktop.ts'
import type { ChatGptSession } from './chatgpt.ts'
import type { JevSettings, JevStatus, JudgeCredentials } from './jev.ts'
import type { CustomProviderCredential, GrokCredential } from './provider-setup.ts'
import type { ToolApprovalMode } from './tool-approval.ts'

export type ProviderId = 'deepseek' | 'openai' | 'anthropic' | 'google'
export type ManagedModel = ModelCatalogEntry
export interface ManagedProvider<Id extends string = ProviderId> {
  id: Id
  name: string
  credential: 'stored' | 'environment' | 'missing'
  connection: 'untested' | 'connected' | 'unauthorized' | 'unavailable'
  models: ManagedModel[]
}

export interface AgentPreferences {
  workspaceAccess: WorkspaceAccess
  defaultRoute: ModelRoute | null
  modelSelection: 'automatic' | 'fixed'
  disabledTools: string[]
  searchProvider: 'hacker_news' | 'brave' | 'disabled'
}

export interface ManagedTool {
  name: string
  plugin: string
  effect: 'read' | 'write'
  approval: boolean
  enabled: boolean
  root: boolean
  team: boolean
  worker: boolean
}

export interface ManagedOperation {
  id: string
  tool: string
  status: string
  target?: string
  nodeId?: string
  approval?: string
  reconciliation?: {
    status: 'verified' | 'unresolved' | 'acknowledged'
    evidence: string
    previousEvidence?: string
    changedEntries?: number
    truncated?: boolean
  }
}

export interface ManagedTask {
  taskId: string
  status: TaskStatus
  reason?: EndReason
  verification?: VerificationResult
  rootNodeId: string
  nodes: {
    id: string
    role: 'root' | 'team' | 'worker'
    status: string
    goal: string
    parentNodeId?: string
    dependencies: string[]
    access: WorkspaceAccess
    scopePath?: string
    route?: ModelRoute
    verification?: VerificationResult
    result?: string
    tools?: string[]
    startedAt?: number
    finishedAt?: number
  }[]
  agents: {
    id: string
    nodeId: string
    role: 'root' | 'team' | 'worker'
    status: string
    parentId?: string
    route?: ModelRoute
    startedAt?: number
    finishedAt?: number
  }[]
  operations: ManagedOperation[]
  usage: UsageTotals & { estimatedCostUsd?: number; estimatedCostCny?: number; usdToCnyRate?: number }
  budget?: { tokenLimit?: number; costLimitUsd?: number; requests?: number; confirmed?: number; reserved?: number; uncertain?: number }
}

export interface ManagedMemory {
  entries: { id: string; kind: 'fact' | 'experience'; text: string; version: number; updatedAt: string }[]
  recalls: { taskId: string; timestamp: number; count: number }[]
}

export interface ManagedDiagnostic {
  timestamp: string
  module: string
  code: string
  level: string
  category: string
  summary: string
  correlationId: string
}

export interface ManagementSnapshot {
  version: string
  preferences: AgentPreferences
  braveConfigured: boolean
  providers: ManagedProvider<string>[]
  account: { available: false; reason: string }
  tools: ManagedTool[]
  conversation?: ConversationSummary
  tasks: ManagedTask[]
  memory?: ManagedMemory
  diagnostics: ManagedDiagnostic[]
}

export type VerificationRigorTier = 'T3' | 'T2' | 'T1' | 'T0'

export interface ConversationTurnMetric {
  taskId: string
  label: string
  status: TaskStatus
  verdict: VerificationVerdict
  rigorTier: VerificationRigorTier
  attemptCount: number
  firstPassVerified: boolean
  selfRepaired: boolean
  steered: boolean
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  estimatedCostUsd: number | null
  estimatedCostCny: number | null
  toolCalls: number
  toolFailed: number
  durationMs: number | null
  judgmentCalls?: number
  judgmentInterventions?: number
}

export interface ConversationJudgmentItem {
  taskId: string
  point: string
  mode: 'off' | 'shadow' | 'active'
  impactKind: 'intervened' | 'shadow_diff' | 'fallback' | 'aligned' | 'baseline_only' | 'unconfirmed'
  whatSummary: string
  verdictSummary: string
  impactSummary: string
  judgeModel?: string
  elapsedMs?: number
  fallbackReason?: string
}

export interface ConversationJudgmentSummary {
  total: number
  externalCalls: number
  activeInterventions: number
  shadowDisagreements: number
  fallbacks: number
  injectionBlocks: number
  completionFollowUps: number
  admissionOmissions: number
  patchFlags: number
  memoryFiltered: number
  estimatedCostUsd: number | null
  estimatedCostCny?: number | null
  byPoint: { point: string; total: number; activeInterventions: number; shadowDisagreements: number; fallbacks: number }[]
  recent: ConversationJudgmentItem[]
}

export interface ConversationCompletionSummary {
  ended: number
  verified: number
  unverified: number
  failed: number
  active: number
  stopped: number
  needsReconciliation: number
  firstPassVerified: number
  selfRepaired: number
  steered: number
  rigorTiers: { command: number; visual: number; path: number; unverified: number }
  nodeTotal: number
  nodeSucceeded: number
}

export interface ConversationObservatory {
  conversationId: string
  turns: number
  usage: UsageTotals
  modelRequests: number
  usageReports: number
  pricedReports: number
  estimatedCostUsd: number | null
  estimatedCostCny?: number | null
  usdToCnyRate?: number
  tools: { name: string; status: string; count: number }[]
  latestTask?: { id: string; tokenLimit?: number; requests: number; confirmed: number; reserved: number; uncertain: number }
  completion?: ConversationCompletionSummary
  turnMetrics?: ConversationTurnMetric[]
  judgments?: ConversationJudgmentSummary
}

export interface DesktopManagementApi {
  snapshot(input: { conversationId?: string }): Promise<ManagementSnapshot>
  conversationObservatory(input: { conversationId: string }): Promise<ConversationObservatory>
  recentDiagnostics(): Promise<ManagedDiagnostic[]>
  savePreferences(input: AgentPreferences): Promise<AgentPreferences>
  setWorkspaceAccess(input: { conversationId: string; access: WorkspaceAccess; toolApprovalMode?: ToolApprovalMode }): Promise<ConversationSummary>
  setProviderKey(input: { provider: ProviderId }): Promise<ManagedProvider>
  testProvider(input: { provider: ProviderId; model?: string }): Promise<ManagedProvider>
  removeProviderKey(input: { provider: ProviderId }): Promise<ManagedProvider>
  getJevStatus(): Promise<JevStatus>
  saveJevSettings(input: JevSettings): Promise<JevStatus>
  setJevKey(): Promise<JevStatus>
  removeJevKey(): Promise<JevStatus>
  testJevConnection(): Promise<JevStatus>
  deleteMemory(input: { conversationId: string; ids: string[] }): Promise<number>
  reconcile(input: { conversationId: string; taskId: string; operationId: string; disposition?: 'probe' | 'acknowledge' }): Promise<ManagedOperation>
  resolveTaskReconciliation?(input: { conversationId: string; taskId: string }): Promise<{ status: TaskStatus }>
}

type ManagementRequest<T extends string, I = object> = { schemaVersion: 1; type: T } & I
export type ManagementCommand =
  | ManagementRequest<'getJevStatus' | 'testJevConnection'>
  | ManagementRequest<'saveJevSettings', { settings: JevSettings }>
  | ManagementRequest<'managementSnapshot', { conversationId?: string }>
  | ManagementRequest<'conversationObservatory', { conversationId: string }>
  | ManagementRequest<'saveAgentPreferences', { preferences: AgentPreferences }>
  | ManagementRequest<'setWorkspaceAccess', { conversationId: string; access: WorkspaceAccess; expected: WorkspaceAccess;
    toolApprovalMode?: ToolApprovalMode; expectedApprovalMode?: ToolApprovalMode }>
  | ManagementRequest<'deleteConversationMemory', { conversationId: string; ids: string[] }>
  | ManagementRequest<'reconcileOperation', { conversationId: string; taskId: string; operationId: string; disposition?: 'probe' | 'acknowledge' }>
  | ManagementRequest<'resolveTaskReconciliation', { conversationId: string; taskId: string }>
  | ManagementRequest<'testProviderAccount', { provider: ProviderId; model?: string }>

/** Private transport between Electron Main and its own Host child. Never exposed in Preload. */
export type PrivateCredentialCommand =
  | ManagementRequest<'initializeProviderKeys', { credentials: Partial<Record<ProviderId, string | null>>; chatGpt?: ChatGptSession | null;
    jevKey?: string | null; judgeKeys?: JudgeCredentials; customProviders?: CustomProviderCredential[]; grok?: GrokCredential }>
  | ManagementRequest<'applyJevKey', { endpoint: string; key: string | null }>
  | ManagementRequest<'validateProviderKey', { provider: ProviderId; key: string }>
  | ManagementRequest<'applyProviderKey', { provider: ProviderId; key?: string | null }>
  | ManagementRequest<'applyChatGptSession', { session: ChatGptSession | null; quiesce: boolean }>
  | ManagementRequest<'applyCustomProvider', { id: string; config: CustomProviderCredential | null }>
  | ManagementRequest<'testCustomProvider', { id: string }>
  | ManagementRequest<'applyGrokSession', { session: GrokCredential | null; quiesce: boolean }>
  | ManagementRequest<'startGrokLogin' | 'pollGrokLogin' | 'cancelGrokLogin'>
  | ManagementRequest<'refreshGrokLogin', { credential: GrokCredential }>
