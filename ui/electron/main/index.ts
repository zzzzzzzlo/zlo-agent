import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, session, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { windowChannels } from '../window-api'
import { localDirectory } from './agent-input.ts'
import { registerAgentIpc } from './agent-ipc.ts'
import { createDiagnosticLog } from './diagnostic-log.ts'
import { HostProcessManager, spawnAgentHost } from './host-process.ts'
import { registerManagementIpc } from './management-ipc.ts'
import { SecureProviderCredentials } from './provider-credentials.ts'
import { ChatGptAccount } from './chatgpt-account.ts'
import { registerChatGptIpc } from './chatgpt-ipc.ts'
import type { ManagedModel } from '../../../shared/contracts/management.ts'

const developmentData = app.isPackaged ? undefined : process.env.ZLO_AGENT_DESKTOP_DATA
if (developmentData && localDirectory(developmentData)) {
  mkdirSync(developmentData, { recursive: true })
  app.setPath('userData', resolve(developmentData))
}

const hostMode = !app.isPackaged && process.env.ZLO_AGENT_DESKTOP_MODE === 'faux' ? 'faux' : 'pi'
const hostRoot = app.isPackaged ? join(process.resourcesPath, 'agent-host') : resolve(app.getAppPath(), '../host')
const userData = app.getPath('userData')
const defaultWorkspace = join(userData, 'workspace')
const diagnostics = createDiagnosticLog(join(userData, 'logs'))
const credentials = new SecureProviderCredentials(userData)
const chatGpt = hostMode === 'pi' ? new ChatGptAccount(userData, {
  async applySession(session, quiesce): Promise<ManagedModel[]> {
    try { return await host.request({ schemaVersion: 1, type: 'applyChatGptSession', session, quiesce }) }
    catch (error) {
      if (session !== null || (await host.restart()).state !== 'ready') throw error
      return []
    }
  },
}) : undefined
const host = new HostProcessManager({
  mode: hostMode,
  diagnostic: diagnostics.write,
  async initialize() {
    return { schemaVersion: 1, type: 'initializeProviderKeys',
      credentials: hostMode === 'pi' ? await credentials.load() : {}, chatGpt: await chatGpt?.loadSession() }
  },
  spawnChild() {
    mkdirSync(defaultWorkspace, { recursive: true })
    return spawnAgentHost({
      executable: process.execPath, root: hostRoot,
      data: join(userData, 'agent-data', hostMode), defaultWorkspace, mode: hostMode,
    })
  },
})

const rendererFile = join(__dirname, '../renderer/index.html')
const devUrl = app.isPackaged || !process.env.ELECTRON_RENDERER_URL
  ? undefined : new URL(process.env.ELECTRON_RENDERER_URL)
if (devUrl && (!['http:', 'https:'].includes(devUrl.protocol)
  || !['localhost', '127.0.0.1', '[::1]'].includes(devUrl.hostname))) {
  throw new Error('Renderer development server must use a loopback address')
}
const rendererUrl = devUrl ?? pathToFileURL(rendererFile)
const supportsDesktopAcrylic = process.platform === 'win32'
  && Number(process.getSystemVersion().split('.')[2]) >= 22621

function windowFor(event: IpcMainInvokeEvent) {
  const sender = event.senderFrame
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || sender !== event.sender.mainFrame || sender?.url !== rendererUrl.href) {
    throw new Error('Invalid IPC sender')
  }
  return window
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1240, height: 800, minWidth: 680, minHeight: 520,
    title: 'Zlo Agent',
    icon: join(app.getAppPath(), 'resources/icon.png'),
    frame: false,
    transparent: !supportsDesktopAcrylic,
    backgroundColor: '#00000000',
    backgroundMaterial: supportsDesktopAcrylic ? 'acrylic' : undefined,
    roundedCorners: true,
    accentColor: false,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  const notify = () => window.webContents.send(windowChannels.changed, window.isMaximized())
  window.on('maximize', notify)
  window.on('unmaximize', notify)
  window.once('ready-to-show', () => window.show())
  void (devUrl ? window.loadURL(rendererUrl.href) : window.loadFile(rendererFile))
}

const ownsProfile = app.requestSingleInstanceLock()
if (!ownsProfile) app.exit(0)

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  ipcMain.handle(windowChannels.minimize, (event) => windowFor(event).minimize())
  ipcMain.handle(windowChannels.close, (event) => windowFor(event).close())
  ipcMain.handle(windowChannels.maximized, (event) => windowFor(event).isMaximized())
  ipcMain.handle(windowChannels.openExternalLink, async (event, value: unknown) => {
    windowFor(event)
    if (typeof value !== 'string' || value.length > 2048) return
    const url = URL.parse(value)
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return
    await shell.openExternal(url.href)
  })
  ipcMain.handle(windowChannels.toggleMaximize, (event) => {
    const window = windowFor(event)
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  const protectedPaths = app.isPackaged ? [userData, process.resourcesPath] : [userData]
  registerAgentIpc({
    host, windowFor, rendererUrl: rendererUrl.href,
    protectedPaths,
  })
  registerManagementIpc({ host, windowFor, credentials, protectedPaths, defaultWorkspace,
    version: app.getVersion(), recentDiagnostics: diagnostics.recent })
  registerChatGptIpc(chatGpt, windowFor)

  void host.start()
  createWindow()
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => app.quit())

let quitting = false
let hostClosed = false
app.on('before-quit', (event) => {
  if (hostClosed) return
  event.preventDefault()
  if (quitting) return
  quitting = true
  chatGpt?.close()
  void host.shutdown().catch(() => {
    console.error('Agent Host did not exit within the shutdown deadline.')
  }).finally(async () => {
    await diagnostics.flush(250)
    hostClosed = true
    app.quit()
  })
})
