import { randomUUID } from 'node:crypto'
import { constants, lstatSync, realpathSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import type { ExecutionTool } from './execution.ts'
import { projectCommands } from './contracts/domain.ts'
import type { ProjectCommand, VerificationCheck, VerificationResult, WorkspaceAccess } from './contracts/domain.ts'
import {
  containsPath, gitInvocation, parseProjectCommand, projectInvocation, redactProcessOutput,
  runWorkspaceProcess, UnknownProcessEffect,
} from './workspace-process.ts'

export { parseProjectCommand } from './workspace-process.ts'
export type { VerificationCheck, VerificationResult, WorkspaceAccess } from './contracts/domain.ts'
export type WorkspaceTool = ExecutionTool & { effect: 'read' | 'write' }
export interface Verifier {
  verify(check: VerificationCheck, signal?: AbortSignal, access?: WorkspaceAccess): Promise<VerificationResult>
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
const scriptExtensions = /\.(?:[cm]?[jt]s)$/iu
const activeWrites = new Set<string>()

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
  readonly #rootStat: Stats

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

  tools(role: 'root' | 'team' | 'worker', access: WorkspaceAccess = role === 'root' ? 'write' : 'read'): WorkspaceTool[] {
    const readTools = [
      this.#tool('list_directory', 'List allowed entries in one directory. Use "." for the workspace root.',
        'read', { path: pathProperty }, (args, signal) => this.#list(args.path, signal)),
      this.#tool('read_text_file', 'Read a workspace text file up to 128 KiB.',
        'read', { path: pathProperty }, async (args, signal) => {
          const { text } = await this.#read(segments(args.path), signal)
          return { ok: true, text }
        }),
    ]
    if (access === 'read') return readTools
    const writeTools = [
      ...readTools,
      this.#tool('create_text_file', 'Create a new workspace text file in an existing directory.',
        'write', { path: pathProperty, content: textProperty }, (args, signal) => this.#create(args, signal)),
      this.#tool('edit_text_file', 'Replace exactly one literal occurrence of oldText in a workspace text file.',
        'write', { path: pathProperty, oldText: textProperty, newText: textProperty },
        (args, signal) => this.#edit(args, signal)),
      this.#tool('create_directory', 'Create one new workspace directory under an existing directory.',
        'write', { path: pathProperty }, (args, signal) => this.#mkdir(args.path, signal)),
    ]
    if (access !== 'trusted') return writeTools
    return [
      ...writeTools,
      this.#tool('run_project_command',
        'Run an authorized local project script. For npm use a relative working directory or ".". For node_script use a relative script file and optional literal arguments.',
        'write', {
          command: { type: 'string', enum: [...projectCommands] },
          path: pathProperty,
          args: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 1024 } },
        }, async (input, signal) => {
          const result = await this.#project(input, signal)
          return result.state !== 'exited' ? { ok: false, error: 'Project command did not start' } : {
            ok: result.code === 0,
            exitCode: result.code,
            stdout: redactProcessOutput(result.stdout, result.truncated),
            stderr: redactProcessOutput(result.stderr, result.truncated),
            truncated: result.truncated,
          }
        }, ['args']),
      this.#tool('git_status', 'Inspect local Git status for allowed workspace paths.', 'write', {},
        async (_args, signal) => this.#gitStatus(signal)),
      this.#tool('git_diff', 'Inspect the unstaged or staged Git diff for a single allowed text file.',
        'write', { path: pathProperty, staged: { type: 'boolean' } }, async (args, signal) => {
          if (args.staged !== undefined && typeof args.staged !== 'boolean') throw new WorkspaceDenied('Invalid staged flag')
          const parts = segments(args.path)
          await this.#checkedPath(parts, false)
          return this.#gitText([
            'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all',
            ...(args.staged ? ['--cached'] : []), '--', parts.join('/'),
          ], signal)
        }, ['staged']),
      this.#tool('git_log', 'Inspect the last ten local commits as abbreviated IDs and dates.', 'write', {},
        async (_args, signal) => this.#gitText(['log', '-n', '10', '--format=%h%x09%cs'], signal)),
    ]
  }

  async verify(check: VerificationCheck, signal?: AbortSignal, access?: WorkspaceAccess): Promise<VerificationResult> {
    if (check.command) {
      if (access !== 'trusted') return { passed: false, evidence: 'workspace_command_not_authorized' }
      if (!this.#startWrite()) return { passed: false, evidence: 'workspace_write_active' }
      try {
        const result = await this.#project(check.command, signal)
        if (result.state !== 'exited') {
          return { passed: false, evidence: result.state === 'cancelled' ? 'verification_interrupted' : 'workspace_command_unavailable' }
        }
        return result.code === 0
          ? { passed: true, evidence: 'workspace_command_passed' }
          : { passed: false, evidence: 'workspace_command_failed' }
      } catch (error) {
        if (error instanceof WorkspaceDenied) return { passed: false, evidence: 'workspace_command_unavailable' }
        throw error
      } finally {
        activeWrites.delete(this.root)
      }
    }
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

  #startWrite(): boolean {
    for (const active of activeWrites) {
      if (containsPath(active, this.root) || containsPath(this.root, active)) return false
    }
    activeWrites.add(this.root)
    return true
  }

  #tool(
    name: string,
    description: string,
    effect: WorkspaceTool['effect'],
    properties: Record<string, unknown>,
    execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
    optional: string[] = [],
  ): WorkspaceTool {
    return {
      name,
      description,
      effect,
      parameters: {
        type: 'object', properties,
        required: Object.keys(properties).filter((key) => !optional.includes(key)),
        additionalProperties: false,
      },
      execute: async (_callId, input, signal) => {
        if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).some((key) => !Object.hasOwn(properties, key))) return { ok: false, error: 'Invalid arguments' }
        if (signal?.aborted) return { ok: false, error: 'Tool interrupted before execution' }
        if (effect === 'write' && !this.#startWrite()) return { ok: false, error: 'Another workspace write is active' }
        try {
          return await execute(input as Record<string, unknown>, signal)
        } catch (error) {
          if (error instanceof WorkspaceDenied) return { ok: false, error: error.message }
          if (effect === 'read') return { ok: false, error: 'Workspace entry unavailable' }
          if (error instanceof UnknownProcessEffect) throw error
          throw new Error('Workspace write could not be confirmed')
        } finally {
          if (effect === 'write') activeWrites.delete(this.root)
        }
      },
    }
  }

  async #mkdir(value: unknown, signal?: AbortSignal) {
    const parts = segments(value)
    const { path: parent } = await this.#checkedPath(parts.slice(0, -1), true)
    if (signal?.aborted) return { ok: false, error: 'Tool interrupted before writing' }
    try {
      await mkdir(join(parent, parts.at(-1)!))
      return { ok: true }
    } catch (error) {
      if (errorCode(error) === 'EEXIST') throw new WorkspaceDenied('Workspace entry already exists')
      throw error
    }
  }

  async #project(input: unknown, signal?: AbortSignal) {
    let command: ProjectCommand
    try {
      command = parseProjectCommand(input)
    } catch {
      throw new WorkspaceDenied('Invalid project command')
    }
    const node = command.command === 'node_script'
    const parts = segments(command.path, !node)
    if (node && !scriptExtensions.test(parts.at(-1)!)) throw new WorkspaceDenied('Expected a JavaScript or TypeScript file')
    const { path } = await this.#checkedPath(parts, !node)
    if (!node) await this.#checkedPath([...parts, 'package.json'], false)
    const invocation = projectInvocation(command, path, this.root)
    if (!invocation) throw new WorkspaceDenied('Project command executable is unavailable')
    return runWorkspaceProcess(invocation, node ? this.root : path, this.root, signal)
  }

  async #git(args: string[], signal?: AbortSignal) {
    await this.#checkedPath(['.git'], true)
    const invocation = gitInvocation(this.root, args)
    if (!invocation) throw new WorkspaceDenied('Local Git executable is unavailable')
    return runWorkspaceProcess(invocation, this.root, this.root, signal)
  }

  async #gitText(args: string[], signal?: AbortSignal) {
    const result = await this.#git(args, signal)
    if (result.state !== 'exited' || result.code !== 0) return { ok: false, error: 'Git inspection failed' }
    return { ok: true, stdout: redactProcessOutput(result.stdout, result.truncated), truncated: result.truncated }
  }

  async #gitStatus(signal?: AbortSignal) {
    const result = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--no-renames',
      '--ignore-submodules=all'], signal)
    if (result.state !== 'exited' || result.code !== 0) return { ok: false, error: 'Git inspection failed' }
    const entries = []
    for (const record of result.stdout.split('\0').slice(0, -1)) {
      const path = record.slice(3).replace(/\/$/u, '')
      if (workspaceTarget({ path }) !== undefined) {
        entries.push({ status: record.slice(0, 2), path: redactProcessOutput(path) })
      }
    }
    return { ok: true, entries, truncated: result.truncated }
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
