const resource = 'https://api.openai.com/v1/responses'

const allowedParameters = [
  'model', 'input', 'instructions', 'tools', 'tool_choice', 'reasoning', 'include',
] as const

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid Responses payload')
  }
  return value as Record<string, unknown>
}

export function chatGptResponsesPayload(value: unknown): unknown {
  const source = record(value)
  if (!Array.isArray(source.input) || typeof source.model !== 'string') throw new Error('Invalid Responses payload')
  const result: Record<string, unknown> = { store: false, stream: true }
  for (const field of allowedParameters) {
    if (source[field] !== undefined) result[field] = source[field]
  }
  result.input = source.input.map(item => {
    const entry = record(item)
    if (entry.type === 'tool_search_call' || entry.type === 'configuration_update') return undefined
    if (entry.type === 'tool_search_output') return { type: 'additional_tools', role: 'developer', tools: entry.tools }
    return entry.role === 'system' ? { ...entry, role: 'developer' } : entry
  }).filter(Boolean)
  if (Array.isArray(source.tools) && source.tools.length) {
    const tools = source.tools.map(record)
    if (tools.some(tool => tool.type !== 'function' && tool.type !== 'custom' && tool.type !== 'namespace')) {
      throw new Error('Unsupported tool type for the ChatGPT plan')
    }
    const namespaces = tools.filter(tool => tool.type === 'namespace')
    const local = tools.filter(tool => tool.type !== 'namespace')
    result.tools = local.length ? [...namespaces, { type: 'namespace', name: 'zlo_tools',
      description: 'Tools explicitly enabled by the local Zlo Agent Host', tools: local }] : namespaces
  }
  return result
}

export function chatGptResponsesFetch(fetcher: typeof fetch): typeof fetch {
  return (input, options) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url !== resource) throw new Error('ChatGPT plan requests must use the public Responses API')
    const headers = new Headers(options?.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.set('user-agent', 'Zlo-Agent')
    return fetcher(input, { ...options, headers, redirect: 'error' })
  }
}
