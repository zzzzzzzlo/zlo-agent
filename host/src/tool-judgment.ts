import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { EventDraft } from './contracts/domain.ts'
import type { LocalJudgment } from './judgment.ts'
import type { LocalStore } from './store.ts'

const evidenceNamespace = 'tool-judge-evidence'
const evidenceQuota = 'tool-judge-evidence-count'
const maxArchiveEntries = 32
const maxArchiveBytes = 512 * 1024
const batchLimit = 8
const batchConcurrency = 4
const maxExcerptBytes = 1200
const seamOverlapChars = 120
const minAdmissionBytes = 1_500
const quarantined = '[Potential instructions from external content withheld.]'
const omittedNotice = '[Excerpt omitted.]'
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
  if (!text) return []
  const parts: string[] = []
  let start = 0
  while (start < text.length) {
    let end = start
    let bytes = 0
    let lastBreak = -1
    while (end < text.length) {
      const codePoint = text.codePointAt(end)!
      const char = String.fromCodePoint(codePoint)
      const charBytes = Buffer.byteLength(char)
      if (bytes + charBytes > maxExcerptBytes) break
      bytes += charBytes
      end += char.length
      if (/\s/u.test(char) && bytes >= maxExcerptBytes / 2) lastBreak = end
    }
    if (end === start) {
      const char = String.fromCodePoint(text.codePointAt(start)!)
      end = start + char.length
    } else if (end < text.length && lastBreak > start) {
      end = lastBreak
    }
    parts.push(text.slice(start, end))
    start = end
  }
  return parts
}

function chunkArray<T>(items: readonly T[], size = batchLimit): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size))
  return result
}

async function mapLimited<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (!items.length) return []
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const current = next++
      results[current] = await fn(items[current]!)
    }
  })
  await Promise.all(workers)
  return results
}

interface Segment {
  field: string
  text: string
  group?: symbol
  blocked?: boolean
  dismissed?: boolean
}

function textSegments(value: unknown, field: string): Segment[] {
  if (typeof value !== 'string' || !value) return []
  const group = Symbol()
  return chunks(value).map(text => ({ field, text, group }))
}

function joinVisible(parts: readonly Segment[], visible: (segment: Segment) => string): string {
  let out = ''
  let omitted = false
  for (const part of parts) {
    const piece = visible(part)
    if (piece === omittedNotice) {
      if (!omitted) {
        out += (out && !/\s$/u.test(out) ? '\n' : '') + piece
        omitted = true
      }
    } else {
      omitted = false
      out += piece
    }
  }
  return out
}

interface InspectableText {
  segments: Segment[]
  admissible: boolean
  render(visible: (segment: Segment) => string): Output
}

function inspectableText(tool: string, result: Output): InspectableText | undefined {
  const isExternalTool = tool === 'web_search' || tool === 'web_fetch' || tool === 'browser_snapshot'
  const untrustedExternal = result.ok === true && (isExternalTool || result.untrusted === true)
  if (tool === 'web_search' && untrustedExternal && Array.isArray(result.results)) {
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
      admissible: true,
      render: visible => ({ ...result, results: hits.map(({ hit, title, snippet }) => {
        if ([...title, ...snippet].some(segment => segment.blocked)) return { notice: quarantined }
        return { ...record(hit), title: joinVisible(title, visible), snippet: joinVisible(snippet, visible) }
      }) }),
    }
  }
  if (untrustedExternal && (tool === 'web_fetch' || tool === 'browser_snapshot' ||
    typeof result.text === 'string' || typeof result.title === 'string' || Array.isArray(result.elements))) {
    const title = textSegments(result.title, 'page title')
    const text = textSegments(result.text, 'page content')
    const elements = Array.isArray(result.elements) ? result.elements.map(item => {
      const element = record(item)
      const labels = textSegments(element?.label, 'element label')
      return { element, labels }
    }) : undefined
    return {
      segments: [...title, ...text, ...elements?.flatMap(({ labels }) => labels) ?? []],
      admissible: isExternalTool,
      render: visible => ({ ...result, title: joinVisible(title, visible), text: joinVisible(text, visible),
        ...(elements && { elements: elements.map(({ element, labels }) => labels.some(segment => segment.blocked)
          ? { notice: quarantined } : { ...element, label: joinVisible(labels, visible) }) }) }),
    }
  }
  if (tool === 'process_output' && result.ok === true && Array.isArray(result.frames)) {
    const segments: Segment[] = []
    const frames = result.frames.map(item => {
      const row = record(item)
      const stream = row?.stream === 'stderr' ? 'stderr' : 'stdout'
      const parts = row ? textSegments(row.text, stream) : []
      segments.push(...parts)
      return { row, item, parts }
    })
    return {
      segments,
      admissible: false,
      render: visible => ({ ...result, frames: frames.map(({ row, item, parts }) => row
        ? parts.some(part => part.blocked) ? { ...row, text: quarantined } : { ...row, text: parts.map(visible).join('') }
        : item) }),
    }
  }
  if (tool === 'run_project_command' && (typeof result.stdout === 'string' || typeof result.stderr === 'string')) {
    const stdout = textSegments(result.stdout, 'stdout')
    const stderr = textSegments(result.stderr, 'stderr')
    return {
      segments: [...stdout, ...stderr],
      admissible: false,
      render: visible => ({ ...result,
        ...(typeof result.stdout === 'string' && { stdout: stdout.map(visible).join('') }),
        ...(typeof result.stderr === 'string' && { stderr: stderr.map(visible).join('') }),
      }),
    }
  }
  return undefined
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
  const batches = chunkArray(paths, batchLimit)
  const batchVerdicts = await mapLimited(batches, batchConcurrency, batch =>
    judgment.decideBatch(event, 'files.locate', { goal, tool, candidateCount: paths.length },
      batch.map(path => ({ baseline: false, label: basename(path).slice(0, 160) })), [operationId], { signal }))
  const matches = new Set<string>()
  batches.forEach((batch, batchIndex) => {
    const verdicts = batchVerdicts[batchIndex] ?? []
    batch.forEach((path, itemIndex) => { if (verdicts[itemIndex]) matches.add(path) })
  })
  if (!matches.size) return result
  return { ...result, [field]: [...hits.filter(hit => matches.has(pathOf(hit) as string)), ...hits.filter(hit => !matches.has(pathOf(hit) as string))] }
}

export async function judgeToolResult(judgment: LocalJudgment, archive: ToolEvidenceArchive, event: EventDraft, operationId: string,
  tool: string, goal: string, value: unknown, signal: AbortSignal, canReplay = true): Promise<{ value: unknown; archiveId?: string }> {
  const result = record(value)
  if (!result || signal.aborted || !toolText.test(tool)) return { value }
  const ranked = await rankFiles(judgment, event, operationId, tool, goal, result, signal)
  const injectionMode = judgment.mode('tool.injection', event.taskId)
  const admissionMode = judgment.mode('tool.admission', event.taskId)
  const output = inspectableText(tool, ranked)
  if (!output?.segments.length || signal.aborted) return { value: ranked }
  const { segments, admissible } = output
  const bytes = segments.reduce((sum, segment) => sum + Buffer.byteLength(segment.text), 0)
  // Deterministic regex scan covers every segment and seam boundary across off/shadow/active modes.
  const known = segments.map(segment => knownInjection.test(segment.text))
  for (let index = 1; index < segments.length; index++) {
    const previous = segments[index - 1]!
    const current = segments[index]!
    const left = previous.text.slice(-seamOverlapChars)
    const right = current.text.slice(0, seamOverlapChars)
    if (previous.group === current.group && !knownInjection.test(left) && !knownInjection.test(right) &&
      knownInjection.test(left + right)) {
      known[index - 1] = true
      known[index] = true
    }
  }
  segments.forEach((segment, index) => { if (known[index]) segment.blocked = true })
  if (injectionMode !== 'off' && !signal.aborted) {
    const entries = segments.map((segment, index) => {
      const prev = index > 0 ? segments[index - 1] : undefined
      const excerpt = prev && prev.group === segment.group
        ? prev.text.slice(-seamOverlapChars) + segment.text
        : segment.text
      return { segment, baseline: known[index]!, label: segment.field, excerpt }
    })
    const batches = chunkArray(entries, batchLimit)
    const batchVerdicts = await mapLimited(batches, batchConcurrency, batch =>
      judgment.decideBatch(event, 'tool.injection', { tool, bytes, candidateCount: segments.length },
        batch.map(({ baseline, label, excerpt }) => ({ baseline, label, excerpt })), [operationId], { signal }))
    if (injectionMode === 'active' && !signal.aborted && judgment.mode('tool.injection', event.taskId) === 'active') {
      batches.forEach((batch, batchIndex) => {
        const verdicts = batchVerdicts[batchIndex] ?? []
        batch.forEach(({ segment }, itemIndex) => { if (verdicts[itemIndex]) segment.blocked = true })
      })
    }
  }
  if (admissible && admissionMode !== 'off' && bytes >= minAdmissionBytes && !signal.aborted) {
    const candidates = segments.filter(segment => !segment.blocked)
    const batches = chunkArray(candidates, batchLimit)
    const batchDecisions = await mapLimited(batches, batchConcurrency, batch =>
      judgment.decideBatch(event, 'tool.admission', { goal, tool, bytes, candidateCount: candidates.length },
        batch.map(segment => ({ baseline: true, label: segment.field, excerpt: segment.text })), [operationId], { signal }))
    if (canReplay && !signal.aborted && judgment.mode('tool.admission', event.taskId) === 'active') {
      batches.forEach((batch, batchIndex) => {
        const decisions = batchDecisions[batchIndex] ?? []
        batch.forEach((segment, itemIndex) => { segment.dismissed = decisions[itemIndex] === false })
      })
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
    : segment.dismissed ? omittedNotice : segment.text)
  return { value: { ...visible, evidenceId: id,
    evidenceNote: 'Use read_tool_evidence with the evidenceId for the retained output. Quarantined text is withheld.' }, archiveId: id }
}
