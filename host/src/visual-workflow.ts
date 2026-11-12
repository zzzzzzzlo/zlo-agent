import type { AgentEvent } from './contracts/domain.ts'
import type { RuntimeEvent } from './execution.ts'
import { workspaceTarget } from './workspace.ts'

const htmlPath = /\.html?$/iu
const visualPath = /\.(?:html?|css|svg|[cm]?js)$/iu
const record = (value: unknown) => value && typeof value === 'object' ? value as Record<string, unknown> : undefined
type Emit = (type: string, payload: Record<string, unknown>) => void

/** Project visual milestones from completed actions without controlling the Agent loop. */
export class VisualTelemetry {
  readonly #mode: 'quick' | 'high_quality'
  readonly #emit: Emit
  readonly #began = performance.now()
  #calls: number
  #draft: boolean
  #dirty = false
  #rendered = 0
  #sent = 0
  #active = false
  #round?: { number: number; requests: number; samples: number; tokens: number; modified: boolean }

  constructor(mode: 'fast' | 'quality', history: AgentEvent[], emit: Emit) {
    this.#mode = mode === 'fast' ? 'quick' : 'high_quality'
    this.#emit = emit
    this.#calls = history.filter(event => event.type === 'visual.preview_started').length
    this.#draft = history.some(event => event.type === 'visual.draft_ready')
  }

  beginPreview(): void {
    this.#finishRound()
    this.#active = true
    this.#round = { number: ++this.#calls, requests: 0, samples: 0, tokens: 0, modified: false }
    this.#emit('visual.preview_started', { mode: this.#mode, round: this.#calls })
  }

  previewResult(result: unknown): void {
    const value = record(result)
    if (value?.ok !== true || !Array.isArray(value.samples)) {
      this.#emit('visual.preview_finished', { round: this.#calls, rendered: false })
      return
    }
    this.#rendered++
    this.#dirty = false
    this.#emit('visual.preview_finished', { round: this.#calls, rendered: true, renderMs: value.renderMs,
      frames: value.samples.filter(sample => record(sample)?.frame !== undefined).length,
      samples: value.samples.length, runtimeErrors: value.runtimeErrors })
  }

  recordEdit(name: string, input: unknown, result: unknown): void {
    const output = record(result)
    if (output?.ok !== true) return
    const paths = name === 'apply_patch' && Array.isArray(output.changed) ? output.changed
      : name === 'create_text_file' || name === 'edit_text_file' ? [workspaceTarget(input)] : []
    const changed = paths.filter((path): path is string => typeof path === 'string' && visualPath.test(path))
    if (!changed.length) return
    this.#active = this.#active || changed.some(path => htmlPath.test(path))
    this.#dirty = true
    if (this.#round) this.#round.modified = true
    if (!this.#draft && this.#active) {
      this.#draft = true
      this.#emit('visual.draft_ready', { elapsedMs: Math.round(performance.now() - this.#began), mode: this.#mode })
    }
  }

  requestStarted() { if (this.#round) this.#round.requests++ }

  observe(event: RuntimeEvent) {
    if (event.type === 'visual.frames_sent') this.#sent += event.frames
    if (event.type === 'model.usage' && this.#round) {
      this.#round.samples++
      this.#round.tokens += event.input + event.output + event.cacheRead + event.cacheWrite
    }
  }

  finish() {
    this.#finishRound()
    if (this.#active) this.#emit('visual.loop_finished', { mode: this.#mode, elapsedMs: Math.round(performance.now() - this.#began),
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
