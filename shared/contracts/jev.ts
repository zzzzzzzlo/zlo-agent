export const jevEndpoint = 'https://api.typesafe.ai/v1/systemone'
export const jevDefaultModel = 'jev-latest'
export const openCodeJudgeEndpoint = 'https://opencode.ai/inference/systemone/v1/systemone'
export const openCodeFreeJudgeModel = 'jev-1.13-free'

export const judgeProviders = {
  typesafe: { label: 'TypeSafe', endpoint: jevEndpoint, model: jevDefaultModel },
  opencode: { label: 'OpenCode', endpoint: openCodeJudgeEndpoint, model: openCodeFreeJudgeModel },
  custom: { label: '自定义 System One', endpoint: '', model: '' },
} as const

export type JudgeProviderId = keyof typeof judgeProviders
export type JudgeCredentials = Record<string, string>

export function judgeEndpoint(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 500 || !/^https?:\/\/[^\s\\?#]+$/iu.test(value)) return
  const url = URL.canParse(value) ? new URL(value) : undefined
  if (!url || url.username || url.password || url.pathname === '/' ||
    (url.protocol !== 'https:' && !['127.0.0.1', '[::1]'].includes(url.hostname))) return
  return url.href
}

export function judgeKeyMatches(endpoint: string, key: unknown): key is string {
  return typeof key === 'string' && /^[\x21-\x7e]{8,2048}$/u.test(key) &&
    (!/^oc_sk_/u.test(key) || endpoint === openCodeJudgeEndpoint)
}

export function parseJudgeCredentials(value: unknown): JudgeCredentials | undefined {
  if (typeof value !== 'object' || !value || Array.isArray(value)) return
  const entries = Object.entries(value)
  if (entries.length > 24 || entries.some(([endpoint, key]) => judgeEndpoint(endpoint) !== endpoint || !judgeKeyMatches(endpoint, key))) return
  return Object.fromEntries(entries)
}

export const judgmentPoints = [
  { id: 'collaboration.mode', label: '协作模式', description: '在允许的选项中选择临时 Worker 或持久 Team。' },
  { id: 'delegation.worth', label: '委派价值', description: '判断交给子 Agent 是否有助于完成父任务。' },
  { id: 'model.task_fit', label: '模型适配', description: '在已经获准的模型中选择适合当前子任务的模型。' },
  { id: 'context.relevance', label: '上下文相关性', description: '在已获准召回的记忆中选择优先使用的内容。' },
  { id: 'handoff.sufficiency', label: '子 Agent 交付', description: '评估执行证据是否足以支持子任务交付。' },
  { id: 'task.replan', label: '任务重规划', description: '评估符合任务状态约束的重规划提议。' },
  { id: 'input.preflight', label: '任务预判', description: '判断当前请求的类型和复杂度，提供执行与推理提示。' },
  { id: 'task.frame', label: '任务意图', description: '标注新消息中的目标、约束或纠正，让执行模型正确理解追加说明。' },
  { id: 'skills.disclosure', label: '技能选择', description: '按任务相关性选择预先展示的技能，其他技能仍可按需读取。' },
  { id: 'tool.admission', label: '工具输出筛选', description: '减少进入模型上下文的长输出，保留原始记录和多模态结果。' },
  { id: 'memory.capture', label: '记忆写入', description: '从有证据的候选记录中选择值得保留的事实和经验。' },
  { id: 'files.locate', label: '文件定位', description: '按任务语义重新排序已有的授权文件搜索结果。' },
  { id: 'tool.injection', label: '注入识别', description: '识别外部文本里针对 Agent 的可疑指令，隔离模型输入中的对应片段。' },
  { id: 'turn.completion', label: '完成检查', description: '在结束前发现缺少的验证，并最多补充一次验证机会。' },
  { id: 'turn.continue', label: '提前结束检测', description: '检测仍有本地可执行工作时的提前结束，提供一次继续机会。' },
  { id: 'swarm.patch', label: '子 Agent 修改审查', description: '根据实际改动记录评估变更是否偏离委派范围，提醒父 Agent。' },
] as const

const phaseOneIds = judgmentPoints.slice(0, 6).map(({ id }) => id)
export const phaseTwoJudgmentPoints = judgmentPoints.slice(6)

export type DecisionPoint = typeof judgmentPoints[number]['id']
export type JudgmentMode = 'off' | 'shadow' | 'active'
export const jevReasons = ['missing_key', 'timeout', 'busy', 'budget_exhausted', 'unauthorized',
  'rate_limited', 'unavailable', 'invalid_response', 'uncertain', 'configuration_changed', 'no_choice', 'invalid_model',
  'billing', 'cancelled'] as const
export type JevReason = typeof jevReasons[number]

export interface JevSettings {
  enabled: boolean
  provider: JudgeProviderId
  endpoint: string
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
  return typeof value === 'string' && /^[a-zA-Z0-9_~][a-zA-Z0-9_./~:-]{0,99}$/u.test(value) &&
    !value.includes('://') && !/^(?:oc_sk_|sk[_-]|gh[pousr]_|github_pat_)/u.test(value)
}

export function parseJevSettings(value: unknown, legacy = false): JevSettings | undefined {
  if (typeof value !== 'object' || !value || Array.isArray(value)) return
  const old = legacy && Object.keys(value).length === 3
  if (!old && Object.keys(value).length !== 5) return
  const { enabled, model, modes, provider = old ? 'typesafe' : undefined, endpoint = old ? jevEndpoint : undefined } =
    value as Partial<JevSettings>
  if (typeof enabled !== 'boolean' || !jevModel(model) || typeof modes !== 'object' || !modes || Array.isArray(modes)) return
  const ids = Object.keys(modes)
  const required = legacy && ids.length === phaseOneIds.length ? phaseOneIds : judgmentPoints.map(({ id }) => id)
  if (ids.length !== required.length ||
    required.some(id => !Object.hasOwn(modes, id) || !['off', 'shadow', 'active'].includes(modes[id]))) return
  const url = judgeEndpoint(endpoint)
  if (typeof provider !== 'string' || !Object.hasOwn(judgeProviders, provider) || !url ||
    (provider !== 'custom' && url !== judgeProviders[provider].endpoint)) return
  return { enabled, provider, endpoint: url, model,
    modes: Object.fromEntries(judgmentPoints.map(({ id }) => [id, Object.hasOwn(modes, id) ? modes[id] : 'off'])) as JevSettings['modes'] }
}
