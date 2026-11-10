import type {
  ConversationEvent, ConversationHistory, ConversationSummary, ConversationTool, ConversationTurn, TaskStatus,
} from '../../../../shared/contracts/desktop.ts'
import type { EndReason } from '../../../../shared/contracts/domain.ts'
import type { Session, Turn } from '../../features/sessions/model'
import type { RunStatus, ToolUpdate } from './AgentAdapter'

export interface ProjectedSession extends Session {
  historyCursor: number
  turnOrder: ReadonlyMap<string, number>
}

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

export function toSession(conversation: ConversationSummary, previous?: ProjectedSession): ProjectedSession {
  return {
    id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt,
    turns: previous?.turns ?? [], loaded: previous?.loaded ?? false, nextBefore: previous?.nextBefore,
    latestStatus: conversation.latestStatus && taskStates[conversation.latestStatus],
    workspace: conversation.workspace, route: conversation.route, check: conversation.check,
    historyCursor: previous?.historyCursor ?? 0, turnOrder: previous?.turnOrder ?? new Map(),
  }
}

function mergePage(session: ProjectedSession, history: ConversationHistory, latest: boolean): ProjectedSession {
  const turns = new Map(session.turns.map((turn) => [turn.id, turn]))
  const order = new Map(session.turnOrder)
  // The Host's exclusive history cursor is the ordinal of the page's first turn.
  const first = history.nextBefore ?? 1
  history.turns.forEach((turn, index) => {
    if (latest || !turns.has(turn.taskId)) turns.set(turn.taskId, toTurn(turn))
    order.set(turn.taskId, first + index)
  })
  const ordered = [...turns.values()].sort((a, b) => order.get(a.id)! - order.get(b.id)!)
  let nextBefore = order.get(ordered.at(-1)?.id ?? '')
  for (let index = ordered.length - 2; nextBefore && index >= 0; index--) {
    if (order.get(ordered[index].id) !== nextBefore - 1) break
    nextBefore--
  }
  return { ...session, turns: ordered, turnOrder: order, nextBefore: nextBefore && nextBefore > 1 ? nextBefore : undefined }
}

export function applyHistory(history: ConversationHistory, previous?: ProjectedSession): ProjectedSession {
  if (previous && history.cursor < previous.historyCursor) return previous
  const session = toSession(history.conversation, previous)
  return mergePage({ ...session, loaded: true, historyCursor: history.cursor }, history, true)
}

export function applyOlderHistory(session: ProjectedSession, history: ConversationHistory): ProjectedSession {
  return mergePage(session, history, false)
}

export function applyHostEvent(session: ProjectedSession, event: ConversationEvent): ProjectedSession {
  if (event.seq <= session.historyCursor) return session
  const { payload } = event
  const next = { ...(payload.conversation ? toSession(payload.conversation, session) : session), historyCursor: event.seq }
  const taskId = event.taskId ?? payload.turn?.taskId
  if (!taskId) return next
  const current = next.turns.find(({ id }) => id === taskId)
  const isNewTurn = payload.conversation?.latestTaskId === taskId &&
    (event.type === 'task.created' || event.type === 'message.created')
  if (!current && !isNewTurn) return next
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
  const previousLatest = next.turns.at(-1)
  const turnOrder = current ? next.turnOrder
    : new Map(next.turnOrder).set(taskId, (previousLatest ? next.turnOrder.get(previousLatest.id)! : 0) + 1)
  return {
    ...next, turns: current ? next.turns.map((turn) => turn.id === taskId ? updated : turn) : [...next.turns, updated],
    turnOrder, latestStatus: !current || current === previousLatest ? updated.status : next.latestStatus,
  }
}

export function isBusy(status?: RunStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'verifying' || status === 'stopping'
}
