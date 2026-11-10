import { realpath, stat } from 'node:fs/promises'
import { parse } from 'node:path'
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

export function registerAgentIpc(options: {
  host: HostProcessManager
  rendererUrl: string
  windowFor(event: IpcMainInvokeEvent): BrowserWindow
  protectedPaths: string[]
}): void {
  const { host } = options
  const selectedDirectories = new WeakMap<WebContents, Set<string>>()

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
    if (!localDirectory(workspace) || workspace === parse(workspace).root || !(await stat(workspace)).isDirectory()
      || protectedPaths.some((path) => directoryOverlaps(path, workspace))) {
      throw new HostTransportError('INVALID_INPUT', '请选择本地磁盘上的独立工作区目录。')
    }
    if (window.isDestroyed() || window.webContents.getURL() !== options.rendererUrl) return null
    let selected = selectedDirectories.get(window.webContents)
    if (!selected) {
      selected = new Set()
      selectedDirectories.set(window.webContents, selected)
      const contents = window.webContents
      contents.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) selectedDirectories.get(contents)?.clear()
      })
    }
    selected.add(workspace)
    return workspace
  })

  for (const method of commands) {
    register(agentChannels[method], async (window, input) => {
      const selected = selectedDirectories.get(window.webContents)
      const command = desktopCommand(method, input, (workspace) => selected?.has(workspace) ?? false)
      if (command.type === 'createConversation' && command.workspace
        && (await realpath(command.workspace).catch(() => undefined)) !== command.workspace) {
        throw new HostTransportError('INVALID_INPUT', '工作区路径已改变，请重新选择。')
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
