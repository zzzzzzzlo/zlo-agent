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
const windows = process.platform === 'win32'

export function parseProjectCommand(input: unknown): ProjectCommand {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid project command')
  const { command, path, args } = input as Record<string, unknown>
  if (Object.keys(input).some((key) => !['command', 'path', 'args'].includes(key)) ||
    typeof path !== 'string' || !path || path.length > 512 || path.includes('\0')) {
    throw new Error('Invalid project command path or arguments')
  }
  if (command === 'node_script') {
    if (args !== undefined && (!Array.isArray(args) || args.length > 16 ||
      !args.every((arg: unknown) => typeof arg === 'string' && arg.length <= 1024 && !arg.includes('\0')))) {
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
      '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=' + (windows ? 'NUL' : '/dev/null'),
      ...args,
    ],
  }
}

function processEnvironment(workspace: string, invocation?: Invocation): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: trustedPath(workspace).join(delimiter),
    CI: '1',
    NO_COLOR: '1',
    NPM_CONFIG_USERCONFIG: windows ? 'NUL.txt' : '/dev/stdin',
    NPM_CONFIG_GLOBALCONFIG: windows ? 'NUL' : '/dev/null',
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
  return text
    .replace(/\b(Authorization["']?\s*[:=]\s*["']?(?:Bearer|Basic)\s+)[^\s"']+/giu, '$1[redacted]')
    .replace(/\b(?:sk[-_][\w-]{16,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[\w-]{20,}|AKIA[A-Z0-9]{16})\b/gu, '[redacted]')
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
    const buffers = { stdout: Buffer.alloc(outputLimit), stderr: Buffer.alloc(outputLimit) }
    const sizes = { stdout: 0, stderr: 0 }
    let truncated = false
    let finished = false
    let stopping = false
    let cleanupPending = false
    let closed = false
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined
    for (const channel of ['stdout', 'stderr'] as const) {
      child[channel].on('error', () => { truncated = true })
      child[channel].on('data', (chunk: Buffer) => {
        const available = outputLimit - sizes[channel]
        sizes[channel] += chunk.copy(buffers[channel], sizes[channel], 0, available)
        if (chunk.length > available) truncated = true
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
          stdout: buffers.stdout.toString('utf8', 0, sizes.stdout),
          stderr: buffers.stderr.toString('utf8', 0, sizes.stderr),
          truncated,
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
