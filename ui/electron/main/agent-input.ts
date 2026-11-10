import { isAbsolute, relative, sep } from 'node:path'
import type { ConversationAction, ConversationRef, CreateConversationInput, DesktopCommand } from '../../../shared/contracts/desktop.ts'
import { projectCommands } from '../../../shared/contracts/domain.ts'
import type { VerificationCheck } from '../../../shared/contracts/domain.ts'
import { HostTransportError } from './host-process.ts'

type ApiMethod = 'createConversation' | 'listConversations' | 'getConversation' | 'getHistory' |
  'sendMessage' | 'steerConversation' | 'stopConversation' | 'resumeConversation' |
  'setConversationModel' | 'renameConversation' | 'archiveConversation' | 'watchConversation' | 'unwatchConversation'

type Input = Record<string, unknown>

function invalid(): never {
  throw new HostTransportError('INVALID_INPUT', '请求参数无效。')
}

function object(value: unknown, fields: string[]): Input {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid()
  if (Object.keys(value).some((name) => !fields.includes(name))) return invalid()
  return value as Input
}

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) return invalid()
  return value
}

function requestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(value)) return invalid()
  return value
}

function entityId(value: unknown): string {
  if (typeof value !== 'string' || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value)) return invalid()
  return value
}

function cursor(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) return invalid()
  return value
}

export function noInput(value: unknown): void {
  if (value !== undefined) invalid()
}

function ref(input: Input): ConversationRef {
  return { conversationId: entityId(input.conversationId) }
}

function action(input: Input): ConversationAction {
  return { ...ref(input), taskId: entityId(input.taskId), requestId: requestId(input.requestId) }
}

export function localDirectory(value: string): boolean {
  if (!isAbsolute(value) || value.startsWith('\\\\') || value.startsWith('//')) return false
  return process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(value)
}

export function directoryOverlaps(left: string, right: string): boolean {
  const contains = (base: string, sub: string) => {
    const path = relative(base, sub)
    return !path || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path))
  }
  return contains(left, right) || contains(right, left)
}

function modelRoute(value: unknown) {
  const route = object(value, ['provider', 'model'])
  const provider = text(route.provider, 80)
  const model = text(route.model, 200)
  if (!/^[\w-]+$/.test(provider) || !/^[\w.:/-]+$/.test(model)) return invalid()
  return { provider, model }
}

function relativePath(value: unknown, allowRoot = false): string {
  const path = text(value, 512)
  if (allowRoot && path === '.') return path
  if (/^[\\/]|[<>:"|?*\u0000-\u001f\u007f]/u.test(path) ||
    path.split(/[\\/]/u).some((part) => !part || part === '.' || part === '..')) return invalid()
  return path
}

function verificationCheck(value: unknown, trusted: boolean): VerificationCheck {
  const check = object(value, ['path', 'contains', 'command'])
  if (!Object.hasOwn(check, 'command')) {
    const path = relativePath(check.path)
    return { path, ...(check.contains === undefined ? {} : { contains: text(check.contains, 16_000) }) }
  }
  if (!trusted || Object.hasOwn(check, 'path') || Object.hasOwn(check, 'contains')) return invalid()
  const input = object(check.command, ['command', 'path', 'args'])
  const command = projectCommands.find((candidate) => candidate === input.command)
  if (!command) return invalid()
  const path = relativePath(input.path, command !== 'node_script')
  if (input.args === undefined) return { command: { command, path } }
  if (command !== 'node_script' || !Array.isArray(input.args) || input.args.length > 16 ||
    !input.args.every((arg) => typeof arg === 'string' && arg.length <= 1024 && !arg.includes('\0'))) return invalid()
  return { command: { command, path, args: [...input.args] } }
}

function createInput(value: unknown, allowedWorkspace: (path: string) => boolean): CreateConversationInput {
  const input = object(value, ['requestId', 'title', 'workspace', 'workspaceAccess', 'route', 'check'])
  const result: CreateConversationInput = { requestId: requestId(input.requestId) }
  if (input.title !== undefined) result.title = text(input.title, 120)
  if (input.workspace !== undefined) {
    const workspace = text(input.workspace, 1_024)
    if (!localDirectory(workspace) || !allowedWorkspace(workspace)) {
      throw new HostTransportError('INVALID_INPUT', '请先通过目录选择器授权该工作区。')
    }
    result.workspace = workspace
  }
  const access = input.workspaceAccess
  if (access !== undefined) {
    if (access !== 'read' && access !== 'write' && access !== 'trusted') return invalid()
    if (access !== 'read' && !result.workspace) return invalid()
    result.workspaceAccess = access
  }
  if (input.route !== undefined) result.route = modelRoute(input.route)
  if (input.check !== undefined) {
    if (!result.workspace) return invalid()
    result.check = verificationCheck(input.check, access === 'trusted')
  }
  return result
}

const actionFields = ['conversationId', 'taskId', 'requestId']

export function desktopCommand(
  method: ApiMethod,
  value: unknown,
  allowedWorkspace: (path: string) => boolean,
): DesktopCommand {
  const schemaVersion = 1
  switch (method) {
    case 'createConversation': return { schemaVersion, type: method, ...createInput(value, allowedWorkspace) }
    case 'setConversationModel': {
      const input = object(value, ['conversationId', 'requestId', 'route'])
      return {
        schemaVersion, type: method, ...ref(input), requestId: requestId(input.requestId),
        route: input.route === null ? null : modelRoute(input.route),
      }
    }
    case 'listConversations':
      noInput(value)
      return { schemaVersion, type: method }
    case 'getConversation':
    case 'unwatchConversation':
      return {
        schemaVersion, type: method === 'getConversation' ? method : 'unsubscribeConversation',
        ...ref(object(value, ['conversationId'])),
      }
    case 'getHistory': {
      const input = object(value, ['conversationId', 'before'])
      return {
        schemaVersion, type: 'getConversationHistory', ...ref(input),
        ...(input.before === undefined ? {} : { before: cursor(input.before, 1) }),
      }
    }
    case 'sendMessage': {
      const input = object(value, ['conversationId', 'requestId', 'text'])
      return { schemaVersion, type: method, ...ref(input), requestId: requestId(input.requestId), text: text(input.text, 16_000) }
    }
    case 'steerConversation': {
      const input = object(value, [...actionFields, 'text'])
      return { schemaVersion, type: method, ...action(input), text: text(input.text, 8_000) }
    }
    case 'stopConversation':
    case 'resumeConversation':
      return { schemaVersion, type: method, ...action(object(value, actionFields)) }
    case 'renameConversation': {
      const input = object(value, ['conversationId', 'requestId', 'title'])
      return { schemaVersion, type: method, ...ref(input), requestId: requestId(input.requestId), title: text(input.title, 120) }
    }
    case 'archiveConversation': {
      const input = object(value, ['conversationId', 'requestId'])
      return { schemaVersion, type: method, ...ref(input), requestId: requestId(input.requestId) }
    }
    case 'watchConversation': {
      const input = object(value, ['conversationId', 'after'])
      return { schemaVersion, type: 'subscribeConversation', ...ref(input), after: cursor(input.after, 0) }
    }
    default: return invalid()
  }
}
