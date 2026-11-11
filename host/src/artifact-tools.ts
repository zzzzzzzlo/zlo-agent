import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, parse, relative, resolve } from 'node:path'
import { containsPath } from './workspace-process.ts'
import type { CodingWorkspace, WorkspaceTool } from './workspace.ts'

const maxBytes = 32 * 1024 * 1024

export function createArtifactTools(workspace: CodingWorkspace, privateDirectory: string): WorkspaceTool[] {
  return [{
    name: 'export_artifact',
    description: 'Export one existing workspace artifact through a native save dialog. The destination must be a new local file.',
    effect: 'write',
    policy: { rootOnly: true, minimumAccess: 'write', approval: 'export' },
    parameters: {
      type: 'object', additionalProperties: false, required: ['path'],
      properties: { path: { type: 'string', minLength: 1, maxLength: 512 } },
    },
    async execute(_callId, input, signal, context) {
      const destination = context?.destination
      const requested = input && typeof input === 'object' && 'path' in input ? input.path : undefined
      let target: string
      let data: Buffer
      try {
        if (signal?.aborted || !destination || !isAbsolute(destination) || destination.startsWith('\\\\') ||
          destination.startsWith('//') || /[\u0000-\u001f<>:"|?*]/u.test(destination.slice(parse(destination).root.length))) {
          return { ok: false, error: 'A local save destination is required' }
        }
        const source = await workspace.checkedTarget(requested, 'file')
        const directory = await realpath(dirname(destination))
        target = resolve(directory, basename(destination))
        if (relative(resolve(destination), target) || containsPath(workspace.root, target) ||
          containsPath(privateDirectory, target) || /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(basename(target))) {
          return { ok: false, error: 'The selected destination is not eligible for export' }
        }
        const original = await lstat(source)
        const file = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
        try {
          const opened = await file.stat()
          if (!opened.isFile() || opened.nlink !== 1 || opened.size > maxBytes ||
            opened.ino !== original.ino || opened.dev !== original.dev) return { ok: false, error: 'Artifact changed or exceeds the export limit' }
          data = Buffer.alloc(opened.size)
          for (let offset = 0; offset < data.length;) {
            signal?.throwIfAborted()
            const { bytesRead } = await file.read(data, offset, data.length - offset, offset)
            if (!bytesRead) return { ok: false, error: 'Artifact changed during export' }
            offset += bytesRead
          }
          const end = await file.stat()
          if (end.mtimeMs !== opened.mtimeMs || end.ctimeMs !== opened.ctimeMs || end.size !== opened.size ||
            await workspace.checkedTarget(requested, 'file') !== source) return { ok: false, error: 'Artifact changed during export' }
        } finally {
          await file.close()
        }
      } catch {
        return { ok: false, error: 'Artifact or save destination is unavailable' }
      }
      if (signal?.aborted) return { ok: false, error: 'Export was cancelled' }
      let output
      try {
        output = await open(target, 'wx', 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, error: 'The save file already exists' }
        throw error
      }
      try {
        await output.writeFile(data)
        await output.sync()
      } finally {
        await output.close()
      }
      return { ok: true, bytes: data.length }
    },
  }]
}
