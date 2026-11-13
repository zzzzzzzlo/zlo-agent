import type { ToolUpdate } from '../../integrations/agent/AgentAdapter.ts'

export type TranscriptBlock = { kind: 'message'; offset: number; text: string }
  | { kind: 'tools'; offset: number; tools: ToolUpdate[] }

export function transcriptBlocks(response: string, tools: readonly ToolUpdate[]): TranscriptBlock[] {
  const groups = new Map<number, ToolUpdate[]>()
  for (const tool of tools) {
    const offset = tool.assistantOffset ?? 0
    const boundary = Number.isSafeInteger(offset) && offset >= 0 ? Math.min(offset, response.length) : 0
    const group = groups.get(boundary)
    if (group) group.push(tool)
    else groups.set(boundary, [tool])
  }
  const blocks: TranscriptBlock[] = []
  let cursor = 0
  for (const [offset, group] of [...groups].sort((a, b) => a[0] - b[0])) {
    if (offset > cursor) blocks.push({ kind: 'message', offset: cursor, text: response.slice(cursor, offset) })
    blocks.push({ kind: 'tools', offset, tools: group })
    cursor = offset
  }
  if (cursor < response.length) blocks.push({ kind: 'message', offset: cursor, text: response.slice(cursor) })
  return blocks
}
