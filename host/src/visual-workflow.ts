import type { AgentEvent } from './contracts/domain.ts'
import type { ModelRequest, RuntimeEvent } from './execution.ts'
import { workspaceTarget } from './workspace.ts'

type Mode = 'quick' | 'high_quality'
type Emit = (type: string, payload: Record<string, unknown>) => void
const budgets = {
  quick: { calls: 2, frames: 1, tokens: 64_000, ms: 75_000 },
  high_quality: { calls: 3, frames: 3, tokens: 150_000, ms: 150_000 },
} as const
const htmlPath = /\.html?$/iu
const visualFile = /\.(?:html?|css|svg|[cm]?js)$/iu
const fileChanges = new Set(['create_text_file', 'edit_text_file', 'move_file', 'rename_file', 'delete_file'])
const asRecord = (value: unknown) => value && typeof value === 'object' ? value as Record<string, unknown> : undefined

export function visualMode(goal: string): Mode | undefined {
  if (/不(?:用|要|必|做)预览|无需预览|(?:no|skip) (?:browser |visual )?preview/iu.test(goal)) return
  if (!/html|\bcss\b|\bsvg\b|\bcanvas\b|网页|页面|界面|动效|预览|preview_page|web page|landing page|animation|动画|visual layout/iu.test(goal)) return
  if (/快速模式|quick mode/iu.test(goal)) return 'quick'
  return /高质量模式|high[- ]quality mode|animation|动画/iu.test(goal) ? 'high_quality' : 'quick'
}

export class VisualWorkflow {
  readonly mode?: Mode
  readonly #emit: Emit
  readonly #expire: () => void
  readonly #began = performance.now()
  #calls: number
  #charged = 0
  #pending = 0
  #draft: boolean
  #draftPath?: string
  #lastPreview?: Record<string, unknown>
  #dirty = false
  #rendered = 0
  #sent = 0
  #deadline?: NodeJS.Timeout
  #round?: { number: number; requests: number; samples: number; tokens: number; modified: boolean; rendered: boolean }

  constructor(goal: string, history: AgentEvent[], emit: Emit, expire: () => void) {
    this.mode = visualMode(goal)
    this.#emit = emit
    this.#expire = expire
    this.#calls = history.filter(event => event.type === 'visual.preview_started').length
    this.#draft = history.some(event => event.type === 'visual.draft_ready')
    const first = history.find(event => event.type === 'visual.preview_started')
    if (first) {
      const reservations = new Map<string, number>()
      for (const event of history) {
        if (event.seq <= first.seq || event.taskNodeId !== first.taskNodeId || !event.correlationId) continue
        if (event.type === 'model.reserved' && typeof event.payload.estimatedTokens === 'number') reservations.set(event.correlationId, event.payload.estimatedTokens)
        else if (event.type === 'model.reservation_settled' && typeof event.payload.actualTokens === 'number' && reservations.has(event.correlationId)) {
          reservations.set(event.correlationId, event.payload.actualTokens)
        }
      }
      this.#charged = [...reservations.values()].reduce((total, tokens) => total + tokens, 0)
    }
  }

  get limits() { return budgets[this.mode ?? 'quick'] }

  instructions(): string {
    if (!this.mode) return ''
    return ` Visual coding workflow (${this.mode}): create a draft, then call preview_page on the HTML entry. List only its needed local assets. ` +
      (this.mode === 'high_quality' ? 'For animation sample three times across the motion cycle, e.g. 0, 500 and 1000 ms. ' : 'Capture a single representative frame. ') +
      'If images arrive, inspect subject, proportions, composition, contrast, clipping and occlusion. For motion, check continuity, joint movement and contacts across frames. ' +
      'Use simple keyframes for simple motion; use coordinated linkages or a suitable pose model if natural articulation matters. ' +
      'Preview immediately after the initial HTML draft, before code-only polishing. Keep the draft concise and make targeted edits without rewriting the entire page. ' +
      'For several fixes in one HTML file, use one contiguous edit_text_file replacement or batch non-overlapping edit_text_file calls in one response. apply_patch accepts only one replacement per file. ' +
      'Fix specific visible problems and preview the changed page. Stop early when it satisfies the request. ' +
      `The task permits ${this.limits.calls} previews, including the initial draft. Avoid delegation for straightforward visual work. ` +
      'Use the last allotted preview for validation and a concise final assessment. Report any remaining issue there. ' +
      'If visualInput is unavailable or no frame was attached, rely on runtime and layout diagnostics and say visual appearance was not inspected.'
  }

  feedback() {
    if (!this.mode && !this.#round) return undefined
    const quick = (this.mode ?? 'quick') === 'quick'
    const final = this.#round?.rendered === true && this.#calls === this.limits.calls
    const maxOutputTokens = final ? 2048 : this.#round ? (quick || this.#round.requests > 0 ? 4096 : 8192) : this.#draft ? 4096 : undefined
    return { quick, final, maxOutputTokens }
  }

  beginPreview(input: unknown): string | undefined {
    if (this.#calls >= this.limits.calls) return 'Visual preview budget exhausted.'
    const times = asRecord(input)?.timesMs
    if (Array.isArray(times) && times.length > this.limits.frames) return 'Quick mode permits one frame per preview.'
    this.#finishRound()
    this.#calls++
    this.#round = { number: this.#calls, requests: 0, samples: 0, tokens: 0, modified: false, rendered: false }
    this.#deadline ??= setTimeout(this.#expire, this.limits.ms)
    this.#emit('visual.preview_started', { mode: this.mode ?? 'quick', round: this.#calls })
    return undefined
  }

  acceptsEdit(name: string, input: unknown): boolean {
    if (!this.feedback()?.final) return true
    const args = asRecord(input), edits = args?.edits
    const paths = name === 'apply_patch' && Array.isArray(edits) ? edits.map(workspaceTarget)
      : fileChanges.has(name) ? [workspaceTarget(input), workspaceTarget({ path: args?.destination }), workspaceTarget({ path: args?.newName })] : []
    return !paths.some(path => path !== undefined && visualFile.test(path))
  }

  previewResult(input: unknown, result: unknown): void {
    const value = asRecord(result)
    if (!value?.ok || !Array.isArray(value.samples)) {
      this.#emit('visual.preview_finished', { round: this.#calls, rendered: false })
      return
    }
    const args = asRecord(input)!
    this.#lastPreview = { path: workspaceTarget(input), assets: args.assets, width: args.width, height: args.height, timesMs: args.timesMs }
    if (this.#round) this.#round.rendered = true
    this.#rendered++
    this.#dirty = false
    this.#emit('visual.preview_finished', { round: this.#calls, rendered: true, renderMs: value.renderMs,
      frames: value.samples.filter(sample => asRecord(sample)?.frame !== undefined).length,
      samples: value.samples.length, runtimeErrors: value.runtimeErrors })
  }

  recordEdit(name: string, input: unknown, result: unknown): void {
    const output = asRecord(result)
    if (!this.mode || output?.ok !== true) return
    const paths = name === 'apply_patch' && Array.isArray(output.changed) ? output.changed
      : name === 'create_text_file' || name === 'edit_text_file' ? [workspaceTarget(input)] : []
    const changed = paths.filter((path): path is string => typeof path === 'string' && visualFile.test(path))
    if (!changed.length) return
    this.#draftPath = changed.find(path => htmlPath.test(path)) ?? this.#draftPath
    this.#dirty = true
    if (this.#round) this.#round.modified = true
    if (!this.#draft && this.#draftPath) {
      this.#draft = true
      this.#emit('visual.draft_ready', { elapsedMs: Math.round(performance.now() - this.#began), mode: this.mode })
    }
  }

  reserve(request: ModelRequest): boolean {
    if (!this.#round) return true
    const tokens = request.estimatedInputTokens + request.maxOutputTokens
    if (this.#charged + this.#pending + tokens > this.limits.tokens) return false
    this.#pending += tokens
    this.#round.requests++
    return true
  }

  observe(event: RuntimeEvent) {
    if (event.type === 'visual.frames_sent') this.#sent += event.frames
    if (event.type === 'model.usage' && this.#round) {
      this.#round.samples++
      const actual = event.input + event.output + event.cacheRead + event.cacheWrite
      this.#round.tokens += actual
      this.#charged += actual
      this.#pending = 0
    }
  }

  followUp(): string | undefined {
    const args = this.#lastPreview ?? (this.#draftPath && { path: this.#draftPath, timesMs: [0, 500, 1000] })
    return this.mode === 'high_quality' && this.#dirty && args && this.#calls < this.limits.calls
      ? 'Before finishing, call preview_page to validate the current HTML. Reuse these settings if the entry and dependencies are unchanged: ' +
        JSON.stringify(args) + '. Report any remaining uncertainty.' : undefined
  }

  finish() {
    clearTimeout(this.#deadline)
    const active = Boolean(this.#round || this.#draftPath)
    this.#finishRound()
    if (active) this.#emit('visual.loop_finished', { mode: this.mode ?? 'quick', elapsedMs: Math.round(performance.now() - this.#began),
      renderedPreviews: this.#rendered, framesSent: this.#sent, editedAfterLastRender: this.#dirty })
  }

  #finishRound() {
    if (!this.#round) return
    const { number, requests, samples, tokens, modified } = this.#round
    this.#emit('visual.round_finished', { round: number, modified, requests, usageSamples: samples,
      tokens: samples ? tokens : undefined, usageComplete: requests === samples })
    this.#round = undefined
  }
}
