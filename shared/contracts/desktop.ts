import type { EndReason, ModelRoute, TaskStatus, VerificationCheck, VerificationResult, WorkspaceAccess } from './domain.ts'

export type { ModelRoute, TaskStatus, VerificationCheck, WorkspaceAccess } from './domain.ts'

export interface ConversationSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  archived: boolean
  workspace: string
  workspaceAccess?: WorkspaceAccess
  route?: ModelRoute
  pendingRoute?: ModelRoute
  check?: VerificationCheck
  piSessionId?: string
  latestTaskId?: string
  latestStatus?: TaskStatus
}

export interface ConversationMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number
}

export interface ConversationTool {
  id: string
  name: string
  status: 'running' | 'succeeded' | 'failed' | 'interrupted' | 'unknown_effect'
  agentRunId?: string
}

export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ConversationNode {
  id: string
  parentNodeId?: string
  role: 'team' | 'worker'
  status: 'running' | 'succeeded' | 'failed' | 'interrupted'
}

export interface ConversationTurn {
  taskId: string
  taskRunId: string
  taskAttemptId?: string
  status: TaskStatus
  reason?: EndReason
  verification?: VerificationResult
  user: ConversationMessage
  assistant: ConversationMessage
  instructions: ConversationMessage[]
  tools: ConversationTool[]
  usage: UsageTotals
  nodes?: ConversationNode[]
}

export interface ConversationHistory {
  conversation: ConversationSummary
  turns: ConversationTurn[]
  cursor: number
  nextBefore?: number
}

export interface CreateConversationInput {
  requestId: string
  title?: string
  workspace?: string
  workspaceAccess?: WorkspaceAccess
  route?: ModelRoute
  check?: VerificationCheck
}
export interface SendMessageInput { conversationId: string; requestId: string; text: string }
export interface SendMessageResult { taskId: string; taskRunId: string }
export interface ConversationAction { conversationId: string; taskId: string; requestId: string }
export interface SteerInput extends ConversationAction { text: string }
export interface RenameConversationInput { conversationId: string; requestId: string; title: string }
export interface SetConversationModelInput { conversationId: string; requestId: string; route: ModelRoute | null }
export interface ArchiveConversationInput { conversationId: string; requestId: string }
export interface HistoryInput { conversationId: string; before?: number }
export interface CursorInput { conversationId: string; after: number }
export interface ConversationRef { conversationId: string }
export interface ActionResult { accepted: boolean; status: TaskStatus }

export interface ConversationEvent {
  schemaVersion: 1
  eventId: string
  seq: number
  timestamp: number
  conversationId: string
  taskId?: string
  taskRunId?: string
  taskAttemptId?: string
  taskNodeId?: string
  agentRunId?: string
  parentAgentRunId?: string
  sessionId?: string
  type: string
  payload: {
    delta?: string
    messageId?: string
    conversation?: ConversationSummary
    turn?: ConversationTurn
    status?: TaskStatus
    tool?: ConversationTool
    usage?: UsageTotals
    node?: ConversationNode
    reason?: EndReason
    agentRole?: 'root' | 'team' | 'worker'
    agentStatus?: 'active' | 'completed' | 'interrupted' | 'failed'
  }
}

export type HostMode = 'pi' | 'fake' | 'faux'
export interface DesktopHostStatus {
  state: 'starting' | 'ready' | 'offline'
  mode: HostMode
  message?: string
}

export type DesktopErrorCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' |
  'MODEL_UNAVAILABLE' | 'INTERNAL' | 'HOST_UNAVAILABLE'

export interface DesktopHostApi {
  getStatus(): Promise<DesktopHostStatus>
  restart(): Promise<DesktopHostStatus>
  chooseWorkspace(): Promise<string | null>
  createConversation(input: CreateConversationInput): Promise<ConversationSummary>
  listConversations(): Promise<ConversationSummary[]>
  getConversation(input: ConversationRef): Promise<ConversationSummary>
  getHistory(input: HistoryInput): Promise<ConversationHistory>
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>
  steerConversation(input: SteerInput): Promise<{ accepted: true }>
  stopConversation(input: ConversationAction): Promise<ActionResult>
  resumeConversation(input: ConversationAction): Promise<ActionResult>
  renameConversation(input: RenameConversationInput): Promise<ConversationSummary>
  setConversationModel(input: SetConversationModelInput): Promise<ConversationSummary>
  archiveConversation(input: ArchiveConversationInput): Promise<ConversationSummary>
  watchConversation(input: CursorInput): Promise<true>
  unwatchConversation(input: ConversationRef): Promise<true>
  onEvent(listener: (event: ConversationEvent) => void): () => void
  onStatus(listener: (status: DesktopHostStatus) => void): () => void
}

type Request<T extends string, I = object> = { schemaVersion: 1; type: T; commandId?: string } & I
export type DesktopCommand =
  | Request<'createConversation', CreateConversationInput>
  | Request<'listConversations'>
  | Request<'getConversation', ConversationRef>
  | Request<'getConversationHistory', HistoryInput>
  | Request<'sendMessage', SendMessageInput>
  | Request<'steerConversation', SteerInput>
  | Request<'stopConversation' | 'resumeConversation', ConversationAction>
  | Request<'renameConversation', RenameConversationInput>
  | Request<'setConversationModel', SetConversationModelInput>
  | Request<'archiveConversation', ArchiveConversationInput>
  | Request<'subscribeConversation', CursorInput>
  | Request<'unsubscribeConversation', ConversationRef>
