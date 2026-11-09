import { randomUUID } from 'node:crypto'
import { constants, lstatSync, realpathSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, open, opendir, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import type { ExecutionTool } from './execution.ts'

export type VerificationCheck = { path: string; contains?: string }
export type VerificationResult = { passed: boolean; evidence: string }
export type WorkspaceTool = ExecutionTool & { effect: 'read' | 'write' }
export interface Verifier {
  verify(check: VerificationCheck, signal?: AbortSignal): Promise<VerificationResult>
}

export function workspaceTarget(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || !('path' in input)) return undefined
  try {
    return segments(input.path).join('/')
  } catch {
    return undefined
  }
}

const maxBytes = 128 * 1024
const maxPathLength = 512
const maxEntries = 200
const maxScannedEntries = 1000
const forbiddenName = /^(?:node_modules|credentials?|secrets?|auth|id_(?:rsa|dsa|ecdsa|ed25519))(?:\.|$)/iu
const reservedName = /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[0-9¹²³])(?: *\.|$)/iu
const sensitiveExtension = /\.(?:key|pem|pfx|p12|ppk|sqlite|db)(?:[-.]|$)/iu
const invalidPathCharacter = /[\u0000-\u001f\u007f<>:"|?*]/u
const invalidTextCharacter = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
const pathProperty = { type: 'string', maxLength: maxPathLength }
const textProperty = { type: 'string', maxLength: maxBytes }

class WorkspaceDenied extends Error {}

function allowedSegment(name: string): boolean {
  return name.length > 0 && !name.startsWith('.') && !/[ .]$/u.test(name) &&
    !invalidPathCharacter.test(name) && !forbiddenName.test(name) &&
    !reservedName.test(name) && !sensitiveExtension.test(name)
}

function segments(value: unknown, allowRoot = false): string[] {
  if (allowRoot && value === '.') return []
  if (typeof value !== 'string' || value.length > maxPathLength) throw new WorkspaceDenied('Invalid relative path')
  const parts = value.split(/[\\/]/u)
  if (!parts.every(allowedSegment)) throw new WorkspaceDenied('Path denied by workspace policy')
  return parts
}

function textValue(value: unknown): string {
  if (typeof value !== 'string' || value.length > maxBytes || Buffer.byteLength(value) > maxBytes ||
    !value.isWellFormed() || invalidTextCharacter.test(value)) {
    throw new WorkspaceDenied('Expected bounded UTF-8 text')
  }
  return value
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function unchangedFile(left: Stats, right: Stats): boolean {
  return sameFile(left, right) && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function regularFile(stat: Stats): boolean {
  return stat.isFile() && stat.nlink === 1
}

async function writeAndSync(file: Awaited<ReturnType<typeof open>>, content: string): Promise<void> {
  try {
    await file.writeFile(content, 'utf8')
    await file.sync()
  } finally {
    await file.close()
  }
}

export class CodingWorkspace implements Verifier {
  readonly root: string
  #rootStat: Stats
  #writing = false

  constructor(root: string) {
    const selected = resolve(root)
    if (process.platform === 'win32' && selected.startsWith('\\\\')) {
      throw new Error('Select a local drive workspace directory')
    }
    const canonical = realpathSync.native(selected)
    const stat = lstatSync(selected)
    if (!stat.isDirectory() || relative(selected, canonical) !== '') {
      throw new Error('Select a real workspace directory')
    }
    this.root = canonical
    this.#rootStat = stat
  }

  tools(role: 'root' | 'worker'): WorkspaceTool[] {
    const readTools = [
      this.#tool('list_directory', 'List allowed entries in one directory. Use "." for the workspace root.',
        'read', { path: pathProperty }, (args, signal) => this.#list(args.path, signal)),
      this.#tool('read_text_file', 'Read a workspace text file up to 128 KiB.',
        'read', { path: pathProperty }, async (args, signal) => {
          const { text } = await this.#read(segments(args.path), signal)
          return { ok: true, text }
        }),
    ]
    if (role !== 'root') return readTools
    return [
      ...readTools,
      this.#tool('create_text_file', 'Create a new workspace text file in an existing directory.',
        'write', { path: pathProperty, content: textProperty }, (args, signal) => this.#create(args, signal)),
      this.#tool('edit_text_file', 'Replace exactly one literal occurrence of oldText in a workspace text file.',
        'write', { path: pathProperty, oldText: textProperty, newText: textProperty },
        (args, signal) => this.#edit(args, signal)),
    ]
  }

  async verify(check: VerificationCheck, signal?: AbortSignal): Promise<VerificationResult> {
    try {
      const { text } = await this.#read(segments(check.path), signal)
      if (check.contains !== undefined && !text.includes(textValue(check.contains))) {
        return { passed: false, evidence: 'workspace_file_missing_expected_text' }
      }
      return {
        passed: true,
        evidence: check.contains === undefined ? 'workspace_text_file_exists' : 'workspace_file_contains_expected_text',
      }
    } catch {
      return { passed: false, evidence: signal?.aborted ? 'verification_interrupted' : 'workspace_file_unavailable' }
    }
  }

  #tool(
    name: string,
    description: string,
    effect: WorkspaceTool['effect'],
    properties: Record<string, unknown>,
    execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
  ): WorkspaceTool {
    return {
      name,
      description,
      effect,
      parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
      execute: async (_callId, input, signal) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'Invalid arguments' }
        if (signal?.aborted) return { ok: false, error: 'Tool interrupted before execution' }
        if (effect === 'write' && this.#writing) return { ok: false, error: 'Another workspace write is active' }
        if (effect === 'write') this.#writing = true
        try {
          return await execute(input as Record<string, unknown>, signal)
        } catch (error) {
          if (error instanceof WorkspaceDenied) return { ok: false, error: error.message }
          if (effect === 'read') return { ok: false, error: 'Workspace entry unavailable' }
          throw new Error('Workspace write could not be confirmed')
        } finally {
          if (effect === 'write') this.#writing = false
        }
      },
    }
  }

  async #checkedPath(parts: string[], directory: boolean): Promise<{ path: string; stat: Stats }> {
    let path = this.root
    let stat: Stats
    try {
      stat = await lstat(path)
      if (!stat.isDirectory() || !sameFile(stat, this.#rootStat)) throw new WorkspaceDenied('Workspace changed')
      for (let index = 0; index < parts.length; index++) {
        path = join(path, parts[index])
        stat = await lstat(path)
        const validType = directory || index < parts.length - 1 ? stat.isDirectory() : regularFile(stat)
        if (!validType || relative(path, await realpath(path)) !== '') {
          throw new WorkspaceDenied('Workspace entry type or alias denied')
        }
      }
    } catch (error) {
      if (error instanceof WorkspaceDenied) throw error
      throw new WorkspaceDenied('Workspace entry unavailable')
    }
    return { path, stat }
  }

  async #list(value: unknown, signal?: AbortSignal): Promise<unknown> {
    const { path } = await this.#checkedPath(segments(value, true), true)
    const entries: { name: string; kind: 'file' | 'directory' }[] = []
    const directory = await opendir(path)
    let scanned = 0
    for await (const entry of directory) {
      signal?.throwIfAborted()
      if (++scanned > maxScannedEntries || entries.length >= maxEntries) {
        return { ok: true, entries, truncated: true }
      }
      if (allowedSegment(entry.name) && (entry.isDirectory() || entry.isFile())) {
        entries.push({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' })
      }
    }
    return { ok: true, entries, truncated: false }
  }

  async #read(parts: string[], signal?: AbortSignal): Promise<{ path: string; text: string; stat: Stats }> {
    const { path, stat } = await this.#checkedPath(parts, false)
    if (stat.size > maxBytes) throw new WorkspaceDenied('Workspace file exceeds 128 KiB')
    signal?.throwIfAborted()
    try {
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      try {
        const opened = await file.stat()
        if (!regularFile(opened) || !unchangedFile(stat, opened)) throw new WorkspaceDenied('Workspace file changed')
        const buffer = Buffer.allocUnsafe(opened.size + 1)
        let count = 0
        while (count < buffer.length) {
          signal?.throwIfAborted()
          const { bytesRead } = await file.read(buffer, count, buffer.length - count, count)
          if (bytesRead === 0) break
          count += bytesRead
        }
        if (count !== opened.size || !unchangedFile(opened, await file.stat())) {
          throw new WorkspaceDenied('Workspace file changed')
        }
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, count))
        return { path, text: textValue(text), stat: opened }
      } finally {
        await file.close()
      }
    } catch (error) {
      if (error instanceof WorkspaceDenied) throw error
      throw new WorkspaceDenied('Could not read a stable UTF-8 workspace file')
    }
  }

  async #create(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const parts = segments(args.path)
    const content = textValue(args.content)
    const { path: parent } = await this.#checkedPath(parts.slice(0, -1), true)
    const target = join(parent, parts.at(-1)!)
    if (signal?.aborted) return { ok: false, error: 'Tool interrupted before writing' }
    let file
    try {
      file = await open(target, 'wx')
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return { ok: false, error: 'Workspace entry already exists' }
      throw error
    }
    await writeAndSync(file, content)
    return { ok: true }
  }

  async #edit(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const parts = segments(args.path)
    const oldText = textValue(args.oldText)
    const newText = textValue(args.newText)
    if (!oldText) throw new WorkspaceDenied('oldText must be nonempty')
    const { path, text, stat } = await this.#read(parts, signal)
    const start = text.indexOf(oldText)
    if (start < 0 || text.indexOf(oldText, start + 1) >= 0) {
      throw new WorkspaceDenied('oldText must match exactly once')
    }
    const content = textValue(text.slice(0, start) + newText + text.slice(start + oldText.length))
    if (content === text) return { ok: true, changed: false }
    if (signal?.aborted) return { ok: false, error: 'Tool interrupted before writing' }
    const staged = join(dirname(path), `.zlo-edit-${randomUUID()}.tmp`)
    const file = await open(staged, 'wx', stat.mode & 0o777)
    let committed = false
    try {
      await writeAndSync(file, content)
      const current = await this.#read(parts, signal)
      if (!unchangedFile(stat, current.stat) || current.text !== text) {
        throw new WorkspaceDenied('Workspace file changed before edit')
      }
      if (signal?.aborted) return { ok: false, error: 'Tool interrupted before writing' }
      await rename(staged, path)
      committed = true
      return { ok: true, changed: true }
    } finally {
      if (!committed) await unlink(staged)
    }
  }
}
