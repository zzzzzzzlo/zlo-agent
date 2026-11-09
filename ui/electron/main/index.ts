import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, ipcMain, session } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { windowChannels } from '../window-api'

const rendererFile = join(__dirname, '../renderer/index.html')
const devUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
const rendererUrl = new URL(devUrl ?? pathToFileURL(rendererFile).href)
const supportsDesktopAcrylic = process.platform === 'win32'
  && Number(process.getSystemVersion().split('.')[2]) >= 22621

function windowFor(event: IpcMainInvokeEvent) {
  const sender = event.senderFrame
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || sender !== event.sender.mainFrame || sender?.url !== rendererUrl.href) {
    throw new Error('Invalid window control sender')
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

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  ipcMain.handle(windowChannels.minimize, (event) => windowFor(event).minimize())
  ipcMain.handle(windowChannels.close, (event) => windowFor(event).close())
  ipcMain.handle(windowChannels.maximized, (event) => windowFor(event).isMaximized())
  ipcMain.handle(windowChannels.toggleMaximize, (event) => {
    const window = windowFor(event)
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => app.quit())
