import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, parse } from 'node:path'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { agentChannels } from '../agent-channels.ts'
import { desktopCommand, directoryOverlaps, localDirectory, noInput } from './agent-input.ts'
import { HostTransportError } from './host-process.ts'
import type { HostProcessManager } from './host-process.ts'

const commands = [
  'createConversation', 'listConversations', 'getConversation', 'getHistory', 'sendMessage',
  'steerConversation', 'stopConversation', 'resumeConversation', 'setConversationModel', 'renameConversation',
  'archiveConversation', 'watchConversation', 'unwatchConversation',
] as const

interface DirectoryIdentity {
  dev: bigint
  ino: bigint
}

async function directoryIdentity(workspace: string): Promise<DirectoryIdentity | undefined> {
  try {
    if (await realpath(workspace) !== workspace) return undefined
    const identity = await stat(workspace, { bigint: true })
    if (identity.isDirectory()) return { dev: identity.dev, ino: identity.ino }
  } catch {
    return undefined
  }
}

export function registerAgentIpc(options: {
  host: HostProcessManager
  rendererUrl: string
  windowFor(event: IpcMainInvokeEvent): BrowserWindow
  protectedPaths: string[]
}): void {
  const { host } = options
  const selectedDirectories = new WeakMap<WebContents, Map<string, DirectoryIdentity>>()
  const pendingTrust = new WeakSet<WebContents>()

  host.setToolApprover(async (request, signal) => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (signal.aborted || !window || window.isDestroyed() || window.webContents.getURL() !== options.rendererUrl ||
      pendingTrust.has(window.webContents) || !localDirectory(request.workspace)) return { approved: false }
    if (request.kind === 'export') {
      const { canceled, filePath } = await dialog.showSaveDialog(window, {
        title: '导出工作区文件', defaultPath: request.suggestedName,
        buttonLabel: '导出', properties: ['showOverwriteConfirmation'],
      })
      if (signal.aborted || canceled || !filePath || !localDirectory(filePath) || window.isDestroyed() ||
        window.webContents.getURL() !== options.rendererUrl) return { approved: false }
      const directory = await realpath(dirname(filePath))
      const destination = join(directory, basename(filePath))
      const protectedPaths = await Promise.all(options.protectedPaths.map(path => realpath(path).catch(() => path)))
      if (protectedPaths.some(path => directoryOverlaps(path, destination))) return { approved: false }
      return { approved: true, destination }
    }
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning', title: '授权 Agent 工具', message: '仅允许本次操作？',
      detail: request.tool + '\n' + request.workspace + '\n\n' + request.detail +
        (request.kind === 'shell' ? '\n\n命令按当前系统账户权限运行。' : ''),
      buttons: ['拒绝', '允许本次'], defaultId: 0, cancelId: 0, noLink: true, signal,
    })
    return { approved: !signal.aborted && response === 1 && !window.isDestroyed() &&
      window.webContents.getURL() === options.rendererUrl ? true : false }
  })

  async function checkWorkspace(window: BrowserWindow, workspace: string, expected?: DirectoryIdentity): Promise<DirectoryIdentity> {
    const current = await directoryIdentity(workspace)
    const selected = window.isDestroyed() ? undefined : selectedDirectories.get(window.webContents)?.get(workspace)
    if (!current || !selected || current.dev !== selected.dev || current.ino !== selected.ino ||
      (expected && selected !== expected) || window.webContents.getURL() !== options.rendererUrl) {
      throw new HostTransportError('INVALID_INPUT', '工作区路径已改变，请重新选择。')
    }
    return selected
  }

  async function confirmTrustedWorkspace(window: BrowserWindow, workspace: string): Promise<void> {
    const contents = window.webContents
    if (pendingTrust.has(contents)) throw new HostTransportError('CONFLICT', '请先处理正在等待的项目授权。')
    pendingTrust.add(contents)
    try {
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        title: '授权运行项目代码',
        message: '是否允许本会话运行此工作区的项目脚本？',
        detail: workspace + '\n\n项目脚本以当前用户身份运行，可以访问该用户有权访问的文件和网络。仅对你信任的项目授权。',
        buttons: ['取消', '信任并允许执行'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      if (response !== 1) throw new HostTransportError('INVALID_INPUT', '已取消运行项目代码的授权。')
    } finally {
      pendingTrust.delete(contents)
    }
  }

  function register(channel: string, invoke: (window: BrowserWindow, value: unknown) => unknown) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      const window = options.windowFor(event)
      try {
        if (args.length > 1) throw new HostTransportError('INVALID_INPUT', '请求参数无效。')
        return await invoke(window, args[0])
      } catch (error) {
        if (error instanceof HostTransportError) throw new Error('[' + error.code + '] ' + error.message)
        throw new Error('[INTERNAL] 桌面端无法完成请求。')
      }
    })
  }

  register(agentChannels.getStatus, (_window, input) => {
    noInput(input)
    return host.status
  })
  register(agentChannels.restart, (_window, input) => {
    noInput(input)
    return host.restart()
  })
  register(agentChannels.chooseWorkspace, async (window, input) => {
    noInput(input)
    const { canceled, filePaths } = await dialog.showOpenDialog(window, {
      title: '选择 Zlo Agent 工作区',
      properties: ['openDirectory'],
    })
    if (canceled || !filePaths[0] || window.isDestroyed()) return null
    const workspace = await realpath(filePaths[0])
    const protectedPaths = await Promise.all(options.protectedPaths.map((path) => realpath(path).catch(() => path)))
    const identity = await directoryIdentity(workspace)
    if (!localDirectory(workspace) || workspace === parse(workspace).root || !identity
      || protectedPaths.some((path) => directoryOverlaps(path, workspace))) {
      throw new HostTransportError('INVALID_INPUT', '请选择本地磁盘上的独立工作区目录。')
    }
    if (window.isDestroyed() || window.webContents.getURL() !== options.rendererUrl) return null
    let selected = selectedDirectories.get(window.webContents)
    if (!selected) {
      selected = new Map()
      selectedDirectories.set(window.webContents, selected)
      const contents = window.webContents
      contents.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) selectedDirectories.get(contents)?.clear()
      })
    }
    selected.set(workspace, identity)
    return workspace
  })

  for (const method of commands) {
    register(agentChannels[method], async (window, input) => {
      const selected = selectedDirectories.get(window.webContents)
      const command = desktopCommand(method, input, (workspace) => selected?.has(workspace) ?? false)
      if (command.type === 'createConversation' && command.workspace) {
        const grant = await checkWorkspace(window, command.workspace)
        if (command.workspaceAccess === 'trusted') {
          await confirmTrustedWorkspace(window, command.workspace)
          await checkWorkspace(window, command.workspace, grant)
        }
      }
      return host.request(command)
    })
  }

  function broadcast(channel: string, payload: unknown) {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.getURL() !== options.rendererUrl) continue
      try { window.webContents.send(channel, payload) } catch { /* The renderer may be closing. */ }
    }
  }

  host.onStatus((status) => { broadcast(agentChannels.status, status) })
  host.onEvent((event) => { broadcast(agentChannels.event, event) })
}
