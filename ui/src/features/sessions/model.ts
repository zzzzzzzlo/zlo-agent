import type { RunStatus, ToolUpdate } from '../../integrations/agent/AgentAdapter'
import type { ConversationMessage, ConversationSummary, ConversationTurn, TaskStatus, WorkspaceAccess } from '../../../../shared/contracts/desktop.ts'

export interface Turn {
  id: string
  prompt: string
  response: string
  tools: ToolUpdate[]
  status: RunStatus
  error?: string
  taskRunId?: string
  attemptId?: string
  assistantId?: string
  taskStatus?: TaskStatus
  instructions?: ConversationMessage[]
  usage?: ConversationTurn['usage']
  verification?: ConversationTurn['verification']
  nodes?: ConversationTurn['nodes']
}

export interface Session {
  id: string
  title: string
  updatedAt: number
  turns: Turn[]
  loaded?: boolean
  nextBefore?: number
  latestStatus?: RunStatus
  workspace?: string
  workspaceAccess?: WorkspaceAccess
  route?: ConversationSummary['route']
  pendingRoute?: ConversationSummary['pendingRoute']
  check?: ConversationSummary['check']
}

export const newTitle = '新会话'

export const workspaceAccessLabels: Record<WorkspaceAccess, string> = {
  read: '只读',
  write: '受控文件写入',
  trusted: '受信任项目执行',
}

export function demoSessions(): Session[] {
  const now = Date.now()
  const hour = 60 * 60 * 1000
  return [
    {
      id: 'demo-planning', title: '整理项目思路', updatedAt: now - hour,
      turns: [{
        id: 'plan-1', prompt: '帮我梳理一下个人助手项目的第一阶段。',
        response: '可以先把目标定为「完成一个可以每天打开使用的界面」。\n\n01　明确工作区布局，把会话、输入和设置放在顺手的位置。\n02　用模拟对话跑通发送、停止和工具状态。\n03　固定适配层契约，给未来的 Pi Agent 留出接入点。',
        status: 'completed', tools: [{ id: 'preview', name: '整理项目大纲', status: 'completed', detail: '从内置示例中提取了三条阶段目标。' }],
      }],
    },
    {
      id: 'demo-tools', title: '工具状态演示', updatedAt: now - 26 * hour,
      turns: [{
        id: 'tools-1', prompt: '演示一次工具状态变化。',
        response: '工具状态卡片可以展开查看详情。你也可以打开右上角的活动面板查看本轮运行。',
        status: 'completed', tools: [{ id: 'preview', name: '读取演示数据', status: 'completed', detail: '已载入内置示例数据。' }],
      }],
    },
    {
      id: 'demo-notes', title: '工作区使用笔记', updatedAt: now - 74 * hour,
      turns: [{
        id: 'notes-1', prompt: '有哪些常用快捷键？',
        response: 'Ctrl + N 新建会话，Ctrl + , 打开设置。\n\n在输入框内，Enter 发送，Shift + Enter 换行。中文输入法选字期间，Enter 用来确认候选词。',
        status: 'completed', tools: [],
      }],
    },
  ]
}
