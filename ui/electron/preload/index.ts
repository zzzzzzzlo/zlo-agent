import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { windowChannels } from '../window-api'
import type { WindowApi } from '../window-api'

const windowApi: WindowApi = {
  minimize: () => ipcRenderer.invoke(windowChannels.minimize),
  toggleMaximize: () => ipcRenderer.invoke(windowChannels.toggleMaximize),
  close: () => ipcRenderer.invoke(windowChannels.close),
  isMaximized: () => ipcRenderer.invoke(windowChannels.maximized),
  onMaximizedChange(listener) {
    const receive = (_event: IpcRendererEvent, maximized: boolean) => listener(maximized)
    ipcRenderer.on(windowChannels.changed, receive)
    return () => ipcRenderer.removeListener(windowChannels.changed, receive)
  },
}

contextBridge.exposeInMainWorld('desktopWindow', windowApi)
