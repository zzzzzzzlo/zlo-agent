import { extname } from 'node:path'
import type { Page } from 'playwright-core'
import { previewImageLimits, toolImages } from './execution.ts'
import type { ToolImage } from './execution.ts'
import { localBrowserTimeout, localUrlFor, openLocalDocument } from './local-browser.ts'
import type { LocalBrowserDocument } from './local-browser.ts'
import { workspaceTarget } from './workspace.ts'
import type { CodingWorkspace, WorkspaceTool } from './workspace.ts'

const mimeTypes = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
  ['.gif', 'image/gif'], ['.svg', 'image/svg+xml'],
])

export async function captureViewportImage(page: Page, timeout = 3_000, animations: 'disabled' | 'allow' = 'allow'): Promise<ToolImage | undefined> {
  const viewport = page.viewportSize()
  if (!viewport || viewport.width > previewImageLimits.width || viewport.height > previewImageLimits.height) return
  let bytes = await page.screenshot({ type: 'jpeg', quality: 74, timeout, scale: 'css', animations })
  if (bytes.length > previewImageLimits.bytes) {
    bytes = await page.screenshot({ type: 'jpeg', quality: 48, timeout, scale: 'css', animations })
  }
  if (bytes.length <= previewImageLimits.bytes) return { bytes, ...viewport }
}

export function createImageTool(workspace: CodingWorkspace): WorkspaceTool {
  return {
    name: 'view_image', effect: 'read',
    description: 'Inspect a workspace-relative PNG, JPEG, WebP, GIF or SVG image. A vision-capable model receives an image. The result reports original and displayed dimensions for checking size or mapping coordinates.',
    parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: {
      path: { type: 'string', maxLength: 512 },
    } },
    async execute(_id, input, cancellation) {
      const path = workspaceTarget(input)
      const mime = path && mimeTypes.get(extname(path).toLowerCase())
      if (!path || !mime) return { ok: false, error: 'Expected a workspace PNG, JPEG, WebP, GIF or SVG path.' }
      const deadline = AbortSignal.timeout(localBrowserTimeout)
      const signal = cancellation ? AbortSignal.any([cancellation, deadline]) : deadline
      let document: LocalBrowserDocument | undefined
      const cancel = () => { void document?.close().catch(() => {}) }
      try {
        const imageBytes = await workspace.readImageAsset(path, signal)
        const entry = localUrlFor('view.html')
        const source = localUrlFor('image')
        const html = Buffer.from(`<!doctype html><meta charset="utf-8"><style>
          body{margin:0;background:white}img{display:block;width:100vw;height:100vh;object-fit:contain}
        </style><img src="${source}" alt="">`)
        document = await openLocalDocument(entry, new Map([
          [entry, { body: html, resource: 'document', mime: 'text/html; charset=utf-8' }],
          [source, { body: imageBytes, resource: 'image', mime }],
        ]), { width: 240, height: 160 }, signal, { javaScriptEnabled: false })
        signal.addEventListener('abort', cancel, { once: true })
        signal.throwIfAborted()
        const { width, height } = await document.page.locator('img').evaluate((img: HTMLImageElement) =>
          ({ width: img.naturalWidth, height: img.naturalHeight }))
        if (!width || !height) return { ok: false, error: 'The image could not be decoded.' }
        const scale = Math.min(1, previewImageLimits.width / width, previewImageLimits.height / height)
        await document.page.setViewportSize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) })
        const frame = await captureViewportImage(document.page)
        signal.throwIfAborted()
        if (!frame) return { ok: false, error: 'The image exceeds the visual feedback byte budget.' }
        return { ok: true, untrusted: true, path, mime, originalWidth: width, originalHeight: height,
          width: frame.width, height: frame.height, [toolImages]: [frame] }
      } catch {
        return { ok: false, error: signal.aborted ? 'Image inspection interrupted or timed out.' : 'Image is inaccessible or exceeds the workspace limits.' }
      } finally {
        signal.removeEventListener('abort', cancel)
        await document?.close()
      }
    },
  }
}
