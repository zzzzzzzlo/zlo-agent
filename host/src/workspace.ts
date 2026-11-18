import { randomUUID } from 'node:crypto'
import { constants, lstatSync, realpathSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import type { ExecutionTool } from './execution.ts'
import type { ApprovalKind } from '../../shared/contracts/tool-approval.ts'
import { projectCommands } from './contracts/domain.ts'
import type { ProjectCommand, VerificationCheck, VerificationResult, WorkspaceAccess } from './contracts/domain.ts'
import {
  containsPath, gitInvocation, parseProjectCommand, projectInvocation, redactProcessOutput,
  runWorkspaceProcess, UnknownProcessEffect,
} from './workspace-process.ts'

import { allowedSegment, maxPathLength, segments, withinScopePath, WorkspaceDenied, workspaceTarget } from './workspace-path.ts'

export { workspaceTarget } from './workspace-path.ts'
export { parseProjectCommand } from './workspace-process.ts'
export type { VerificationCheck, VerificationResult, WorkspaceAccess } from './contracts/domain.ts'
export interface ToolPolicy {
  minimumAccess?: WorkspaceAccess
  minimumAccessFor?(input: unknown): WorkspaceAccess | undefined
  effectFor?(input: unknown): 'read' | 'write'
  delegation?: 'explicit'
  wholeWorkspace?: boolean
  selectsTaskWorkspace?(input: unknown): boolean
  approval?: ApprovalKind
  approvalFor?(input: unknown): ApprovalKind | undefined
  publicRead?(input: unknown): boolean
  targets?(input: unknown): string[]
  deferred?: boolean
  whileActive?: boolean
}

export interface DeferredToolOperation {
  completion: Promise<'succeeded' | 'failed' | 'interrupted' | 'unknown_effect'>
  stop(): Promise<void>
  pid?: number
}

export interface ToolInvocationContext {
  taskId: string
  agentRunId: string
  scopePath?: string
  destination?: string
  defer(operation: DeferredToolOperation): void
  onCleanup(cleanup: () => Promise<void>): void
}

export interface WorkspaceTool extends ExecutionTool {
  effect: 'read' | 'write'
  policy?: ToolPolicy
  execute(callId: string, input: unknown, signal?: AbortSignal, context?: ToolInvocationContext): Promise<unknown>
}
export interface Verifier {
  verify(check: VerificationCheck, signal?: AbortSignal, access?: WorkspaceAccess): Promise<VerificationResult>
}

const maxBytes = 128 * 1024
const maxStreamBytes = 32 * 1024 * 1024
const readChunkBytes = 64 * 1024
const maxReadLines = 200
const maxStartLine = 10_000_000
const maxGitLogLimit = 50
const maxEntries = 200
const maxScannedEntries = 1000
const invalidTextCharacter = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
const pathProperty = { type: 'string', maxLength: maxPathLength }
const textProperty = { type: 'string', maxLength: maxBytes }
const scriptExtensions = /\.(?:[cm]?[jt]s)$/iu

export interface WorkspaceLease {
  readonly root: string
  readonly mode: 'read' | 'write'
  readonly ownerId: string
  readonly suspended: boolean
  release(): void
  suspend(): boolean
  resume(signal?: AbortSignal): Promise<void>
  suspendAndRun<T>(fn: () => Promise<T>, resumeSignal?: AbortSignal): Promise<T>
}

interface LeaseWaiter {
  seq: number
  root: string
  mode: 'read' | 'write'
  ownerKey: string
  cancelled: boolean
  resolve: (lease: WorkspaceLease) => void
  reject: (error: unknown) => void
  cleanup?: () => void
}

interface RootLeaseState {
  readers: Map<string, number>
  writer?: { ownerKey: string; refs: number }
}

class WorkspaceLeaseManager {
  readonly #states = new Map<string, RootLeaseState>()
  readonly #waiters: LeaseWaiter[] = []
  #nextSeq = 1

  #state(root: string): RootLeaseState {
    let entry = this.#states.get(root)
    if (!entry) {
      entry = { readers: new Map() }
      this.#states.set(root, entry)
    }
    return entry
  }

  #cleanupState(root: string): void {
    const entry = this.#states.get(root)
    if (entry && !entry.writer && entry.readers.size === 0) {
      this.#states.delete(root)
    }
  }

  #overlappingRoots(root: string): [string, RootLeaseState][] {
    const matches: [string, RootLeaseState][] = []
    for (const [otherRoot, state] of this.#states) {
      if (otherRoot === root || containsPath(otherRoot, root) || containsPath(root, otherRoot)) {
        matches.push([otherRoot, state])
      }
    }
    return matches
  }

  #hasWaitingWriterBefore(root: string, beforeSeq: number, ownerKey: string): boolean {
    return this.#waiters.some(waiter =>
      !waiter.cancelled &&
      waiter.seq < beforeSeq &&
      waiter.mode === 'write' &&
      waiter.ownerKey !== ownerKey &&
      (waiter.root === root || containsPath(waiter.root, root) || containsPath(root, waiter.root)),
    )
  }

  #canGrantRead(root: string, ownerKey: string, waiterSeq?: number): boolean {
    const ownState = this.#states.get(root)
    // Active non-suspended owners can re-enter to execute read tools without deadlocking behind queued writers.
    if (ownState?.writer?.ownerKey === ownerKey || (ownState?.readers.get(ownerKey) ?? 0) > 0) {
      return true
    }
    for (const [, state] of this.#overlappingRoots(root)) {
      if (state.writer && state.writer.ownerKey !== ownerKey) return false
    }
    if (waiterSeq !== undefined) {
      if (this.#hasWaitingWriterBefore(root, waiterSeq, ownerKey)) return false
    } else if (this.#waiters.some(w => !w.cancelled && w.mode === 'write' && w.ownerKey !== ownerKey &&
      (w.root === root || containsPath(w.root, root) || containsPath(root, w.root)))) {
      return false
    }
    return true
  }

  #canGrantWrite(root: string, ownerKey: string): boolean {
    for (const [, state] of this.#overlappingRoots(root)) {
      if (state.writer && state.writer.ownerKey !== ownerKey) return false
      for (const readerKey of state.readers.keys()) {
        if (readerKey !== ownerKey) return false
      }
    }
    const ownState = this.#states.get(root)
    if (ownState?.readers.size && !ownState.writer) {
      // Do not allow upgrading own read lease while holding read refs on same owner key if others wait.
      if (ownState.readers.has(ownerKey)) return false
    }
    return true
  }

  #addHold(root: string, mode: 'read' | 'write', ownerKey: string): void {
    const state = this.#state(root)
    if (mode === 'write') {
      if (state.writer && state.writer.ownerKey === ownerKey) {
        state.writer.refs++
      } else {
        state.writer = { ownerKey, refs: 1 }
      }
      return
    }
    if (state.writer?.ownerKey === ownerKey) {
      state.writer.refs++
      return
    }
    state.readers.set(ownerKey, (state.readers.get(ownerKey) ?? 0) + 1)
  }

  #removeHold(root: string, mode: 'read' | 'write', ownerKey: string): void {
    const state = this.#states.get(root)
    if (!state) return
    if (mode === 'write' || state.writer?.ownerKey === ownerKey) {
      if (state.writer && state.writer.ownerKey === ownerKey) {
        state.writer.refs--
        if (state.writer.refs <= 0) state.writer = undefined
      }
    } else {
      const prev = state.readers.get(ownerKey) ?? 0
      if (prev <= 1) state.readers.delete(ownerKey)
      else state.readers.set(ownerKey, prev - 1)
    }
    this.#cleanupState(root)
  }

  #makeLease(root: string, initialMode: 'read' | 'write', ownerKey: string): WorkspaceLease {
    const manager = this
    let held = true
    let suspended = false
    const handle: WorkspaceLease = {
      root,
      mode: initialMode,
      ownerId: ownerKey,
      get suspended() { return suspended },
      release() {
        if (!held) return
        held = false
        if (!suspended) {
          manager.#removeHold(root, initialMode, ownerKey)
          manager.#drainWaiters()
        } else {
          suspended = false
        }
      },
      suspend() {
        if (!held || suspended) return false
        suspended = true
        manager.#removeHold(root, initialMode, ownerKey)
        manager.#drainWaiters()
        return true
      },
      async resume(signal?: AbortSignal) {
        if (!held || !suspended) return
        await manager.#acquireRawHold(root, initialMode, ownerKey, signal)
        if (!held) {
          manager.#removeHold(root, initialMode, ownerKey)
          manager.#drainWaiters()
          return
        }
        suspended = false
      },
      async suspendAndRun<T>(fn: () => Promise<T>, resumeSignal?: AbortSignal): Promise<T> {
        const didSuspend = handle.suspend()
        try {
          return await fn()
        } finally {
          if (didSuspend && held && !resumeSignal?.aborted) {
            try {
              await handle.resume(resumeSignal)
            } catch {
              // If aborted while resuming, leave release() to clean up.
            }
          }
        }
      },
    }
    return handle
  }

  #drainWaiters(): void {
    if (!this.#waiters.length) return
    for (let i = 0; i < this.#waiters.length;) {
      const waiter = this.#waiters[i]!
      if (waiter.cancelled) {
        this.#waiters.splice(i, 1)
        continue
      }
      const canGrant = waiter.mode === 'read'
        ? this.#canGrantRead(waiter.root, waiter.ownerKey, waiter.seq)
        : this.#canGrantWrite(waiter.root, waiter.ownerKey)
      if (!canGrant) {
        i++
        continue
      }
      this.#waiters.splice(i, 1)
      waiter.cleanup?.()
      this.#addHold(waiter.root, waiter.mode, waiter.ownerKey)
      waiter.resolve(this.#makeLease(waiter.root, waiter.mode, waiter.ownerKey))
    }
  }

  tryAcquire(root: string, mode: 'read' | 'write', ownerId?: string): (() => void) | undefined {
    const ownerKey = ownerId ?? ('sync:' + randomUUID())
    if (mode === 'write') {
      if (!this.#canGrantWrite(root, ownerKey)) return undefined
      if (ownerId && this.#hasWaitingWriterBefore(root, Infinity, ownerKey) &&
        this.#states.get(root)?.writer?.ownerKey !== ownerKey) {
        return undefined
      }
    } else {
      const ownState = this.#states.get(root)
      const isReentering = ownState?.writer?.ownerKey === ownerKey || (ownState?.readers.get(ownerKey) ?? 0) > 0
      if (!isReentering && !this.#canGrantRead(root, ownerKey)) return undefined
    }
    this.#addHold(root, mode, ownerKey)
    let released = false
    return () => {
      if (released) return
      released = true
      this.#removeHold(root, mode, ownerKey)
      this.#drainWaiters()
    }
  }

  acquireAsync(root: string, mode: 'read' | 'write', ownerId?: string, signal?: AbortSignal): Promise<WorkspaceLease> {
    const ownerKey = ownerId ?? ('lease:' + randomUUID())
    return this.#acquireRawHold(root, mode, ownerKey, signal).then(() => this.#makeLease(root, mode, ownerKey))
  }

  #acquireRawHold(root: string, mode: 'read' | 'write', ownerKey: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new DOMException('Workspace lease acquisition aborted', 'AbortError'))
    }
    const seq = this.#nextSeq++
    const canGrant = mode === 'read'
      ? this.#canGrantRead(root, ownerKey, seq)
      : this.#canGrantWrite(root, ownerKey)
    if (canGrant) {
      this.#addHold(root, mode, ownerKey)
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: LeaseWaiter = {
        seq, root, mode, ownerKey, cancelled: false,
        resolve: () => resolve(),
        reject,
      }
      if (signal) {
        const onAbort = () => {
          waiter.cancelled = true
          const idx = this.#waiters.indexOf(waiter)
          if (idx >= 0) this.#waiters.splice(idx, 1)
          this.#drainWaiters()
          reject(new DOMException('Workspace lease acquisition aborted', 'AbortError'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        waiter.cleanup = () => signal.removeEventListener('abort', onAbort)
      }
      this.#waiters.push(waiter)
    })
  }

  snapshot(root: string): { readers: string[]; writer?: string; waitingCount: number } {
    const readers: string[] = []
    let writer: string | undefined
    for (const [, state] of this.#overlappingRoots(root)) {
      if (state.writer) writer = state.writer.ownerKey
      for (const r of state.readers.keys()) readers.push(r)
    }
    const waitingCount = this.#waiters.filter(w =>
      !w.cancelled && (w.root === root || containsPath(w.root, root) || containsPath(root, w.root))).length
    return { readers, ...(writer ? { writer } : {}), waitingCount }
  }
}

const leaseManager = new WorkspaceLeaseManager()

function lineAt(text: string, offset: number): number {
  return (text.slice(0, offset).match(/\r\n|\n|\r/gu)?.length ?? 0) + 1
}

/** Locate a line window for a retry without returning file contents from a write tool. */
export function editRecovery(text: string, oldText: string, firstMatch: number) {
  if (firstMatch >= 0) {
    const secondMatch = text.indexOf(oldText, firstMatch + 1)
    return { code: 'ambiguous_match' as const, matchLines: [lineAt(text, firstMatch), lineAt(text, secondMatch)] }
  }
  const lines = oldText.split(/\r\n|\n|\r/u).map(line => line.trim())
  if (!lines.some(Boolean) || lines.length > maxReadLines) return { code: 'text_not_found' as const }
  const normalized = '\n' + text.split(/\r\n|\n|\r/u).map(line => line.trim()).join('\n') + '\n'
  const target = '\n' + lines.join('\n') + '\n'
  const match = normalized.indexOf(target)
  if (match < 0 || normalized.indexOf(target, match + 1) >= 0) return { code: 'text_not_found' as const }
  return { code: 'text_not_found' as const, readRange: { startLine: lineAt(normalized, match), lineCount: lines.length } }
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

function stripUnsafeControl(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, '')
}

function appendBoundedUtf8(chunks: string[], usedBytes: number, segment: string, limit: number): { usedBytes: number; hitLimit: boolean } {
  if (!segment) return { usedBytes, hitLimit: false }
  const segmentBytes = Buffer.byteLength(segment)
  if (usedBytes + segmentBytes <= limit) {
    chunks.push(segment)
    return { usedBytes: usedBytes + segmentBytes, hitLimit: false }
  }
  let out = ''
  let bytes = usedBytes
  for (const ch of segment) {
    const chBytes = Buffer.byteLength(ch)
    if (bytes + chBytes > limit) break
    out += ch
    bytes += chBytes
  }
  if (out) chunks.push(out)
  return { usedBytes: bytes, hitLimit: true }
}

function parseDiffHeaderPaths(line: string): [string, string] | undefined {
  if (line.startsWith('diff --git "a/')) {
    const match = /^diff --git "a\/((?:[^"\\]|\\.)+)" "b\/((?:[^"\\]|\\.)+)"$/u.exec(line)
    if (!match) return undefined
    const unescape = (value: string) => value.replace(/\\(["\\])/gu, '$1')
    return [unescape(match[1]!), unescape(match[2]!)]
  }
  if (!line.startsWith('diff --git a/')) return undefined
  const rest = line.slice('diff --git a/'.length)
  if (rest.length >= 3 && (rest.length - 3) % 2 === 0) {
    const half = (rest.length - 3) / 2
    if (rest.slice(half, half + 3) === ' b/' && rest.slice(0, half) === rest.slice(half + 3)) {
      const p = rest.slice(0, half)
      return [p, p]
    }
  }
  const sep = rest.indexOf(' b/')
  if (sep <= 0) return undefined
  return [rest.slice(0, sep), rest.slice(sep + 3)]
}

function filterDiffOutput(stdout: string, scope?: string): string {
  if (!stdout) return stdout
  const lines = stdout.split('\n')
  const kept: string[] = []
  let keeping = true
  let sawHeader = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.startsWith('diff --git ')) {
      sawHeader = true
      const paths = parseDiffHeaderPaths(line)
      keeping = Boolean(paths && paths.every(path => {
        const normalized = workspaceTarget({ path }, 'read')
        return normalized !== undefined && withinScopePath(scope, normalized)
      }))
    } else if (line.startsWith('... [truncated ') || line.startsWith('... [tail]')) {
      keeping = true
    } else if (!sawHeader && scope !== undefined) {
      keeping = true
    }
    if (keeping) kept.push(line)
  }
  return kept.join('\n')
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

  async checkedTarget(value: unknown, kind: 'file' | 'directory' | 'new', mode: 'read' | 'write' = 'write'): Promise<string> {
    const parts = segments(value, kind === 'directory', kind === 'directory' ? 'directory' : 'file', kind === 'new' ? 'write' : mode)
    if (kind !== 'new') return (await this.#checkedPath(parts, kind === 'directory')).path
    const { path: parent } = await this.#checkedPath(parts.slice(0, -1), true)
    const target = join(parent, parts.at(-1)!)
    try {
      await lstat(target)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return target
      throw error
    }
    throw new WorkspaceDenied('Workspace entry already exists')
  }

  readTextSnapshot(value: unknown, signal?: AbortSignal) {
    return this.#read(segments(value, false, 'file', 'read'), signal)
  }

  async readPreviewAsset(value: unknown, signal?: AbortSignal): Promise<Buffer> {
    return (await this.#readBytes(segments(value, false, 'file', 'read'), 512 * 1024, signal)).bytes
  }

  async readImageAsset(value: unknown, signal?: AbortSignal): Promise<Buffer> {
    return (await this.#readBytes(segments(value, false, 'file', 'read'), 4 * 1024 * 1024, signal)).bytes
  }

  async gitDiffSnapshot(value?: unknown, staged = false, signal?: AbortSignal, rawScopePath?: string) {
    const scope = rawScopePath !== undefined ? workspaceTarget({ path: rawScopePath }, 'read') : undefined
    if (rawScopePath !== undefined && scope === undefined) throw new WorkspaceDenied('Path denied by workspace policy')
    let target: string | undefined
    let isFileTarget = false
    if (value === undefined || value === '.') {
      await this.#checkedPath([], true)
      target = scope
      if (target) await this.#checkedGitTarget(target.split('/'))
    } else {
      const parts = segments(value, false, 'any', 'read')
      target = parts.join('/')
      if (!withinScopePath(scope, target)) throw new WorkspaceDenied('Path is outside the allowed scope')
      isFileTarget = await this.#checkedGitTarget(parts) === 'file'
    }
    const baseArgs = ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--no-renames',
      ...(staged ? ['--cached'] : [])]
    let pathspecs = target ? [target] : []
    if (!isFileTarget) {
      const names = await this.#git([...baseArgs, '--name-only', '-z', ...(pathspecs.length ? ['--', ...pathspecs] : [])], signal)
      if (names.state !== 'exited' || names.code !== 0) return { ok: false, error: 'Git inspection failed' }
      if (!names.truncated) {
        const changed = names.stdout.split('\0').slice(0, -1)
        const allowed = changed.filter(entry => {
          const normalized = workspaceTarget({ path: entry }, 'read')
          return normalized !== undefined && withinScopePath(scope, normalized)
        })
        if (!allowed.length) return { ok: true, stdout: '', truncated: false }
        if (allowed.length < changed.length && allowed.length <= 128) pathspecs = allowed
      }
    }
    const result = await this.#git([...baseArgs, '--no-color', ...(pathspecs.length ? ['--', ...pathspecs] : [])], signal)
    if (result.state !== 'exited' || result.code !== 0) return { ok: false, error: 'Git inspection failed' }
    const filtered = isFileTarget ? result.stdout : filterDiffOutput(result.stdout, scope)
    const stdout = redactProcessOutput(stripUnsafeControl(filtered), result.truncated)
    return {
      ok: true,
      stdout,
      truncated: result.truncated,
      ...(result.truncated ? { note: 'Git diff output was truncated; pass a narrower file or directory path for complete output.' } : {}),
    }
  }

  async gitRevisionSnapshot(ref: string, signal?: AbortSignal): Promise<string | undefined> {
    if (!ref || ref.startsWith('-') || ref.includes('..') || /[\u0000-\u0020:?*[\\\u007f]/u.test(ref)) return undefined
    try {
      const result = await this.#git(['rev-parse', '--verify', ref], signal)
      const commit = result.state === 'exited' && result.code === 0 ? result.stdout.trim() : ''
      return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit) ? commit : undefined
    } catch {
      return undefined
    }
  }

  async gitIndexCleanSnapshot(signal?: AbortSignal): Promise<boolean | undefined> {
    try {
      const result = await this.#git(['diff', '--cached', '--name-only', '--no-ext-diff', '--no-textconv', '-z'], signal)
      if (result.state !== 'exited' || result.code !== 0 || result.truncated) return undefined
      return result.stdout === ''
    } catch {
      return undefined
    }
  }

  acquireWrite(ownerId?: string): (() => void) | undefined {
    return leaseManager.tryAcquire(this.root, 'write', ownerId)
  }

  acquireRead(ownerId?: string): (() => void) | undefined {
    return leaseManager.tryAcquire(this.root, 'read', ownerId)
  }

  acquireLease(mode: 'read' | 'write', options: { ownerId?: string; signal?: AbortSignal } = {}): Promise<WorkspaceLease> {
    return leaseManager.acquireAsync(this.root, mode, options.ownerId, options.signal)
  }

  leaseState() {
    return leaseManager.snapshot(this.root)
  }

  tools(role: 'root' | 'team' | 'worker', access: WorkspaceAccess = role === 'root' ? 'write' : 'read'): WorkspaceTool[] {
    const readTools = [
      this.#tool('list_directory', 'List allowed entries in one directory. Use "." for the workspace root.',
        'read', { path: pathProperty }, (args, signal) => this.#list(args.path, signal)),
      this.#tool('read_text_file', 'Read a workspace text file up to 128 KiB. For larger files, pass startLine and lineCount for a bounded slice with original whitespace.',
        'read', { path: pathProperty, startLine: { type: 'integer', minimum: 1, maximum: maxStartLine },
          lineCount: { type: 'integer', minimum: 1, maximum: maxReadLines } }, async (args, signal) => {
          const startLine = args.startLine === undefined ? 1 : args.startLine
          const lineCount = args.lineCount === undefined ? maxReadLines : args.lineCount
          if (typeof startLine !== 'number' || !Number.isSafeInteger(startLine) || startLine < 1 || startLine > maxStartLine ||
            typeof lineCount !== 'number' || !Number.isSafeInteger(lineCount) || lineCount < 1 || lineCount > maxReadLines) {
            return { ok: false, error: 'Invalid line range' }
          }
          const parts = segments(args.path, false, 'file', 'read')
          if (args.startLine === undefined && args.lineCount === undefined) {
            const { stat } = await this.#checkedPath(parts, false)
            if (stat.size > maxBytes) {
              return {
                ok: false,
                code: 'file_too_large',
                error: `Workspace file exceeds the 128 KiB whole-file read limit (${stat.size} bytes). Pass startLine and lineCount (e.g. startLine: 1, lineCount: ${maxReadLines}) to read a slice.`,
                sizeBytes: stat.size,
                maxBytes,
              }
            }
            const { text } = await this.#read(parts, signal)
            return { ok: true, text }
          }
          return this.#readLineRange(parts, startLine, lineCount, signal)
        }, ['startLine', 'lineCount']),
      this.#tool('git_status', 'Inspect local Git status for allowed workspace paths.', 'read', {},
        async (_args, signal, context) => this.#gitStatus(signal, context?.scopePath), []),
      this.#tool('git_diff', 'Inspect the unstaged or staged Git diff for the workspace, a directory, or an allowed file.',
        'read', { path: pathProperty, staged: { type: 'boolean' } }, async (args, signal, context) => {
          if (args.staged !== undefined && typeof args.staged !== 'boolean') throw new WorkspaceDenied('Invalid staged flag')
          return this.gitDiffSnapshot(args.path, args.staged === true, signal, context?.scopePath)
        }, ['path', 'staged']),
      this.#tool('git_log', 'Inspect recent local commits as abbreviated IDs, dates, and titles.', 'read',
        { limit: { type: 'integer', minimum: 1, maximum: maxGitLogLimit }, path: pathProperty },
        async (args, signal, context) => {
          const limit = args.limit === undefined ? 10 : args.limit
          if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > maxGitLogLimit) {
            return { ok: false, error: 'Invalid commit limit' }
          }
          const scope = context?.scopePath !== undefined ? workspaceTarget({ path: context.scopePath }, 'read') : undefined
          if (context?.scopePath !== undefined && scope === undefined) throw new WorkspaceDenied('Path denied by workspace policy')
          let target = scope
          if (args.path !== undefined && args.path !== '.') {
            const parts = segments(args.path, false, 'any', 'read')
            target = parts.join('/')
            if (!withinScopePath(scope, target)) throw new WorkspaceDenied('Path is outside the allowed scope')
            await this.#checkedGitTarget(parts)
          } else {
            await this.#checkedPath([], true)
          }
          return this.#gitText(['log', '-n', String(limit), '--format=%h%x09%cs%x09%s', ...(target ? ['--', target] : [])], signal)
        }, ['limit', 'path']),
    ]
    if (access === 'read') return readTools
    const writeTools = [
      ...readTools,
      this.#tool('create_text_file', 'Create a new workspace text file in an existing directory.',
        'write', { path: pathProperty, content: textProperty }, (args, signal) => this.#create(args, signal)),
      this.#tool('edit_text_file', 'Replace exactly one literal occurrence of oldText, including whitespace. On a mismatch, use the returned readRange to reread the current file when available.',
        'write', { path: pathProperty, oldText: textProperty, newText: textProperty },
        (args, signal) => this.#edit(args, signal)),
      this.#tool('create_directory', 'Create a workspace directory (and missing allowed parent directories) safely within the workspace.',
        'write', { path: pathProperty }, (args, signal) => this.#mkdir(args.path, signal)),
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
        }, ['args'], { minimumAccess: 'write', approval: 'shell' }),
    ]
    return writeTools
  }

  async verify(check: VerificationCheck, signal?: AbortSignal, access?: WorkspaceAccess, ownerId?: string): Promise<VerificationResult> {
    if (check.command) {
      if (access !== 'trusted') return { passed: false, evidence: 'workspace_command_not_authorized' }
      const release = this.acquireWrite(ownerId)
      if (!release) return { passed: false, evidence: 'workspace_write_active' }
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
        release()
      }
    }
    try {
      const { text } = await this.#read(segments(check.path, false, 'file'), signal)
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
    execute: (args: Record<string, unknown>, signal?: AbortSignal, context?: ToolInvocationContext) => Promise<unknown>,
    optional: string[] = [],
    policy?: ToolPolicy,
  ): WorkspaceTool {
    return {
      name,
      description,
      effect,
      policy,
      parameters: {
        type: 'object', properties,
        required: Object.keys(properties).filter((key) => !optional.includes(key)),
        additionalProperties: false,
      },
      execute: async (_callId, input, signal, context) => {
        if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).some((key) => !Object.hasOwn(properties, key))) return { ok: false, error: 'Invalid arguments' }
        if (signal?.aborted) return { ok: false, error: 'Tool interrupted before execution' }
        const release = effect === 'write'
          ? this.acquireWrite(context?.agentRunId)
          : this.acquireRead(context?.agentRunId)
        if (!release) {
          return { ok: false, error: effect === 'write' ? 'Another workspace write is active' : 'Another workspace write is active' }
        }
        try {
          return await execute(input as Record<string, unknown>, signal, context)
        } catch (error) {
          if (error instanceof WorkspaceDenied) return { ok: false, error: error.message }
          if (effect === 'read') {
            if (error instanceof UnknownProcessEffect) return { ok: false, error: 'Git inspection interrupted' }
            return { ok: false, error: 'Workspace entry unavailable' }
          }
          if (error instanceof UnknownProcessEffect) throw error
          throw new Error('Workspace write could not be confirmed')
        } finally {
          release()
        }
      },
    }
  }

  async #mkdir(value: unknown, signal?: AbortSignal) {
    const parts = segments(value, false, 'directory', 'write')
    let current = this.root
    try {
      const rootStat = await lstat(current)
      if (!rootStat.isDirectory() || !sameFile(rootStat, this.#rootStat)) throw new WorkspaceDenied('Workspace changed')
    } catch (error) {
      if (error instanceof WorkspaceDenied) throw error
      throw new WorkspaceDenied('Workspace entry unavailable')
    }
    for (const segment of parts) {
      current = join(current, segment)
      let stat: Stats | undefined
      try {
        stat = await lstat(current)
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw new WorkspaceDenied('Workspace entry unavailable')
      }
      if (stat) {
        if (!stat.isDirectory() || relative(current, await realpath(current)) !== '') {
          throw new WorkspaceDenied('Workspace entry type or alias denied')
        }
        continue
      }
      if (signal?.aborted) return { ok: false, error: 'Tool interrupted before writing' }
      try {
        await mkdir(current)
      } catch (error) {
        const code = errorCode(error)
        if (code === 'EEXIST') {
          const existing = await lstat(current).catch(() => undefined)
          if (existing?.isDirectory() && relative(current, await realpath(current)) === '') continue
          throw new WorkspaceDenied('Workspace entry type or alias denied')
        }
        if (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT' || code === 'ENOTDIR' || code === 'EROFS' ||
          code === 'EINVAL' || code === 'ENAMETOOLONG' || code === 'ENOSPC') {
          return { ok: false, error: 'Could not create directory' }
        }
        throw error
      }
      const created = await lstat(current).catch(() => undefined)
      if (!created?.isDirectory() || relative(current, await realpath(current)) !== '') {
        throw new WorkspaceDenied('Workspace entry type or alias denied')
      }
    }
    return { ok: true }
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
    return { ok: true, stdout: redactProcessOutput(stripUnsafeControl(result.stdout), result.truncated), truncated: result.truncated }
  }

  async #checkedGitTarget(parts: string[]): Promise<'file' | 'directory' | 'missing'> {
    if (!parts.length) {
      await this.#checkedPath([], true)
      return 'directory'
    }
    const { path: parent } = await this.#checkedPath(parts.slice(0, -1), true)
    const leaf = join(parent, parts.at(-1)!)
    try {
      const stat = await lstat(leaf)
      if (relative(leaf, await realpath(leaf)) !== '') {
        throw new WorkspaceDenied('Workspace entry type or alias denied')
      }
      if (stat.isDirectory()) return 'directory'
      if (regularFile(stat)) return 'file'
      throw new WorkspaceDenied('Workspace entry type or alias denied')
    } catch (error) {
      if (error instanceof WorkspaceDenied) throw error
      if (errorCode(error) === 'ENOENT') return 'missing'
      throw new WorkspaceDenied('Workspace entry unavailable')
    }
  }

  async #gitStatus(signal?: AbortSignal, rawScopePath?: string) {
    const scope = rawScopePath ? workspaceTarget({ path: rawScopePath }, 'read') : undefined
    const result = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--no-renames',
      '--ignore-submodules=all', ...(scope ? ['--', scope] : [])], signal)
    if (result.state !== 'exited' || result.code !== 0) return { ok: false, error: 'Git inspection failed' }
    const entries = []
    for (const record of result.stdout.split('\0').slice(0, -1)) {
      const path = record.slice(3).replace(/\/$/u, '')
      const normalized = workspaceTarget({ path }, 'read')
      if (normalized !== undefined && withinScopePath(scope, normalized)) {
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
    const { path } = await this.#checkedPath(segments(value, true, 'directory', 'read'), true)
    const entries: { name: string; kind: 'file' | 'directory' }[] = []
    const directory = await opendir(path)
    let scanned = 0
    for await (const entry of directory) {
      signal?.throwIfAborted()
      if (++scanned > maxScannedEntries || entries.length >= maxEntries) {
        return { ok: true, entries, truncated: true }
      }
      if (entry.isDirectory() ? allowedSegment(entry.name, 'directory', 'read')
        : entry.isFile() && allowedSegment(entry.name, 'file', 'read')) {
        entries.push({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' })
      }
    }
    return { ok: true, entries, truncated: false }
  }

  async #read(parts: string[], signal?: AbortSignal): Promise<{ path: string; text: string; stat: Stats }> {
    const { path, bytes, stat } = await this.#readBytes(parts, maxBytes, signal)
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      return { path, text: textValue(text), stat }
    } catch { throw new WorkspaceDenied('Could not read a stable UTF-8 workspace file') }
  }

  async #readLineRange(parts: string[], startLine: number, lineCount: number, signal?: AbortSignal) {
    const { path, stat } = await this.#checkedPath(parts, false)
    if (stat.size > maxStreamBytes) throw new WorkspaceDenied('Workspace file exceeds the streamable size limit')
    signal?.throwIfAborted()
    try {
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      try {
        const opened = await file.stat()
        if (!regularFile(opened) || !unchangedFile(stat, opened)) throw new WorkspaceDenied('Workspace file changed')
        const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
        const buffer = Buffer.allocUnsafe(readChunkBytes)
        let count = 0
        let pending = ''
        let currentLine = 1
        let sawNonEmpty = false
        let endedWithNewline = false
        let totalLines = 1
        const collected: string[] = []
        let collectedBytes = 0
        let truncated = false
        let lastCollectedLine = startLine - 1
        const endTarget = startLine + lineCount

        const consume = (chunkText: string, eof: boolean) => {
          if (chunkText && (!chunkText.isWellFormed() || invalidTextCharacter.test(chunkText))) {
            throw new WorkspaceDenied('Could not read a stable UTF-8 workspace file')
          }
          pending += chunkText
          if (pending.length > 0) sawNonEmpty = true
          const holdCr = !eof && pending.endsWith('\r')
          const scan = holdCr ? pending.slice(0, -1) : pending
          let pos = 0
          for (const match of scan.matchAll(/\r\n|\n|\r/gu)) {
            const nextPos = match.index + match[0].length
            const line = scan.slice(pos, nextPos)
            pos = nextPos
            endedWithNewline = true
            if (currentLine >= startLine && currentLine < endTarget && !truncated) {
              const next = appendBoundedUtf8(collected, collectedBytes, line, maxBytes)
              collectedBytes = next.usedBytes
              if (next.hitLimit) truncated = true
              lastCollectedLine = currentLine
            }
            currentLine++
          }
          const rem = scan.slice(pos)
          if (rem.length > 0) {
            endedWithNewline = false
            if (currentLine >= startLine && currentLine < endTarget && !truncated) {
              const next = appendBoundedUtf8(collected, collectedBytes, rem, maxBytes)
              collectedBytes = next.usedBytes
              if (next.hitLimit) truncated = true
              lastCollectedLine = currentLine
            }
          }
          if (eof) {
            totalLines = !sawNonEmpty ? 1 : endedWithNewline ? currentLine - 1 : currentLine
            pending = ''
          } else {
            pending = holdCr ? '\r' : ''
          }
        }

        while (count <= opened.size) {
          signal?.throwIfAborted()
          const { bytesRead } = await file.read(buffer, 0, buffer.length, count)
          if (bytesRead === 0) break
          count += bytesRead
          if (count > opened.size) throw new WorkspaceDenied('Workspace file changed')
          consume(decoder.decode(buffer.subarray(0, bytesRead), { stream: true }), false)
        }
        if (count !== opened.size || !unchangedFile(opened, await file.stat())) {
          throw new WorkspaceDenied('Workspace file changed')
        }
        consume(decoder.decode(), true)

        if (startLine > totalLines) {
          return { ok: false, error: 'Start line is past the end of the file', totalLines }
        }
        const endLine = Math.max(startLine, Math.min(lastCollectedLine, totalLines))
        return {
          ok: true,
          text: collected.join(''),
          startLine,
          endLine,
          totalLines,
          ...(truncated ? { truncated: true } : {}),
        }
      } finally {
        await file.close()
      }
    } catch (error) {
      if (error instanceof WorkspaceDenied) throw error
      throw new WorkspaceDenied('Could not read a stable UTF-8 workspace file')
    }
  }

  async #readBytes(parts: string[], limit: number, signal?: AbortSignal): Promise<{ path: string; bytes: Buffer; stat: Stats }> {
    const { path, stat } = await this.#checkedPath(parts, false)
    if (stat.size > limit) throw new WorkspaceDenied('Workspace file exceeds the size limit')
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
        return { path, bytes: buffer.subarray(0, count), stat: opened }
      } finally {
        await file.close()
      }
    } catch (error) {
      if (error instanceof WorkspaceDenied) throw error
      throw new WorkspaceDenied('Could not read a stable workspace file')
    }
  }

  async #create(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const parts = segments(args.path, false, 'file')
    const content = textValue(args.content)
    const { path: parent } = await this.#checkedPath(parts.slice(0, -1), true)
    const target = join(parent, parts.at(-1)!)
    if (signal?.aborted) return { ok: false, error: 'Tool interrupted before writing' }
    let file
    try {
      file = await open(target, 'wx')
    } catch (error) {
      const code = errorCode(error)
      if (code === 'EEXIST') return { ok: false, error: 'Workspace entry already exists' }
      if (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT' || code === 'ENOTDIR' || code === 'EROFS' ||
        code === 'EISDIR' || code === 'EINVAL' || code === 'ENAMETOOLONG' || code === 'ENOSPC') {
        return { ok: false, error: 'Could not create workspace file' }
      }
      throw error
    }
    await writeAndSync(file, content)
    return { ok: true }
  }

  async #edit(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const parts = segments(args.path, false, 'file')
    const oldText = textValue(args.oldText)
    const newText = textValue(args.newText)
    if (!oldText) throw new WorkspaceDenied('oldText must be nonempty')
    const { path, text, stat } = await this.#read(parts, signal)
    const start = text.indexOf(oldText)
    if (start < 0 || text.indexOf(oldText, start + 1) >= 0) {
      return { ok: false, error: start < 0 ? 'oldText not found. Read the current file and retry with exact text.'
        : 'oldText matches more than once. Include enough context to identify one occurrence.', ...editRecovery(text, oldText, start) }
    }
    const content = textValue(text.slice(0, start) + newText + text.slice(start + oldText.length))
    if (content === text) return { ok: true, changed: false }
    if (signal?.aborted) return { ok: false, error: 'Tool interrupted before writing' }
    const staged = join(dirname(path), `.zlo-edit-${randomUUID()}.tmp`)
    let file
    try {
      file = await open(staged, 'wx', stat.mode & 0o777)
    } catch {
      return { ok: false, error: 'Could not stage workspace edit' }
    }
    let renameStarted = false
    let committed = false
    try {
      await writeAndSync(file, content)
      const current = await this.#read(parts, signal)
      if (!unchangedFile(stat, current.stat) || current.text !== text) {
        throw new WorkspaceDenied('Workspace file changed before edit')
      }
      if (signal?.aborted) return { ok: false, error: 'Tool interrupted before writing' }
      renameStarted = true
      await rename(staged, path)
      committed = true
      return { ok: true, changed: true }
    } catch (error) {
      if (!renameStarted) {
        await unlink(staged).catch((unlinkError) => {
          if (errorCode(unlinkError) !== 'ENOENT') throw unlinkError
        })
        if (error instanceof WorkspaceDenied) throw error
        return { ok: false, error: 'Could not stage workspace edit' }
      }
      throw error
    } finally {
      if (!committed) {
        await unlink(staged).catch((unlinkError) => {
          if (errorCode(unlinkError) !== 'ENOENT') throw unlinkError
        })
      }
    }
  }
}
