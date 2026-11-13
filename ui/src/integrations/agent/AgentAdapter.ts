export type RunStatus = 'queued' | 'running' | 'verifying' | 'stopping' | 'completed' |
  'cancelled' | 'stopped' | 'error' | 'blocked' | 'reconciliation'
export type TerminalStatus = 'completed' | 'cancelled' | 'error'

export interface RunKey {
  sessionId: string
  runId: string
}

export interface AgentMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface ToolUpdate {
  id: string
  name: string
  status: RunStatus
  detail: string
  assistantOffset?: number
}

export type AgentEvent = RunKey & (
  | { type: 'message.delta'; delta: string }
  | { type: 'tool.updated'; tool: ToolUpdate }
  | { type: 'run.ended'; status: TerminalStatus; error?: string }
)

export interface SendRequest extends RunKey {
  messages: readonly AgentMessage[]
}

export interface AgentAdapter {
  send(request: SendRequest): Promise<void>
  subscribe(listener: (event: AgentEvent) => void): () => void
  cancel(run: RunKey): Promise<void>
  steer(run: RunKey, text: string): Promise<void>
}
