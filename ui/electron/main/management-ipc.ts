import { lstat, realpath } from 'node:fs/promises'
import { parse } from 'node:path'
import { dialog, ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { ConversationSummary } from '../../../shared/contracts/desktop.ts'
import type { WorkspaceAccess } from '../../../shared/contracts/domain.ts'
import type { AgentPreferences, ManagedProvider, ManagementSnapshot, ProviderId } from '../../../shared/contracts/management.ts'
import type { DiagnosticEntry } from '../../../shared/diagnostics.ts'
import { managementChannels } from '../agent-channels.ts'
import { directoryOverlaps, entityId, localDirectory, modelRoute, noInput, object } from './agent-input.ts'
import { HostTransportError } from './host-process.ts'
import type { HostProcessManager } from './host-process.ts'
import { captureProviderKey, ProviderCredentialError } from './provider-credentials.ts'
import type { SecureProviderCredentials } from './provider-credentials.ts'

const ranks = { read: 0, write: 1, trusted: 2 }

function invalid(): never {
  throw new HostTransportError('INVALID_INPUT', '管理请求的参数无效。')
}

function access(value: unknown): WorkspaceAccess {
  if (value !== 'read' && value !== 'write' && value !== 'trusted') return invalid()
  return value
}

function provider(value: unknown): ProviderId {
  if (value !== 'openai' && value !== 'anthropic' && value !== 'deepseek' && value !== 'google') return invalid()
  return value
}

function preferences(value: unknown): AgentPreferences {
  const input = object(value, ['workspaceAccess', 'defaultRoute', 'modelSelection', 'disabledTools', 'searchProvider'])
  const { modelSelection, disabledTools, searchProvider } = input
  if ((modelSelection !== 'automatic' && modelSelection !== 'fixed') ||
    (searchProvider !== 'hacker_news' && searchProvider !== 'brave' && searchProvider !== 'disabled') ||
    !Array.isArray(disabledTools) || disabledTools.length > 128 ||
    disabledTools.some(name => typeof name !== 'string' || !/^[a-z][a-z_0-9]{0,63}$/u.test(name))) return invalid()
  return { workspaceAccess: access(input.workspaceAccess), defaultRoute: input.defaultRoute === null ? null : modelRoute(input.defaultRoute),
    disabledTools, modelSelection, searchProvider }
}

async function directoryIdentity(path: string): Promise<string> {
  if (!localDirectory(path) || path === parse(path).root || await realpath(path) !== path) return invalid()
  const stat = await lstat(path, { bigint: true })
  if (!stat.isDirectory() || stat.ino === 0n) return invalid()
  return stat.dev + ':' + stat.ino
}

export function registerManagementIpc(options: {
  host: HostProcessManager
  credentials: SecureProviderCredentials
  version: string
  windowFor(event: IpcMainInvokeEvent): BrowserWindow
  protectedPaths: string[]
  defaultWorkspace: string
  recentDiagnostics(): Promise<DiagnosticEntry[]>
}): void {
  const { host } = options
  let mutating = false
  const snapshot = (conversationId?: string) =>
    host.request<Omit<ManagementSnapshot, 'version' | 'diagnostics'>>({ schemaVersion: 1, type: 'managementSnapshot', conversationId })
  const diagnostics = async () => (await options.recentDiagnostics()).map(({ time, code, module, correlationId, level, category, summary }) =>
    ({ timestamp: time, code, module, correlationId, level, category, summary }))

  const mutate = async <T>(action: () => Promise<T>) => {
    if (mutating) throw new HostTransportError('CONFLICT', '请先完成正在处理的设置操作。')
    mutating = true
    try { return await action() } finally { mutating = false }
  }

  function register(method: keyof typeof managementChannels, handler: (window: BrowserWindow, value: unknown) => Promise<unknown>) {
    ipcMain.handle(managementChannels[method], async (event, ...args: unknown[]) => {
      const window = options.windowFor(event)
      try {
        if (args.length !== 1) return invalid()
        return await handler(window, args[0])
      } catch (error) {
        if (error instanceof HostTransportError) throw new Error('[' + error.code + '] ' + error.message)
        if (error instanceof ProviderCredentialError) throw new Error('[INTERNAL] ' + error.message)
        throw new Error('[INTERNAL] 无法完成管理请求。')
      }
    })
  }

  async function confirm(window: BrowserWindow, title: string, message: string, detail?: string) {
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning', title, message, detail, buttons: ['取消', '确认'],
      defaultId: 0, cancelId: 0, noLink: true,
    })
    if (response !== 1 || window.isDestroyed()) throw new HostTransportError('CONFLICT', '操作已取消。')
  }

  register('snapshot', async (_window, value) => {
    const { conversationId } = object(value, ['conversationId'])
    const [result, entries] = await Promise.all([
      snapshot(conversationId === undefined ? undefined : entityId(conversationId)), diagnostics(),
    ])
    return { ...result, version: options.version, diagnostics: entries }
  })
  register('recentDiagnostics', async (_window, value) => {
    noInput(value)
    return diagnostics()
  })

  register('savePreferences', (window, value) => mutate(async () => {
    const next = preferences(value)
    const current = (await snapshot()).preferences
    if (ranks[next.workspaceAccess] > ranks[current.workspaceAccess] ||
      current.disabledTools.some(tool => !next.disabledTools.includes(tool)) ||
      (current.searchProvider === 'disabled' && next.searchProvider !== 'disabled')) {
      await confirm(window, '确认更改执行策略', '允许新会话或现有任务按新策略使用相关权限？',
        '信任项目脚本仍需对具体工作区单独授权。')
    }
    return host.request({ schemaVersion: 1, type: 'saveAgentPreferences', preferences: next })
  }))

  register('setWorkspaceAccess', (window, value) => mutate(async () => {
    const input = object(value, ['conversationId', 'access'])
    const conversationId = entityId(input.conversationId)
    const next = access(input.access)
    const conversation = await host.request<ConversationSummary>({ schemaVersion: 1, type: 'getConversation', conversationId })
    const current = conversation.workspaceAccess ?? (conversation.check ? 'write' : 'read')
    if (ranks[next] > ranks[current]) {
      const path = conversation.workspace
      const identity = await directoryIdentity(path)
      const protectedPaths = await Promise.all(options.protectedPaths.map(item => realpath(item).catch(() => item)))
      if (protectedPaths.some(item => directoryOverlaps(item, path)) &&
        !(next === 'write' && path === await realpath(options.defaultWorkspace))) return invalid()
      await confirm(window, '授权工作区权限', next === 'trusted' ? '允许以当前系统账户权限运行项目代码？' : '允许此会话修改工作区文件？', path)
      if (await directoryIdentity(path) !== identity) return invalid()
    }
    return host.request({ schemaVersion: 1, type: 'setWorkspaceAccess', conversationId, access: next, expected: current })
  }))

  register('testProvider', async (_window, value) => {
    const input = object(value, ['provider', 'model'])
    const id = provider(input.provider)
    const model = input.model === undefined ? undefined : modelRoute({ provider: id, model: input.model }).model
    return host.request({ schemaVersion: 1, type: 'testProviderAccount', provider: id, model })
  })

  register('setProviderKey', (window, value) => mutate(async () => {
    const id = provider(object(value, ['provider']).provider)
    const key = await captureProviderKey(window, id)
    if (key === null) throw new HostTransportError('CONFLICT', '操作已取消。')
    const result = await host.request<ManagedProvider>({ schemaVersion: 1, type: 'validateProviderKey', provider: id, key })
    if (result.connection !== 'connected') {
      throw new HostTransportError('MODEL_UNAVAILABLE', result.connection === 'unauthorized'
        ? '供应商拒绝了此 API Key。' : '暂时无法验证此 API Key。')
    }
    await options.credentials.set(id, key)
    try { return await host.request({ schemaVersion: 1, type: 'applyProviderKey', provider: id, key }) }
    catch (error) {
      await host.restart()
      throw error
    }
  }))

  register('removeProviderKey', (window, value) => mutate(async () => {
    const id = provider(object(value, ['provider']).provider)
    await confirm(window, '删除模型凭证', '删除本地凭证并停止使用该供应商的相关任务？')
    await options.credentials.set(id, null)
    try { return await host.request({ schemaVersion: 1, type: 'applyProviderKey', provider: id, key: null }) }
    catch (error) {
      await host.restart()
      throw error
    }
  }))

  register('deleteMemory', (window, value) => mutate(async () => {
    const { conversationId, ids } = object(value, ['conversationId', 'ids'])
    const id = entityId(conversationId)
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 96 ||
      ids.some(item => typeof item !== 'string' || !/^[a-f\d]{64}$/u.test(item))) return invalid()
    await confirm(window, '删除会话记忆', '删除所选记忆记录？', '这些记录将不再参与后续检索。')
    return host.request({ schemaVersion: 1, type: 'deleteConversationMemory', conversationId: id, ids })
  }))

  register('reconcile', async (_window, value) => {
    const { conversationId, taskId, operationId } = object(value, ['conversationId', 'taskId', 'operationId'])
    if (typeof operationId !== 'string' || operationId.length < 1 || operationId.length > 1024 ||
      /[\p{Cc}\p{Cf}]/u.test(operationId)) return invalid()
    return host.request({ schemaVersion: 1, type: 'reconcileOperation', conversationId: entityId(conversationId),
      taskId: entityId(taskId), operationId })
  })
}
