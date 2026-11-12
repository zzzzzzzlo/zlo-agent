import type { EndReason, ModelCatalogEntry, ModelRoute, TaskStatus, VerificationResult, WorkspaceAccess } from './domain.ts'
import type { ConversationSummary, UsageTotals } from './desktop.ts'
import type { ChatGptSession } from './chatgpt.ts'

export type ProviderId = 'deepseek' | 'openai' | 'anthropic' | 'google'
export type ManagedModel = ModelCatalogEntry
export interface ManagedProvider {
  id: ProviderId
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
  reconciliation?: { status: 'verified' | 'unresolved'; evidence: string; changedEntries?: number; truncated?: boolean }
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
  }[]
  agents: { id: string; nodeId: string; role: 'root' | 'team' | 'worker'; status: string; parentId?: string; route?: ModelRoute }[]
  operations: ManagedOperation[]
  usage: UsageTotals & { estimatedCostUsd?: number }
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
  providers: ManagedProvider[]
  account: { available: false; reason: string }
  tools: ManagedTool[]
  conversation?: ConversationSummary
  tasks: ManagedTask[]
  memory?: ManagedMemory
  diagnostics: ManagedDiagnostic[]
}

export interface ConversationObservatory {
  conversationId: string
  turns: number
  usage: UsageTotals
  modelRequests: number
  usageReports: number
  pricedReports: number
  estimatedCostUsd: number | null
  tools: { name: string; status: string; count: number }[]
  latestTask?: { id: string; tokenLimit: number; requests: number; confirmed: number; reserved: number; uncertain: number }
}

export interface DesktopManagementApi {
  snapshot(input: { conversationId?: string }): Promise<ManagementSnapshot>
  conversationObservatory(input: { conversationId: string }): Promise<ConversationObservatory>
  recentDiagnostics(): Promise<ManagedDiagnostic[]>
  savePreferences(input: AgentPreferences): Promise<AgentPreferences>
  setWorkspaceAccess(input: { conversationId: string; access: WorkspaceAccess }): Promise<ConversationSummary>
  setProviderKey(input: { provider: ProviderId }): Promise<ManagedProvider>
  testProvider(input: { provider: ProviderId; model?: string }): Promise<ManagedProvider>
  removeProviderKey(input: { provider: ProviderId }): Promise<ManagedProvider>
  deleteMemory(input: { conversationId: string; ids: string[] }): Promise<number>
  reconcile(input: { conversationId: string; taskId: string; operationId: string }): Promise<ManagedOperation>
}

type ManagementRequest<T extends string, I = object> = { schemaVersion: 1; type: T } & I
export type ManagementCommand =
  | ManagementRequest<'managementSnapshot', { conversationId?: string }>
  | ManagementRequest<'conversationObservatory', { conversationId: string }>
  | ManagementRequest<'saveAgentPreferences', { preferences: AgentPreferences }>
  | ManagementRequest<'setWorkspaceAccess', { conversationId: string; access: WorkspaceAccess; expected: WorkspaceAccess }>
  | ManagementRequest<'deleteConversationMemory', { conversationId: string; ids: string[] }>
  | ManagementRequest<'reconcileOperation', { conversationId: string; taskId: string; operationId: string }>
  | ManagementRequest<'testProviderAccount', { provider: ProviderId; model?: string }>

/** Private transport between Electron Main and its own Host child. Never exposed in Preload. */
export type PrivateCredentialCommand =
  | ManagementRequest<'initializeProviderKeys', { credentials: Partial<Record<ProviderId, string | null>>; chatGpt?: ChatGptSession | null }>
  | ManagementRequest<'validateProviderKey', { provider: ProviderId; key: string }>
  | ManagementRequest<'applyProviderKey', { provider: ProviderId; key?: string | null }>
  | ManagementRequest<'applyChatGptSession', { session: ChatGptSession | null; quiesce: boolean }>
