import type {
  ConversationEvent, ConversationHistory, ConversationSummary, ConversationTool, ConversationTurn, TaskStatus,
} from '../../../../host/src/contracts/desktop.ts'
import type { EndReason } from '../../../../host/src/contracts/domain.ts'
import type { Session, Turn } from '../../features/sessions/model'
import type { RunStatus, ToolUpdate } from './AgentAdapter'

const taskStates: Record<TaskStatus, RunStatus> = {
  ready: 'queued',
  running: 'running',
  verifying: 'verifying',
  succeeded: 'completed',
  failed: 'error',
  blocked: 'blocked',
  stop_requested: 'stopping',
  stopping: 'stopping',
  stopped: 'stopped',
  needs_reconciliation: 'reconciliation',
}

const toolStates: Record<ConversationTool['status'], [RunStatus, string]> = {
  running: ['running', '工具正在运行。'],
  succeeded: ['completed', 'Host 已确认工具执行结果。'],
  failed: ['error', '工具未能完成。'],
  interrupted: ['stopped', '工具随任务中断。'],
  unknown_effect: ['reconciliation', '工具结果尚未确认，请核对工作区。'],
}

const reasons: Partial<Record<EndReason, string>> = {
  process_interrupted: 'Host 上次意外退出。已保留执行记录。',
  model_error: '模型请求失败或路由不可用。',
  model_interrupted: '模型调用已中断。',
  runtime_error: 'Agent 运行异常。',
  verification_failed: '任务未通过验收检查。',
  unknown_effect: '工具操作结果不明确。请先核对工作区。',
  checkpoint_error: '会话检查点不可用。请先核对执行记录。',
  stop_timeout: '停止未在规定时间内完成，需要人工核对。',
  budget_exhausted: '任务达到本轮执行预算。',
}

function toTool(tool: ConversationTool): ToolUpdate {
  const [status, detail] = toolStates[tool.status]
  return { id: tool.id, name: tool.name, status, detail }
}

export function toTurn(turn: ConversationTurn): Turn {
  return {
    id: turn.taskId, taskRunId: turn.taskRunId, attemptId: turn.taskAttemptId,
    assistantId: turn.assistant.id, prompt: turn.user.text, response: turn.assistant.text,
    status: taskStates[turn.status], taskStatus: turn.status, error: turn.reason && reasons[turn.reason],
    instructions: turn.instructions, tools: turn.tools.map(toTool), usage: turn.usage, verification: turn.verification,
  }
}

export function toSession(conversation: ConversationSummary, previous?: Session): Session {
  return {
    id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt,
    turns: previous?.turns ?? [], loaded: previous?.loaded ?? false, nextBefore: previous?.nextBefore,
    latestStatus: conversation.latestStatus && taskStates[conversation.latestStatus],
    workspace: conversation.workspace, route: conversation.route, check: conversation.check,
  }
}

export function applyHistory(history: ConversationHistory, previous?: Session): Session {
  const session = toSession(history.conversation, previous)
  return {
    ...session, loaded: true, turns: history.turns.map(toTurn), nextBefore: history.nextBefore,
  }
}

export function applyHostEvent(session: Session, event: ConversationEvent): Session {
  const { payload } = event
  const next = payload.conversation ? toSession(payload.conversation, session) : session
  const taskId = event.taskId ?? payload.turn?.taskId
  if (!taskId) return next
  const current = next.turns.find(({ id }) => id === taskId)
  let updated = payload.turn ? toTurn(payload.turn) : current
  if (!updated) return next
  if (!payload.turn && event.type === 'message.delta' && payload.messageId === updated.assistantId && payload.delta) {
    updated = { ...updated, response: updated.response + payload.delta }
  }
  if (!payload.turn && payload.status) {
    updated = {
      ...updated, status: taskStates[payload.status], taskStatus: payload.status,
      error: payload.reason && reasons[payload.reason],
    }
  }
  if (!payload.turn && payload.usage) updated = { ...updated, usage: payload.usage }
  if (!payload.turn && payload.tool) {
    const tool = toTool(payload.tool)
    const present = updated.tools.some(({ id }) => id === tool.id)
    updated = {
      ...updated, tools: present ? updated.tools.map((item) => item.id === tool.id ? tool : item) : [...updated.tools, tool],
    }
  }
  return {
    ...next, turns: current ? next.turns.map((turn) => turn.id === taskId ? updated : turn) : [...next.turns, updated],
    latestStatus: !current || current === next.turns.at(-1) ? updated.status : next.latestStatus,
  }
}

export function isBusy(status?: RunStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'verifying' || status === 'stopping'
}
