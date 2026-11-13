export const jevEndpoint = 'https://api.typesafe.ai/v1/systemone'
export const jevDefaultModel = 'jev-latest'

export const judgmentPoints = [
  { id: 'collaboration.mode', label: '协作模式', description: '在允许的选项中选择临时 Worker 或持久 Team。' },
  { id: 'delegation.worth', label: '委派价值', description: '判断交给子 Agent 是否有助于完成父任务。' },
  { id: 'model.task_fit', label: '模型适配', description: '在已经获准的模型中选择适合当前子任务的模型。' },
  { id: 'context.relevance', label: '上下文相关性', description: '在已获准召回的记忆中选择优先使用的内容。' },
  { id: 'handoff.sufficiency', label: '子 Agent 交付', description: '评估执行证据是否足以支持子任务交付。' },
  { id: 'task.replan', label: '任务重规划', description: '评估符合任务状态约束的重规划提议。' },
] as const

export type DecisionPoint = typeof judgmentPoints[number]['id']
export type JudgmentMode = 'off' | 'shadow' | 'active'
export const jevReasons = ['missing_key', 'timeout', 'busy', 'budget_exhausted', 'unauthorized',
  'rate_limited', 'unavailable', 'invalid_response', 'uncertain', 'configuration_changed', 'no_choice', 'invalid_model',
  'billing', 'cancelled'] as const
export type JevReason = typeof jevReasons[number]

export interface JevSettings {
  enabled: boolean
  model: string
  modes: Record<DecisionPoint, JudgmentMode>
}

export interface JevDecisionStatus {
  at: string
  mode: JudgmentMode
  reason?: JevReason
  model?: string
}

export interface JevStatus {
  settings: JevSettings
  credential: 'stored' | 'missing'
  connection: { state: 'untested' | 'connected' | 'degraded'; at?: string; reason?: JevReason; model?: string }
  decisions: Partial<Record<DecisionPoint, JevDecisionStatus>>
}

export function jevModel(value: unknown): value is string {
  return typeof value === 'string' && /^jev(?:[-_.][a-zA-Z0-9]+){1,12}$/u.test(value) && value.length <= 100
}

export function parseJevSettings(value: unknown): JevSettings | undefined {
  if (typeof value !== 'object' || !value || Array.isArray(value) || Object.keys(value).length !== 3) return
  const { enabled, model, modes } = value as Partial<JevSettings>
  if (typeof enabled !== 'boolean' || !jevModel(model) || typeof modes !== 'object' || !modes || Array.isArray(modes) ||
    Object.keys(modes).length !== judgmentPoints.length ||
    judgmentPoints.some(({ id }) => !Object.hasOwn(modes, id) || !['off', 'shadow', 'active'].includes(modes[id]))) return
  return { enabled, model, modes: { ...modes } }
}
