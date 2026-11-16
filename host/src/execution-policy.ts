import { basename } from 'node:path'
import type { ApprovalKind, ToolApprovalMode } from '../../shared/contracts/tool-approval.ts'
import type { WorkspaceAccess } from './contracts/domain.ts'
import { redactProcessOutput, parseProjectCommand } from './workspace-process.ts'
import { workspaceTarget } from './workspace.ts'

export interface PolicyEvaluationInput {
  tool: string
  effect: 'read' | 'write'
  approvalKind?: ApprovalKind
  input: unknown
  effectiveAccess: WorkspaceAccess
  approvalMode: ToolApprovalMode
  publicRead?: (input: unknown) => boolean
}

export type PolicyEvaluationResult =
  | { decision: 'deny'; reason: 'policy' | 'approval_safety' }
  | { decision: 'allow'; automatic: boolean }
  | { decision: 'ask' }

const safeProjectCheckCommands = new Set(['npm_test', 'npm_build', 'npm_lint', 'npm_typecheck'])
const safeNpmScripts = new Set(['test', 'build', 'lint', 'typecheck', 'check'])
const gitReadSubcommands = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'branch'])
const gitDangerousFlags = new Set([
  '-d', '-D', '-m', '-M', '-c', '-C', '-f', '--delete', '--move', '--copy', '--force',
  '--set-upstream-to', '--unset-upstream', '--edit-description',
])

function tokenizeSimpleShell(command: string): string[] | undefined {
  if (!command || command.length > 4096 || /[\r\n\0]/u.test(command)) return undefined
  const tokens: string[] = []
  let current = ''
  let quote: '\'' | '"' | null = null
  let inToken = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    if (quote === '\'') {
      if (ch === '\'') quote = null
      else current += ch
      continue
    }
    if (quote === '"') {
      if (ch === '`' || ch === '$' || ch === '%') return undefined
      if (ch === '"') quote = null
      else current += ch
      continue
    }
    if (ch === '\'' || ch === '"') {
      quote = ch
      inToken = true
      continue
    }
    if (/[;&|`<>%]/u.test(ch) || ch === '$') return undefined
    if (/\s/u.test(ch)) {
      if (inToken) {
        tokens.push(current)
        current = ''
        inToken = false
      }
      continue
    }
    current += ch
    inToken = true
  }
  if (quote !== null) return undefined
  if (inToken) tokens.push(current)
  return tokens.length ? tokens : undefined
}

function safeWorkspacePath(value: string): boolean {
  if (value === '.') return true
  if (value.startsWith('-') || value.startsWith('/') || value.startsWith('\\') || /^[a-zA-Z]:/u.test(value)) return false
  return workspaceTarget({ path: value }, 'read') !== undefined
}

const forbiddenSegment = /(?:^|[\\/])(?:\.(?:env(?:\.(?!example$|sample$|template$)[^\\/]*)?|git|husky|vscode|npmrc(?:\.(?!example$|sample$|template$)[^\\/]*)?|claude\.json)|(?:credentials?|secrets?)(?:\.[^\\/]*)?|auth\.[^\\/]*|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.[^\\/]*)?)|[\\/][^\\/]*\.(?:key|pem|pfx|p12|ppk|sqlite|db)$|\.(?:key|pem|pfx|p12|ppk|sqlite|db)$/iu

function isSafeGitArgs(args: readonly string[]): boolean {
  const [sub, ...rest] = args
  if (!sub || !gitReadSubcommands.has(sub)) return false
  for (const arg of rest) {
    const lower = arg.toLowerCase()
    if (lower === '-c' || lower === '--no-index' || lower.startsWith('--output') || lower.startsWith('--exec') ||
      lower.startsWith('--upload-pack') || lower.startsWith('--receive-pack') ||
      lower.startsWith('--git-dir') || lower.startsWith('--work-tree')) return false
    if (sub === 'branch' && gitDangerousFlags.has(arg)) return false
    if (arg.startsWith('-') || arg === '--') continue
    if (forbiddenSegment.test(arg)) return false
    const colon = arg.indexOf(':')
    if (colon >= 0) {
      const target = arg.slice(colon + 1)
      if (!target || forbiddenSegment.test(target) || !safeWorkspacePath(target)) return false
      continue
    }
    if ((arg.includes('..') || /^[a-zA-Z]:|[\\/]/u.test(arg) || arg.startsWith('.')) &&
      !(arg.includes('..') && !/[\\/]/u.test(arg) && !arg.startsWith('.'))) {
      if (!safeWorkspacePath(arg)) return false
    }
  }
  return true
}

function isSafeTscArgs(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--noEmit' || arg === '--version' || arg === '-v') continue
    if ((arg === '-p' || arg === '--project') && i + 1 < args.length && safeWorkspacePath(args[i + 1]!)) {
      i++
      continue
    }
    return false
  }
  return true
}

/**
 * Determine whether a shell_exec input represents an unchained, read-only or bounded
 * project verification command eligible for automatic approval in routine/unattended mode.
 */
export function isSafeShellCommand(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const { command, path } = input as { command?: unknown; path?: unknown }
  if (typeof command !== 'string') return false
  if (path !== undefined && (typeof path !== 'string' || !safeWorkspacePath(path))) return false
  const tokens = tokenizeSimpleShell(command)
  if (!tokens) return false
  const [rawExecutable, ...args] = tokens
  if (!rawExecutable || /[\\/]/u.test(rawExecutable)) return false
  const executable = basename(rawExecutable).toLowerCase().replace(/\.(?:exe|cmd|bat)$/u, '')

  switch (executable) {
    case 'pwd':
      return args.length === 0
    case 'ls':
    case 'dir':
      return args.every(arg => arg.startsWith('-') || safeWorkspacePath(arg))
    case 'which':
    case 'where':
      return args.length > 0 && args.every(arg => /^[a-zA-Z0-9._-]+$/u.test(arg))
    case 'git':
      return isSafeGitArgs(args)
    case 'npm':
      return (args.length === 1 && (args[0] === '-v' || args[0] === '--version' || args[0] === 'ls' || args[0] === 'test')) ||
        (args.length === 2 && args[0] === 'run' && safeNpmScripts.has(args[1]!))
    case 'pnpm':
    case 'yarn':
      return (args.length === 1 && (safeNpmScripts.has(args[0]!) || args[0] === '-v' || args[0] === '--version')) ||
        (args.length === 2 && args[0] === 'run' && safeNpmScripts.has(args[1]!))
    case 'node':
      if (args.length === 1 && (args[0] === '-v' || args[0] === '--version')) return true
      return args[0] === '--test' && args.slice(1).every(arg =>
        /^--test-(?:name-pattern|concurrency)=/u.test(arg) || safeWorkspacePath(arg))
    case 'tsc':
      return isSafeTscArgs(args)
    case 'npx':
      if (args[0] === 'tsc') return isSafeTscArgs(args.slice(1))
      return args[0] === 'vitest' && args[1] === 'run' &&
        args.slice(2).every(arg => arg === '--reporter=basic' || safeWorkspacePath(arg))
    case 'rg':
    case 'grep':
    case 'findstr': {
      if (args.some(arg => arg === '-f' || arg.startsWith('--pre') || arg.startsWith('--file') ||
        arg.startsWith('--ignore-file') || arg.startsWith('--exclude-from'))) return false
      const positional = args.filter(arg => !arg.startsWith('-'))
      return positional.length >= 1 && positional.slice(1).every(safeWorkspacePath)
    }
    case 'cat':
    case 'type':
    case 'head':
    case 'tail': {
      const files: string[] = []
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!
        if ((arg === '-n' || arg === '-c' || arg === '--lines' || arg === '--bytes') && i + 1 < args.length &&
          /^\d+$/u.test(args[i + 1]!)) {
          i++
          continue
        }
        if (!arg.startsWith('-')) files.push(arg)
      }
      return files.length >= 1 && files.every(safeWorkspacePath)
    }
    default:
      return false
  }
}

function isSafeProjectCommandInput(input: unknown): boolean {
  try {
    return safeProjectCheckCommands.has(parseProjectCommand(input).command)
  } catch {
    return false
  }
}

/**
 * Evaluate tool execution using deny -> allow -> ask semantics:
 *  1. Safety floor (secret leakage / oversized / bidi characters) always denies.
 *  2. Pre-authorized workspace execution (e.g. run_project_command under 'trusted') runs directly.
 *  3. Routine/unattended safe allowlist rules auto-approve cleanly; everything else asks or blocks.
 */
export function evaluateToolExecutionPolicy({
  tool,
  effect,
  approvalKind,
  input,
  effectiveAccess,
  approvalMode,
  publicRead,
}: PolicyEvaluationInput): PolicyEvaluationResult {
  if (!approvalKind) return { decision: 'allow', automatic: false }
  if (tool === 'run_project_command' && effectiveAccess === 'trusted') {
    return { decision: 'allow', automatic: false }
  }

  const detail = JSON.stringify(input) ?? 'null'
  if (detail.length > 8_000 || redactProcessOutput(detail) !== detail || /[\u202a-\u202e\u2066-\u2069]/u.test(detail)) {
    return { decision: 'deny', reason: 'approval_safety' }
  }

  if (approvalMode !== 'ask') {
    try {
      if (effect === 'read' && approvalKind === 'network' && publicRead?.(input) === true) {
        return { decision: 'allow', automatic: true }
      }
      if (tool === 'run_project_command' && isSafeProjectCommandInput(input)) {
        return { decision: 'allow', automatic: true }
      }
      if (tool === 'shell_exec' && isSafeShellCommand(input)) {
        return { decision: 'allow', automatic: true }
      }
    } catch {
      /* Policy classification failures fall back to explicit confirmation. */
    }
  }

  return { decision: 'ask' }
}
