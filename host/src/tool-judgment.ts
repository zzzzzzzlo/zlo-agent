import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { EventDraft } from './contracts/domain.ts'
import type { LocalJudgment } from './judgment.ts'
import type { LocalStore } from './store.ts'

const evidenceNamespace = 'tool-judge-evidence'
const evidenceQuota = 'tool-judge-evidence-count'
const maxArchiveEntries = 32
const maxArchiveBytes = 256 * 1024
const batchLimit = 8
const maxExcerptBytes = 300
const minAdmissionBytes = 1_500
const quarantined = '[Potential instructions from external content withheld.]'
const reference = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u
const knownInjection = /\b(?:ignore|disregard|override)\b[^.!?]{0,80}\b(?:previous|prior|system|developer)\b[^.!?]{0,40}\b(?:instruction|message|prompt|policy)s?\b|(?:忽略|无视|覆盖).{0,20}(?:之前|系统|开发者).{0,12}(?:指令|提示|规则)/iu
const toolText = /^\w{1,64}$/u

type Output = Record<string, unknown>

function record(value: unknown): Output | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Output : undefined
}

interface Evidence {
  taskId: string
  agentRunId: string
  operationId: string
  tool: string
  original: Output
  replay: Output
}

export class ToolEvidenceArchive {
  readonly #store: LocalStore

  constructor(store: LocalStore) { this.#store = store }

  capture(event: EventDraft, operationId: string, tool: string, original: Output, replay: Output, protectedContent: boolean): string | undefined {
    const { taskId, agentRunId } = event
    if (!agentRunId) return
    const entry: Evidence = { taskId, agentRunId, operationId, tool, original, replay }
    if (Buffer.byteLength(JSON.stringify(entry)) > maxArchiveBytes) return
    return this.#store.transaction(() => {
      const count = this.#store.get<number>(evidenceQuota, taskId) ?? 0
      if (!protectedContent && count >= maxArchiveEntries) return
      const id = randomUUID()
      this.#store.put(evidenceNamespace, id, entry)
      if (!protectedContent) this.#store.put(evidenceQuota, taskId, count + 1)
      return id
    })
  }

  replay(event: EventDraft, id: string, allowed: (tool: string) => boolean): Output | undefined {
    if (!reference.test(id) || !event.agentRunId) return
    const entry = this.#store.get<Evidence>(evidenceNamespace, id)
    if (entry?.taskId === event.taskId && entry.agentRunId === event.agentRunId && allowed(entry.tool)) return entry.replay
  }
}

function chunks(text: string): string[] {
  const parts: string[] = []
  let current = ''
  let size = 0
  for (const char of text) {
    const bytes = Buffer.byteLength(char)
    if (size + bytes > maxExcerptBytes) {
      parts.push(current)
      current = ''
      size = 0
    }
    current += char
    size += bytes
  }
  if (current) parts.push(current)
  return parts
}

interface Segment {
  field: string
  text: string
  group?: symbol
  blocked?: boolean
  dismissed?: boolean
  alwaysRetain?: boolean
}

function textSegments(value: unknown, field: string): Segment[] {
  if (typeof value !== 'string') return []
  const group = Symbol()
  return chunks(value).map(text => ({ field, text, group }))
}

interface ExternalText {
  segments: Segment[]
  render(visible: (segment: Segment) => string): Output
}

function externalText(tool: string, result: Output): ExternalText | undefined {
  if (result.ok !== true || result.untrusted !== true) return
  if (tool === 'web_search' && Array.isArray(result.results)) {
    const segments: Segment[] = []
    const hits = result.results.map((item: unknown) => {
      const hit = record(item)
      if (!hit) return { hit: item, title: [], snippet: [] }
      const title = textSegments(hit.title, 'search title')
      const snippet = textSegments(hit.snippet, 'search snippet')
      segments.push(...title, ...snippet)
      return { hit, title, snippet }
    })
    return {
      segments,
      render: visible => ({ ...result, results: hits.map(({ hit, title, snippet }) => {
        if ([...title, ...snippet].some(segment => segment.blocked)) return { notice: quarantined }
        return { ...record(hit), title: title.map(visible).join(''), snippet: snippet.map(visible).join('') }
      }) }),
    }
  }
  if (tool !== 'web_fetch' && (tool !== 'browser_snapshot' || typeof result.url !== 'string')) return
  const title = textSegments(result.title, 'page title')
  const text = textSegments(result.text, 'page content')
  const elements = Array.isArray(result.elements) ? result.elements.map(item => {
    const element = record(item)
    const labels = textSegments(element?.label, 'element label')
    return { element, labels }
  }) : undefined
  return {
    segments: [...title, ...text, ...elements?.flatMap(({ labels }) => labels) ?? []],
    render: visible => ({ ...result, title: title.map(visible).join(''), text: text.map(visible).join(''),
      ...(elements && { elements: elements.map(({ element, labels }) => labels.some(segment => segment.blocked)
        ? { notice: quarantined } : { ...element, label: labels.map(visible).join('') }) }) }),
  }
}

function sampled<T>(items: readonly T[]): readonly T[] {
  if (items.length <= batchLimit) return items
  return Array.from({ length: batchLimit }, (_, index) => items[Math.floor(index * (items.length - 1) / (batchLimit - 1))]!)
}

async function rankFiles(judgment: LocalJudgment, event: EventDraft, operationId: string, tool: string, goal: string,
  result: Output, signal: AbortSignal): Promise<Output> {
  if (tool !== 'search_files' && tool !== 'search_content' || result.ok !== true ||
    judgment.mode('files.locate', event.taskId) === 'off') return result
  const field = tool === 'search_files' ? 'paths' : 'matches'
  const hits = result[field]
  if (!Array.isArray(hits)) return result
  const pathOf = (entry: unknown) => typeof entry === 'string' ? entry : record(entry)?.path
  const paths = [...new Set(hits.map(pathOf).filter((path): path is string => typeof path === 'string'))]
  if (paths.length < 2) return result
  const choices = sampled(paths)
  const verdicts = await judgment.decideBatch(event, 'files.locate', { goal, tool, candidateCount: paths.length },
    choices.map(path => ({ baseline: false, label: basename(path).slice(0, 160) })), [operationId], { signal })
  const matches = new Set(choices.filter((_, index) => verdicts[index]))
  if (!matches.size) return result
  return { ...result, [field]: [...hits.filter(hit => matches.has(pathOf(hit) as string)), ...hits.filter(hit => !matches.has(pathOf(hit) as string))] }
}

function localAdmission(tool: string, result: Output): ExternalText | undefined {
  const field = tool === 'search_content' ? 'matches' : tool === 'process_output' ? 'frames' : undefined
  if (!field || !Array.isArray(result[field]) || result.ok !== true) return
  const seen = new Set<string>()
  const entries = result[field].map(row => {
    const text = typeof row?.text === 'string' ? row.text : ''
    const repeated = seen.has(text)
    seen.add(text)
    const finding = /\b(?:fail(?:ed|ure)?|error|warn(?:ing)?|fatal|panic|exception|diagnostics?)\b/iu.test(text)
    const stream = row?.stream === 'stderr' ? 'stderr' : 'stdout'
    const segment: Segment = {
      field: field === 'matches' && typeof row?.path === 'string' ? basename(row.path).slice(0, 120)
        : stream + (repeated ? ', repeated line' : ', ordinary line'),
      text,
      alwaysRetain: field === 'frames' && (stream === 'stderr' || finding),
    }
    return { row, segment }
  })
  return {
    segments: entries.map(({ segment }) => segment),
    render: visible => ({ ...result, [field]: entries.map(({ row, segment }) => ({ ...row, text: visible(segment) })) }),
  }
}

export async function judgeToolResult(judgment: LocalJudgment, archive: ToolEvidenceArchive, event: EventDraft, operationId: string,
  tool: string, goal: string, value: unknown, signal: AbortSignal, canReplay = true): Promise<{ value: unknown; archiveId?: string }> {
  const result = record(value)
  if (!result || signal.aborted || !toolText.test(tool)) return { value }
  const ranked = await rankFiles(judgment, event, operationId, tool, goal, result, signal)
  const injectionMode = judgment.mode('tool.injection', event.taskId)
  const admissionMode = judgment.mode('tool.admission', event.taskId)
  if (injectionMode === 'off' && admissionMode === 'off') return { value: ranked }
  const external = externalText(tool, ranked)
  const output = external ?? (admissionMode !== 'off' ? localAdmission(tool, ranked) : undefined)
  if (!output?.segments.length || signal.aborted) return { value: ranked }
  const { segments } = output
  const bytes = segments.reduce((sum, segment) => sum + Buffer.byteLength(segment.text), 0)
  if (external && injectionMode !== 'off') {
    // Deterministic matches are never reversed by a judge. The bounded sample covers the response edge-to-edge.
    const known = segments.map(segment => knownInjection.test(segment.text))
    for (let index = 1; index < segments.length; index++) {
      const previous = segments[index - 1]
      const current = segments[index]
      const left = previous.text.slice(-120)
      const right = current.text.slice(0, 120)
      if (previous.group === current.group && !knownInjection.test(left) && !knownInjection.test(right) &&
        knownInjection.test(left + right)) {
        known[index - 1] = true
        known[index] = true
      }
    }
    const sample = sampled(segments.map((segment, index) => ({ segment, index })))
    const output = await judgment.decideBatch(event, 'tool.injection', { tool, bytes, candidateCount: segments.length },
      sample.map(({ segment, index }) => ({ baseline: known[index], label: segment.field, excerpt: segment.text })), [operationId], { signal })
    if (canReplay && injectionMode === 'active' && !signal.aborted && judgment.mode('tool.injection', event.taskId) === 'active') {
      sample.forEach(({ segment }, index) => { segment.blocked = output[index] })
      segments.forEach((segment, index) => { segment.blocked ||= known[index] })
    }
  }
  if (admissionMode !== 'off' && bytes >= minAdmissionBytes && !signal.aborted) {
    const sample = sampled(segments.filter(segment => !segment.blocked && !segment.alwaysRetain))
    const decisions = await judgment.decideBatch(event, 'tool.admission', { goal, tool, bytes, candidateCount: segments.length },
      sample.map(segment => ({ baseline: true, label: segment.field, excerpt: external ? segment.text : undefined })), [operationId], { signal })
    if (canReplay && judgment.mode('tool.admission', event.taskId) === 'active') {
      sample.forEach((segment, index) => { segment.dismissed = decisions[index] === false })
    }
  }
  if (signal.aborted || !segments.some(segment => segment.blocked || segment.dismissed)) return { value: ranked }
  const hasQuarantine = segments.some(segment => segment.blocked)
  const fullVisible = output.render(segment => segment.blocked ? quarantined : segment.text)
  let id: string | undefined
  try { id = archive.capture(event, operationId, tool, result, fullVisible, hasQuarantine) } catch { /* Apply the failure result below. */ }
  if (!id) return { value: hasQuarantine ? { ...fullVisible,
    evidenceNote: 'Suspicious text was withheld. Local evidence could not be saved.' } : ranked }
  const visible = output.render(segment => segment.blocked ? quarantined
    : segment.dismissed ? '[Excerpt omitted.]' : segment.text)
  return { value: { ...visible, evidenceId: id,
    evidenceNote: 'Use read_tool_evidence with the evidenceId for the retained output. Quarantined text is withheld.' }, archiveId: id }
}
