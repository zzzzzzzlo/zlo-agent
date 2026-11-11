import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { link, lstat, open, opendir, rename, unlink } from 'node:fs/promises'
import { dirname, join, matchesGlob } from 'node:path'
import { Worker } from 'node:worker_threads'
import { redactProcessOutput } from './workspace-process.ts'
import { workspaceTarget } from './workspace.ts'
import type { CodingWorkspace, WorkspaceTool } from './workspace.ts'

const maxFiles = 100
const maxVisited = 5_000
const maxDepth = 24
const maxSearchBytes = 2 * 1024 * 1024
const maxSearchMs = 3_000
const maxTextBytes = 128 * 1024
const maxPatchFiles = 16
const pathSchema = { type: 'string', minLength: 1, maxLength: 512 }
const globSchema = { type: 'string', minLength: 1, maxLength: 160 }
const textSchema = { type: 'string', maxLength: maxTextBytes }

function rejected(error: string) { return { ok: false, error } }

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function pathValue(path: unknown): string | undefined { return workspaceTarget({ path }) }

function rootPath(path: unknown): string | undefined { return path === '.' || path === undefined ? '.' : pathValue(path) }

function globValue(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 160 || /[{}[\]!+@()\x00-\x1f\x7f<>:"|]/u.test(value) ||
    (value.match(/[?*]/g)?.length ?? 0) > 8) return undefined
  const parts = value.replaceAll('\\', '/').split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) return undefined
  return parts.join('/')
}

function globMatch(path: string, pattern: string): boolean {
  const subject = pattern.includes('/') ? path : path.split('/').at(-1)!
  return matchesGlob(subject, pattern)
}

async function filePaths(workspace: CodingWorkspace, root: string, pattern: string, signal: AbortSignal) {
  const paths: string[] = []
  let visited = 0
  let truncated = false
  const pending = [{ path: root, depth: 0 }]
  while (pending.length) {
    const { path, depth } = pending.pop()!
    signal.throwIfAborted()
    let absolute: string
    try { absolute = await workspace.checkedTarget(path, 'directory') } catch {
      if (depth === 0) throw new Error('Search directory unavailable')
      continue
    }
    const directory = await opendir(absolute)
    for await (const entry of directory) {
      signal.throwIfAborted()
      if (++visited > maxVisited || paths.length >= maxFiles) return { paths, truncated: true }
      const next = pathValue(path === '.' ? entry.name : `${path}/${entry.name}`)
      if (!next) continue
      if (entry.isDirectory()) {
        if (depth < maxDepth) pending.push({ path: next, depth: depth + 1 })
        else truncated = true
      } else if (entry.isFile()) {
        const local = root === '.' ? next : next.slice(root.length + 1)
        if (!globMatch(local, pattern)) continue
        const checked = await workspace.checkedTarget(next, 'file').catch(() => undefined)
        if (checked) paths.push(next)
      }
    }
  }
  return { paths, truncated }
}

interface SearchFile { path: string; text: string }
interface SearchMatch { path: string; line: number; column: number; text: string }

// A caller-supplied regular expression cannot block the Host or its stop processing.
const searchWorker = String.raw`
  const { parentPort, workerData } = require('node:worker_threads');
  const { files, query, regex, caseSensitive, limit } = workerData;
  let expression;
  try { if (regex) expression = new RegExp(query, caseSensitive ? 'u' : 'iu'); }
  catch { parentPort.postMessage({ invalid: true }); return; }
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches = [];
  for (const file of files) {
    const lines = file.text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const text = lines[index];
      const column = expression ? text.search(expression) : (caseSensitive ? text : text.toLowerCase()).indexOf(needle);
      if (column < 0) continue;
      if (matches.length >= limit) { parentPort.postMessage({ matches, truncated: true }); return; }
      matches.push({ path: file.path, line: index + 1, column: column + 1, text });
    }
  }
  parentPort.postMessage({ matches, truncated: false });
`

function searchLines(files: SearchFile[], query: string, regex: boolean, caseSensitive: boolean, signal: AbortSignal) {
  type Result = { matches: SearchMatch[]; truncated: boolean } | { invalid: true } | undefined
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise<Result>(resolve => {
    const worker = new Worker(`(() => { ${searchWorker} })()`, {
      eval: true, execArgv: [], workerData: { files, query, regex, caseSensitive, limit: maxFiles },
    })
    let finished = false
    const finish = (result?: Result) => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', abort)
      void worker.terminate().catch(() => undefined)
      resolve(result)
    }
    const abort = () => finish()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    worker.once('message', finish)
    worker.once('error', abort)
    worker.once('exit', abort)
  })
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && right.isFile()
}

function unchanged(left: Stats, right: Stats): boolean {
  return sameFile(left, right) && left.size === right.size && left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value) <= maxTextBytes && value.isWellFormed() &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
}

function editList(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxPatchFiles) return undefined
  const seen = new Set<string>()
  const edits: { path: string; oldText: string; newText: string }[] = []
  for (const item of value) {
    const input = object(item)
    const path = pathValue(input?.path)
    if (!path || !input || Object.keys(input).some(key => !['path', 'oldText', 'newText'].includes(key)) ||
      !boundedText(input.oldText) || !input.oldText || !boundedText(input.newText)) return undefined
    const key = process.platform === 'win32' ? path.toLowerCase() : path
    if (seen.has(key)) return undefined
    seen.add(key)
    edits.push({ path, oldText: input.oldText, newText: input.newText })
  }
  return edits
}

async function patchFiles(workspace: CodingWorkspace, input: unknown, signal?: AbortSignal) {
  const edits = editList(input)
  if (!edits) return rejected('Invalid patch entries')
  const pending: { relative: string; path: string; original: string; stat: Stats; content: string }[] = []
  for (const edit of edits) {
    if (signal?.aborted) return rejected('Patch interrupted before mutation')
    const current = await workspace.readTextSnapshot(edit.path, signal).catch(() => undefined)
    if (!current) return rejected('Patch file unavailable')
    const match = current.text.indexOf(edit.oldText)
    if (match < 0 || current.text.indexOf(edit.oldText, match + 1) >= 0) return rejected('Patch text must match exactly once in every file')
    const content = current.text.slice(0, match) + edit.newText + current.text.slice(match + edit.oldText.length)
    if (!boundedText(content)) return rejected('Patched file exceeds the text limit')
    if (content !== current.text) pending.push({ relative: edit.path, path: current.path, original: current.text, stat: current.stat, content })
  }
  const staged = new Set<string>()
  const writes: { item: typeof pending[number]; temporary: string }[] = []
  let mutationStarted = false
  try {
    for (const item of pending) {
      if (signal?.aborted) return rejected('Patch interrupted before mutation')
      if (await workspace.checkedTarget(item.relative, 'file') !== item.path) return rejected('Patch file changed before staging')
      const temporary = join(dirname(item.path), '.zlo-patch-' + randomUUID() + '.tmp')
      const file = await open(temporary, 'wx', item.stat.mode & 0o777)
      staged.add(temporary)
      try {
        await file.writeFile(item.content, 'utf8')
        await file.sync()
      } finally { await file.close() }
      writes.push({ item, temporary })
    }
    for (const { item, temporary } of writes) {
      const current = await workspace.readTextSnapshot(item.relative, signal).catch(() => undefined)
      if (signal?.aborted || !current || current.path !== item.path || !unchanged(item.stat, current.stat) || current.text !== item.original) {
        if (mutationStarted) throw new Error('Patch was partially applied')
        return rejected('Patch interrupted or file changed before mutation')
      }
      mutationStarted = true
      await rename(temporary, item.path)
      staged.delete(temporary)
    }
    return { ok: true, changed: pending.map(({ relative }) => redactProcessOutput(relative)) }
  } finally {
    for (const temporary of staged) {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  }
}

function moveTargets(input: Record<string, unknown>, renameInPlace: boolean): [string, string] | undefined {
  const source = pathValue(input.path)
  const target = pathValue(renameInPlace ? input.newName : input.destination)
  if (!source || !target || (renameInPlace && target.includes('/'))) return undefined
  const parent = source.split('/').slice(0, -1).join('/')
  return [source, renameInPlace && parent ? `${parent}/${target}` : target]
}

async function moveFile(workspace: CodingWorkspace, targets: [string, string] | undefined, signal?: AbortSignal) {
  if (!targets) return rejected('Invalid move paths')
  const [source, destination] = targets
  const existing = await workspace.checkedTarget(source, 'file').catch(() => undefined)
  const next = await workspace.checkedTarget(destination, 'new').catch(() => undefined)
  if (!existing || !next) return rejected('Move source or destination unavailable')
  const before = await lstat(existing)
  if (!before.isFile() || before.nlink !== 1 || signal?.aborted) return rejected('Move source changed before mutation')
  try {
    // Unlike rename(), link() fails atomically when the destination already exists.
    await link(existing, next)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || code === 'EXDEV') return rejected('Move destination exists or is on another volume')
    throw error
  }
  const current = await lstat(existing)
  const linked = await lstat(next)
  if (!sameFile(before, current) || !sameFile(before, linked) || current.nlink !== 2 || linked.nlink !== 2 || signal?.aborted) {
    throw new Error('Move result requires reconciliation')
  }
  await unlink(existing)
  return { ok: true, path: redactProcessOutput(destination) }
}

export function createFileTools(workspace: CodingWorkspace): WorkspaceTool[] {
  function tool(name: string, description: string, effect: WorkspaceTool['effect'], properties: Record<string, unknown>,
    required: string[], execute: (input: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
    targets: (input: unknown) => string[], approval?: 'destructive'): WorkspaceTool {
    return {
      name, description, effect, policy: { targets, approval },
      parameters: { type: 'object', properties, required, additionalProperties: false },
      async execute(_id, raw, signal) {
        const input = object(raw)
        if (!input || Object.keys(input).some(key => !Object.hasOwn(properties, key)) ||
          required.some(key => !Object.hasOwn(input, key)) || signal?.aborted) return rejected('Invalid or interrupted file request')
        if (effect === 'read') {
          try { return await execute(input, signal) } catch { return rejected('File search unavailable or timed out') }
        }
        const release = workspace.acquireWrite()
        if (!release) return rejected('Another workspace write is active')
        try { return await execute(input, signal) } finally { release() }
      },
    }
  }

  const searchTargets = (input: unknown) => [rootPath(object(input)?.path) ?? '']
  return [
    tool('search_files', 'Find workspace files by name or glob. Use ** for recursive path matching.', 'read',
      { path: pathSchema, glob: globSchema }, ['glob'], async (input, signal) => {
        const root = rootPath(input.path)
        const pattern = globValue(input.glob)
        if (!root || !pattern) return rejected('Invalid search path or glob')
        const bounded = AbortSignal.any([AbortSignal.timeout(maxSearchMs), ...(signal ? [signal] : [])])
        const result = await filePaths(workspace, root, pattern, bounded)
        return { ok: true, paths: result.paths.sort().map(path => redactProcessOutput(path)), truncated: result.truncated }
      }, searchTargets),
    tool('search_content', 'Find literal or regular expression matches in bounded UTF-8 workspace files.', 'read',
      { path: pathSchema, glob: globSchema, query: { type: 'string', minLength: 1, maxLength: 256 }, regex: { type: 'boolean' },
        caseSensitive: { type: 'boolean' } }, ['query'], async (input, signal) => {
        const root = rootPath(input.path)
        const pattern = globValue(input.glob ?? '**/*')
        if (!root || !pattern || typeof input.query !== 'string' || !input.query || input.query.length > 256 ||
          !input.query.isWellFormed() || [input.regex, input.caseSensitive].some(flag => flag !== undefined && typeof flag !== 'boolean')) {
          return rejected('Invalid content search')
        }
        const bounded = AbortSignal.any([AbortSignal.timeout(maxSearchMs), ...(signal ? [signal] : [])])
        const { paths, truncated } = await filePaths(workspace, root, pattern, bounded)
        const files: SearchFile[] = []
        let bytes = 0
        let capped = truncated
        for (const path of paths) {
          bounded.throwIfAborted()
          const file = await workspace.readTextSnapshot(path, bounded).catch(() => undefined)
          if (!file) continue
          bytes += Buffer.byteLength(file.text)
          if (bytes > maxSearchBytes) { capped = true; break }
          files.push({ path, text: file.text })
        }
        const result = await searchLines(files, input.query, input.regex === true, input.caseSensitive === true, bounded)
        if (!result) return rejected('Content search timed out or was interrupted')
        if ('invalid' in result) return rejected('Invalid regular expression')
        return { ok: true, truncated: capped || result.truncated, matches: result.matches.map(match => ({
          ...match, path: redactProcessOutput(match.path), text: redactProcessOutput(match.text).slice(0, 512),
        })) }
      }, searchTargets),
    tool('apply_patch', 'Replace one exact text occurrence per file. All files are checked before any target is changed.', 'write',
      { edits: { type: 'array', minItems: 1, maxItems: maxPatchFiles, items: { type: 'object', additionalProperties: false,
        properties: { path: pathSchema, oldText: textSchema, newText: textSchema }, required: ['path', 'oldText', 'newText'] } } },
      ['edits'], (input, signal) => patchFiles(workspace, input.edits, signal),
      input => editList(object(input)?.edits)?.map(({ path }) => path) ?? ['']),
    tool('move_file', 'Move one regular file to an unused workspace path on the same volume.', 'write',
      { path: pathSchema, destination: pathSchema }, ['path', 'destination'],
      (input, signal) => moveFile(workspace, moveTargets(input, false), signal),
      input => moveTargets(object(input) ?? {}, false) ?? ['']),
    tool('rename_file', 'Rename one regular file in its current directory without overwriting.', 'write',
      { path: pathSchema, newName: pathSchema }, ['path', 'newName'],
      (input, signal) => moveFile(workspace, moveTargets(input, true), signal),
      input => moveTargets(object(input) ?? {}, true) ?? ['']),
    tool('delete_file', 'Delete one regular workspace file after explicit user authorization.', 'write',
      { path: pathSchema }, ['path'], async (input, signal) => {
        const path = await workspace.checkedTarget(input.path, 'file').catch(() => undefined)
        if (!path || signal?.aborted) return rejected('File unavailable or deletion interrupted')
        await unlink(path)
        return { ok: true }
      }, input => [pathValue(object(input)?.path) ?? ''], 'destructive'),
  ]
}
