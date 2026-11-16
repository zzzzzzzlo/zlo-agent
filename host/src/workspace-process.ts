import { spawn } from 'node:child_process'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path'
import type { ProjectCommand } from './contracts/domain.ts'

const npmScripts = {
  npm_test: 'test',
  npm_build: 'build',
  npm_lint: 'lint',
  npm_typecheck: 'typecheck',
} as const

const commandTimeoutMs = 90_000
const outputLimit = 16 * 1024
const headOutputLimit = 4 * 1024
const errorOutputLimit = 2 * 1024
const maxErrorLines = 12
const tailOutputLimit = 12 * 1024
const maxTrackedLineBytes = 4 * 1024
const windows = process.platform === 'win32'
const diagnosticLinePattern = /\b(?:error|fail(?:ed|ure)?|fatal|panic|exception|traceback|assertionerror|syntaxerror|typeerror|referenceerror|segfault|unhandled|enoent|eaccess|eperm)\b|error\s+ts\d{4}:|^[×✖]|^\s*FAIL\b|^\s*ERR!/iu

export function parseProjectCommand(input: unknown): ProjectCommand {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid project command')
  const { command, path, args } = input as Record<string, unknown>
  if (Object.keys(input).some((key) => !['command', 'path', 'args'].includes(key)) ||
    typeof path !== 'string' || !path || path.length > 512 || !path.isWellFormed() || path.includes('\0')) {
    throw new Error('Invalid project command path or arguments')
  }
  if (command === 'node_script') {
    if (args !== undefined && (!Array.isArray(args) || args.length > 16 ||
      !args.every((arg: unknown) => typeof arg === 'string' && arg.length <= 1024 && arg.isWellFormed() && !arg.includes('\0')))) {
      throw new Error('Invalid project script arguments')
    }
    return { command, path, ...(args !== undefined ? { args: [...args] } : {}) }
  }
  if (typeof command !== 'string' || !Object.hasOwn(npmScripts, command) || args !== undefined) {
    throw new Error('Project command is not allowed')
  }
  return { command: command as keyof typeof npmScripts, path }
}

export function containsPath(parent: string, path: string): boolean {
  const offset = relative(parent, path)
  return offset === '' || (!isAbsolute(offset) && offset !== '..' && !/^\.\.[\\/]/u.test(offset))
}

function trustedFile(path: string, workspace: string, mode: number): string | undefined {
  if (!isAbsolute(path) || containsPath(workspace, path)) return undefined
  try {
    const canonical = realpathSync.native(path)
    if (containsPath(workspace, canonical) || !statSync(canonical).isFile()) return undefined
    accessSync(canonical, mode)
    return canonical
  } catch {
    return undefined
  }
}

function trustedPath(workspace: string): string[] {
  return (process.env.PATH ?? '').split(delimiter).filter((directory) => {
    if (!isAbsolute(directory) || (windows && !/^[a-z]:[\\/]/iu.test(directory)) ||
      containsPath(workspace, directory)) return false
    try {
      return !containsPath(workspace, realpathSync.native(directory))
    } catch {
      return false
    }
  })
}

function findFile(candidates: string[], workspace: string, mode: number): string | undefined {
  for (const candidate of candidates) {
    const found = trustedFile(candidate, workspace, mode)
    if (found) return found
  }
  return undefined
}

interface Invocation {
  executable: string
  args: string[]
  electronNode?: boolean
  git?: boolean
}

export function projectInvocation(command: ProjectCommand, target: string, workspace: string): Invocation | undefined {
  const path = trustedPath(workspace)
  const node = findFile([
    process.execPath, ...path.map((directory) => join(directory, windows ? 'node.exe' : 'node')),
  ], workspace, constants.X_OK)
  if (!node) return undefined
  const electronNode = process.versions.electron !== undefined &&
    node === trustedFile(process.execPath, workspace, constants.X_OK)
  if (command.command === 'node_script') {
    return { executable: node, args: [target, ...command.args ?? []], electronNode }
  }
  const npm = findFile([dirname(node), ...path].flatMap((directory) => [
    join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(directory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(directory, 'npm'),
  ]).filter((candidate) => !windows || candidate.endsWith('.js')), workspace, constants.R_OK)
  if (!npm) return undefined
  return { executable: node, args: [npm, 'run-script', npmScripts[command.command]], electronNode }
}

export function gitInvocation(workspace: string, args: string[]): Invocation | undefined {
  const executable = findFile(trustedPath(workspace).map((directory) => join(directory, windows ? 'git.exe' : 'git')),
    workspace, constants.X_OK)
  if (!executable) return undefined
  return {
    executable,
    git: true,
    args: [
      '--no-pager', '--no-optional-locks', '--literal-pathspecs',
      '--git-dir', join(workspace, '.git'), '--work-tree', workspace,
      '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
      ...args,
    ],
  }
}

export function processEnvironment(workspace: string, invocation?: Invocation): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: trustedPath(workspace).join(delimiter),
    CI: '1',
    NO_COLOR: '1',
    NPM_CONFIG_USERCONFIG: windows ? '\\\\.\\NUL' : '/dev/stdin',
    NPM_CONFIG_GLOBALCONFIG: windows ? '\\\\?\\NUL' : '/dev/null',
    NPM_CONFIG_LOGS_MAX: '0',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  }
  for (const key of ['SystemRoot', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP', 'LANG', 'LC_ALL']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  if (windows && env.SystemRoot) env.ComSpec = join(env.SystemRoot, 'System32', 'cmd.exe')
  if (invocation?.electronNode) env.ELECTRON_RUN_AS_NODE = '1'
  if (invocation?.git) {
    env.GIT_CONFIG_NOSYSTEM = '1'
    env.GIT_CONFIG_GLOBAL = windows ? 'NUL' : '/dev/null'
    env.GIT_TERMINAL_PROMPT = '0'
    env.GIT_NO_LAZY_FETCH = '1'
    env.GIT_ALLOW_PROTOCOL = ''
  }
  return env
}

export function redactProcessOutput(text: string, truncated = false): string {
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 8 ||
      !/(?:API|ACCESS|PRIVATE)[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION/iu.test(key)) continue
    text = text.replaceAll(value, '[redacted]')
    if (truncated) {
      const prefix = value.slice(0, 8)
      for (let index = text.indexOf(prefix, Math.max(0, text.length - value.length + 1)); index >= 0;
        index = text.indexOf(prefix, index + 1)) {
        if (value.startsWith(text.slice(index))) {
          text = text.slice(0, index) + '[redacted]'
          break
        }
      }
    }
  }
  text = text
    .replace(/\b(Authorization["']?\s*[:=]\s*["']?(?:Bearer|Basic)\s+)[^\s"']+/giu, '$1[redacted]')
    .replace(/\b(?:sk[-_][\w-]{16,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[\w-]{20,}|AKIA[A-Z0-9]{16})\b/gu, '[redacted]')
  if (truncated) {
    text = text
      .replace(/\b(Authorization["']?\s*[:=]\s*["']?(?:Bearer|Basic)\s+)[^\s"']*$/iu, '$1[redacted]')
      .replace(/\b(?:sk[-_][\w-]{3,}|gh[pousr]_[a-z0-9]{3,}|github_pat_[\w-]{3,}|AKIA[A-Z0-9]{4,})$/u, '[redacted]')
  }
  return text
}

function redactLeadingCutSecret(text: string): string {
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 8 ||
      !/(?:API|ACCESS|PRIVATE)[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION/iu.test(key)) continue
    const maxCut = Math.min(value.length - 1, text.length)
    for (let len = maxCut; len >= 8; len--) {
      if (value.endsWith(text.slice(0, len))) {
        return '[redacted]' + text.slice(len)
      }
    }
  }
  return text
}

function trimUtf8End(buffer: Buffer): Buffer {
  if (!buffer.length) return buffer
  let i = buffer.length - 1
  while (i >= 0 && i >= buffer.length - 4 && (buffer[i]! & 0xc0) === 0x80) i--
  if (i < 0) return buffer
  const lead = buffer[i]!
  const expected = (lead & 0x80) === 0 ? 1
    : (lead & 0xe0) === 0xc0 ? 2
      : (lead & 0xf0) === 0xe0 ? 3
        : (lead & 0xf8) === 0xf0 ? 4 : 1
  return i + expected > buffer.length ? buffer.subarray(0, i) : buffer
}

function trimUtf8Start(buffer: Buffer): Buffer {
  let start = 0
  while (start < buffer.length && start < 3 && (buffer[start]! & 0xc0) === 0x80) start++
  return start > 0 ? buffer.subarray(start) : buffer
}

interface TrackedErrorLine {
  startOffset: number
  endOffset: number
  text: string
}

class ChannelCapture {
  totalBytes = 0
  truncated = false
  #headChunks: Buffer[] = []
  #headBytes = 0
  #tailChunks: Buffer[] = []
  #tailBytes = 0
  #lineStartOffset = 0
  #lineChunks: Buffer[] = []
  #lineBytes = 0
  #lineOversized = false
  #errors: TrackedErrorLine[] = []
  #seenErrors = new Set<string>()
  #errorBytes = 0

  push(chunk: Buffer): void {
    const chunkStart = this.totalBytes
    this.totalBytes += chunk.length
    if (this.totalBytes > outputLimit) this.truncated = true

    if (this.#headBytes < outputLimit) {
      const take = Math.min(outputLimit - this.#headBytes, chunk.length)
      this.#headChunks.push(chunk.subarray(0, take))
      this.#headBytes += take
    }

    if (chunk.length >= tailOutputLimit) {
      this.#tailChunks = [chunk.subarray(chunk.length - tailOutputLimit)]
      this.#tailBytes = tailOutputLimit
    } else {
      this.#tailChunks.push(chunk)
      this.#tailBytes += chunk.length
      while (this.#tailBytes > tailOutputLimit) {
        const excess = this.#tailBytes - tailOutputLimit
        const first = this.#tailChunks[0]!
        if (first.length <= excess) {
          this.#tailBytes -= first.length
          this.#tailChunks.shift()
        } else {
          this.#tailChunks[0] = first.subarray(excess)
          this.#tailBytes -= excess
        }
      }
    }

    this.#scanDiagnostics(chunk, chunkStart)
  }

  #scanDiagnostics(chunk: Buffer, chunkStart: number): void {
    let offset = 0
    while (offset < chunk.length) {
      const nl = chunk.indexOf(0x0a, offset)
      if (nl < 0) {
        const remaining = chunk.length - offset
        if (!this.#lineOversized && this.#lineBytes + remaining <= maxTrackedLineBytes) {
          this.#lineChunks.push(chunk.subarray(offset))
          this.#lineBytes += remaining
        } else {
          this.#lineOversized = true
          this.#lineChunks = []
          this.#lineBytes = 0
        }
        break
      }
      const part = chunk.subarray(offset, nl)
      const endOffset = chunkStart + nl + 1
      if (!this.#lineOversized && this.#lineBytes + part.length <= maxTrackedLineBytes &&
        this.#lineStartOffset >= headOutputLimit / 2) {
        const rawLine = Buffer.concat([...this.#lineChunks, part], this.#lineBytes + part.length)
        if (!rawLine.includes(0)) {
          this.#recordError(this.#lineStartOffset, endOffset, rawLine.toString('utf8'))
        }
      }
      this.#lineStartOffset = endOffset
      this.#lineChunks = []
      this.#lineBytes = 0
      this.#lineOversized = false
      offset = nl + 1
    }
  }

  #recordError(startOffset: number, endOffset: number, rawLine: string): void {
    if (this.#errors.length >= maxErrorLines * 2 || this.#errorBytes >= errorOutputLimit * 2) return
    const clean = rawLine.replace(/\r$/u, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, '')
    if (!clean.trim() || !diagnosticLinePattern.test(clean)) return
    const redacted = redactProcessOutput(clean).slice(0, 300)
    if (this.#seenErrors.has(redacted)) return
    this.#seenErrors.add(redacted)
    this.#errorBytes += Buffer.byteLength(redacted) + 1
    this.#errors.push({ startOffset, endOffset, text: redacted })
  }

  render(): string {
    if (!this.truncated) {
      return Buffer.concat(this.#headChunks, this.#headBytes).toString('utf8')
    }
    const rawHead = Buffer.concat(this.#headChunks, this.#headBytes).subarray(0, headOutputLimit)
    let headBuf = trimUtf8End(rawHead)
    const rawTail = Buffer.concat(this.#tailChunks, this.#tailBytes)
    const rawTailStart = this.totalBytes - rawTail.length
    const overlap = Math.max(0, headBuf.length - rawTailStart)
    let tailBuf = trimUtf8Start(rawTail.subarray(overlap))

    if (headBuf.includes(0) || tailBuf.includes(0)) {
      const lastNul = headBuf.lastIndexOf(0)
      if (lastNul >= 0) headBuf = headBuf.subarray(lastNul + 1)
      const firstNul = tailBuf.indexOf(0)
      if (firstNul >= 0) tailBuf = tailBuf.subarray(firstNul + 1)
      const headStr = redactProcessOutput(headBuf.toString('utf8'), true)
      let tailStr = redactProcessOutput(tailBuf.toString('utf8'), false)
      const omitted = Math.max(0, this.totalBytes - headBuf.length - tailBuf.length)
      const marker = `\n... [truncated ${omitted} bytes] ...\0`
      const maxTail = Math.max(0, outputLimit - Buffer.byteLength(headStr) - Buffer.byteLength(marker))
      if (Buffer.byteLength(tailStr) > maxTail) {
        const sliced = trimUtf8Start(Buffer.from(tailStr, 'utf8').subarray(Buffer.byteLength(tailStr) - maxTail))
        const nul = sliced.indexOf(0)
        tailStr = (nul >= 0 ? sliced.subarray(nul + 1) : sliced).toString('utf8')
      }
      return headStr + marker + tailStr
    }

    let headStr = headBuf.toString('utf8')
    const lastHeadNl = headStr.lastIndexOf('\n')
    if (lastHeadNl >= 512) headStr = headStr.slice(0, lastHeadNl + 1)
    const headByteLen = Buffer.byteLength(headStr)
    headStr = redactProcessOutput(headStr, !headStr.endsWith('\n'))

    let tailStr = tailBuf.toString('utf8')
    const firstTailNl = tailStr.indexOf('\n')
    if (firstTailNl >= 0 && firstTailNl < tailStr.length - 1) {
      tailStr = tailStr.slice(firstTailNl + 1)
    } else {
      tailStr = redactLeadingCutSecret(tailStr)
    }
    const tailByteStart = this.totalBytes - Buffer.byteLength(tailStr)
    tailStr = redactProcessOutput(tailStr, false)

    const keptErrors: string[] = []
    let keptErrorBytes = 0
    for (const item of this.#errors) {
      if (item.startOffset < headByteLen || item.endOffset > tailByteStart) continue
      const size = Buffer.byteLength(item.text) + 1
      if (keptErrors.length >= maxErrorLines || keptErrorBytes + size > errorOutputLimit) break
      keptErrors.push(item.text)
      keptErrorBytes += size
    }

    const omittedBytes = Math.max(0, this.totalBytes - headByteLen - Buffer.byteLength(tailStr))
    const prefix = headStr.endsWith('\n') || !headStr.length ? '' : '\n'
    const notice = keptErrors.length
      ? `${prefix}... [truncated ${omittedBytes} bytes; showing head, ${keptErrors.length} key diagnostic line(s), and tail] ...\n${keptErrors.join('\n')}\n... [tail] ...\n`
      : `${prefix}... [truncated ${omittedBytes} bytes; showing head and tail] ...\n`

    const maxTailAllowed = Math.max(0, outputLimit - Buffer.byteLength(headStr) - Buffer.byteLength(notice))
    if (Buffer.byteLength(tailStr) > maxTailAllowed) {
      const tailBytesBuf = Buffer.from(tailStr, 'utf8')
      const trimmed = trimUtf8Start(tailBytesBuf.subarray(tailBytesBuf.length - maxTailAllowed))
      let candidate = trimmed.toString('utf8')
      const nl = candidate.indexOf('\n')
      if (nl >= 0 && nl < candidate.length - 1) candidate = candidate.slice(nl + 1)
      tailStr = candidate
    }
    return headStr + notice + tailStr
  }
}

interface ProcessOutput {
  state: 'exited'
  code: number
  stdout: string
  stderr: string
  truncated: boolean
}

export class UnknownProcessEffect extends Error {}

export function runWorkspaceProcess(invocation: Invocation, cwd: string, workspace: string,
  signal?: AbortSignal): Promise<ProcessOutput | { state: 'unavailable' | 'cancelled' }> {
  if (signal?.aborted) return Promise.resolve({ state: 'cancelled' })
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      env: processEnvironment(workspace, invocation),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !windows,
      shell: false,
      windowsHide: true,
    })
    const captures = { stdout: new ChannelCapture(), stderr: new ChannelCapture() }
    let truncated = false
    let finished = false
    let stopping = false
    let cleanupPending = false
    let closed = false
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined
    for (const channel of ['stdout', 'stderr'] as const) {
      child[channel].on('error', () => { truncated = true })
      child[channel].on('data', (chunk: Buffer) => {
        captures[channel].push(chunk)
      })
    }
    const finish = (code: number | null, unavailable = false) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      clearTimeout(cleanupTimer)
      signal?.removeEventListener('abort', stop)
      if (stopping || (!unavailable && code === null)) {
        reject(new UnknownProcessEffect('Project command stopped without a confirmed result'))
      } else if (unavailable) {
        resolve({ state: 'unavailable' })
      } else {
        resolve({
          state: 'exited', code: code!,
          stdout: captures.stdout.render(),
          stderr: captures.stderr.render(),
          truncated: truncated || captures.stdout.truncated || captures.stderr.truncated,
        })
      }
    }
    const stop = () => {
      if (finished || stopping || child.pid === undefined) return
      stopping = true
      const pid = child.pid
      if (windows && process.env.SystemRoot) {
        cleanupPending = true
        const killer = spawn(join(process.env.SystemRoot, 'System32', 'taskkill.exe'),
          ['/pid', String(pid), '/t', '/f'], {
            env: processEnvironment(workspace), stdio: 'ignore', windowsHide: true, shell: false,
          })
        killer.unref()
        killer.once('error', () => { child.kill() })
        killer.once('close', (code) => {
          cleanupPending = false
          if (code !== 0) child.kill()
          if (closed) finish(null)
        })
      } else {
        try {
          process.kill(windows ? pid : -pid, 'SIGKILL')
        } catch {
          child.kill()
        }
      }
      cleanupTimer = setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
        child.unref()
        finish(null)
      }, 3000)
    }
    const timer = setTimeout(stop, commandTimeoutMs)
    signal?.addEventListener('abort', stop, { once: true })
    child.once('error', () => { finish(null, child.pid === undefined) })
    child.once('close', (code) => {
      closed = true
      if (!cleanupPending) finish(code)
    })
  })
}
