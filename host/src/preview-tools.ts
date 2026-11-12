import type { Page } from 'playwright-core'
import { previewImageLimits, toolImages } from './execution.ts'
import type { ToolImage } from './execution.ts'
import { captureViewportImage, createImageTool } from './image-tools.ts'
import { boundedInteger, localBrowserTimeout, localErrorKind, localPageInput, localPageProperties, localPageTargets,
  openLocalDocument, readLocalPage } from './local-browser.ts'
import type { LocalBrowserDocument } from './local-browser.ts'
import type { CodingWorkspace, WorkspaceTool } from './workspace.ts'

const maxTime = 4_000

async function layoutAt(page: Page, timeMs: number) {
  return page.evaluate(time => {
    for (const animation of document.getAnimations()) {
      if (animation.playState !== 'idle' && animation.playState !== 'finished') {
        animation.pause()
        animation.currentTime = time
      }
    }
    for (const svg of document.querySelectorAll('svg')) {
      svg.pauseAnimations()
      svg.setCurrentTime(time / 1000)
    }
    const root = document.documentElement
    return { overflowX: Math.max(0, root.scrollWidth - innerWidth), overflowY: Math.max(0, root.scrollHeight - innerHeight),
      animations: document.getAnimations().length, svgAnimations: document.querySelectorAll('animate, animateMotion, animateTransform').length }
  }, timeMs)
}

export function createPreviewTools(workspace: CodingWorkspace): WorkspaceTool[] {
  const preview: WorkspaceTool = {
    name: 'preview_page', effect: 'read', policy: { targets: localPageTargets },
    description: 'Render a local HTML file in an isolated browser. Specify the exact workspace-relative CSS, JS, SVG, image and font assets it may load. No external network. Supply up to three animation sample times in milliseconds. A vision-capable model receives viewport images; other models receive only structural diagnostics.',
    parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: {
      ...localPageProperties,
      timesMs: { type: 'array', minItems: 1, maxItems: previewImageLimits.count, items: { type: 'integer', minimum: 0, maximum: maxTime } },
    } },
    async execute(_id, input, cancellation) {
      const selected = localPageInput(input)
      const times = (input as { timesMs?: unknown } | undefined)?.timesMs ?? [0]
      if (!selected || !Array.isArray(times) || times.length < 1 || times.length > previewImageLimits.count ||
        !times.every(time => boundedInteger(time, 0, maxTime)) || new Set(times).size !== times.length) {
        return { ok: false, error: 'Expected a workspace HTML path, bounded viewport and up to three distinct sample times.' }
      }
      const deadline = AbortSignal.timeout(localBrowserTimeout)
      const signal = cancellation ? AbortSignal.any([cancellation, deadline]) : deadline
      let document: LocalBrowserDocument | undefined
      const cancel = () => { void document?.close().catch(() => {}) }
      let stage = 'resources'
      try {
        const { entry, resources } = await readLocalPage(workspace, selected, signal)
        const started = performance.now()
        stage = 'navigation'
        document = await openLocalDocument(entry, resources, { width: selected.width, height: selected.height }, signal, { sampleTime: true })
        signal.addEventListener('abort', cancel, { once: true })
        const { page } = document
        const images: ToolImage[] = []
        const samples = []
        let previous = 0, timerErrors = 0
        const timerErrorKinds = new Set<string>()
        stage = 'sampling'
        for (const timeMs of [...times].sort((a, b) => a - b)) {
          signal.throwIfAborted()
          if (timeMs > previous) {
            try { await page.clock.runFor(timeMs - previous) } catch (error) {
              // Playwright surfaces exceptions from virtual timer callbacks as clock errors.
              const kind = error instanceof Error ? /^clock\.runFor: (\w+Error|Error):/u.exec(error.message)?.[1] : undefined
              if (!kind || !localErrorKind.test(kind) || signal.aborted) throw error
              timerErrors++
              timerErrorKinds.add(kind)
            }
          }
          previous = timeMs
          if (page.url() !== entry) throw new Error('Preview navigated away')
          const layout = await layoutAt(page, timeMs)
          const image = await captureViewportImage(page)
          const frame = image ? images.push(image) : undefined
          samples.push({ timeMs, frame, ...layout })
        }
        signal.throwIfAborted()
        const { runtimeErrors, errorKinds, ...diagnostics } = document.diagnostics()
        return { ok: true, untrusted: true, width: selected.width, height: selected.height, samples, renderMs: Math.round(performance.now() - started),
          ...diagnostics, runtimeErrors: runtimeErrors + timerErrors, errorKinds: [...new Set([...errorKinds, ...timerErrorKinds])], [toolImages]: images }
      } catch {
        return { ok: false, stage, error: signal.aborted ? 'Preview interrupted or timed out.' : `Preview failed during ${stage}.` }
      } finally {
        signal.removeEventListener('abort', cancel)
        await document?.close()
      }
    },
  }
  return [preview, createImageTool(workspace)]
}
