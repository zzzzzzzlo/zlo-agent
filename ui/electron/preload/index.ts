import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { windowChannels } from '../window-api'
import type { WindowApi } from '../window-api'
import { agentChannels, chatGptChannels, managementChannels, providerSetupChannels } from '../agent-channels.ts'
import type { DesktopProviderSetupApi } from '../../../shared/contracts/provider-setup.ts'
import type { DesktopChatGptApi } from '../../../shared/contracts/chatgpt.ts'
import type { ConversationEvent, DesktopHostApi, DesktopHostStatus } from '../../../shared/contracts/desktop.ts'
import type { DesktopManagementApi } from '../../../shared/contracts/management.ts'

const windowApi: WindowApi = {
  minimize: () => ipcRenderer.invoke(windowChannels.minimize),
  toggleMaximize: () => ipcRenderer.invoke(windowChannels.toggleMaximize),
  close: () => ipcRenderer.invoke(windowChannels.close),
  isMaximized: () => ipcRenderer.invoke(windowChannels.maximized),
  openExternalLink: (url) => ipcRenderer.invoke(windowChannels.openExternalLink, url),
  onMaximizedChange(listener) {
    const receive = (_event: IpcRendererEvent, maximized: boolean) => listener(maximized)
    ipcRenderer.on(windowChannels.changed, receive)
    return () => ipcRenderer.removeListener(windowChannels.changed, receive)
  },
}

contextBridge.exposeInMainWorld('desktopWindow', windowApi)

const agentHost: DesktopHostApi = {
  getStatus: () => ipcRenderer.invoke(agentChannels.getStatus),
  restart: () => ipcRenderer.invoke(agentChannels.restart),
  chooseWorkspace: () => ipcRenderer.invoke(agentChannels.chooseWorkspace),
  createConversation: (input) => ipcRenderer.invoke(agentChannels.createConversation, input),
  listConversations: () => ipcRenderer.invoke(agentChannels.listConversations),
  getConversation: (input) => ipcRenderer.invoke(agentChannels.getConversation, input),
  getHistory: (input) => ipcRenderer.invoke(agentChannels.getHistory, input),
  sendMessage: (input) => ipcRenderer.invoke(agentChannels.sendMessage, input),
  steerConversation: (input) => ipcRenderer.invoke(agentChannels.steerConversation, input),
  stopConversation: (input) => ipcRenderer.invoke(agentChannels.stopConversation, input),
  resumeConversation: (input) => ipcRenderer.invoke(agentChannels.resumeConversation, input),
  setConversationModel: (input) => ipcRenderer.invoke(agentChannels.setConversationModel, input),
  renameConversation: (input) => ipcRenderer.invoke(agentChannels.renameConversation, input),
  archiveConversation: (input) => ipcRenderer.invoke(agentChannels.archiveConversation, input),
  watchConversation: (input) => ipcRenderer.invoke(agentChannels.watchConversation, input),
  unwatchConversation: (input) => ipcRenderer.invoke(agentChannels.unwatchConversation, input),
  onEvent(listener) {
    const receive = (_event: IpcRendererEvent, value: ConversationEvent) => listener(value)
    ipcRenderer.on(agentChannels.event, receive)
    return () => ipcRenderer.removeListener(agentChannels.event, receive)
  },
  onStatus(listener) {
    const receive = (_event: IpcRendererEvent, value: DesktopHostStatus) => listener(value)
    ipcRenderer.on(agentChannels.status, receive)
    return () => ipcRenderer.removeListener(agentChannels.status, receive)
  },
}
contextBridge.exposeInMainWorld('agentHost', agentHost)

const agentManagement: DesktopManagementApi = {
  snapshot: input => ipcRenderer.invoke(managementChannels.snapshot, input),
  conversationObservatory: input => ipcRenderer.invoke(managementChannels.conversationObservatory, input),
  recentDiagnostics: () => ipcRenderer.invoke(managementChannels.recentDiagnostics, undefined),
  savePreferences: input => ipcRenderer.invoke(managementChannels.savePreferences, input),
  setWorkspaceAccess: input => ipcRenderer.invoke(managementChannels.setWorkspaceAccess, input),
  setProviderKey: input => ipcRenderer.invoke(managementChannels.setProviderKey, input),
  testProvider: input => ipcRenderer.invoke(managementChannels.testProvider, input),
  removeProviderKey: input => ipcRenderer.invoke(managementChannels.removeProviderKey, input),
  getJevStatus: () => ipcRenderer.invoke(managementChannels.getJevStatus, undefined),
  saveJevSettings: input => ipcRenderer.invoke(managementChannels.saveJevSettings, input),
  setJevKey: () => ipcRenderer.invoke(managementChannels.setJevKey, undefined),
  removeJevKey: () => ipcRenderer.invoke(managementChannels.removeJevKey, undefined),
  testJevConnection: () => ipcRenderer.invoke(managementChannels.testJevConnection, undefined),
  deleteMemory: input => ipcRenderer.invoke(managementChannels.deleteMemory, input),
  reconcile: input => ipcRenderer.invoke(managementChannels.reconcile, input),
}
contextBridge.exposeInMainWorld('agentManagement', agentManagement)

const agentChatGpt: DesktopChatGptApi = {
  status: () => ipcRenderer.invoke(chatGptChannels.status),
  signIn: input => ipcRenderer.invoke(chatGptChannels.signIn, input),
  cancelSignIn: () => ipcRenderer.invoke(chatGptChannels.cancelSignIn),
  signOut: () => ipcRenderer.invoke(chatGptChannels.signOut),
}
contextBridge.exposeInMainWorld('agentChatGpt', agentChatGpt)

const providerSetup: DesktopProviderSetupApi = {
  listCustom: () => ipcRenderer.invoke(providerSetupChannels.listCustom),
  saveCustom: input => ipcRenderer.invoke(providerSetupChannels.saveCustom, input),
  setCustomKey: input => ipcRenderer.invoke(providerSetupChannels.setCustomKey, input),
  removeCustomKey: input => ipcRenderer.invoke(providerSetupChannels.removeCustomKey, input),
  deleteCustom: input => ipcRenderer.invoke(providerSetupChannels.deleteCustom, input),
  testCustom: input => ipcRenderer.invoke(providerSetupChannels.testCustom, input),
  grokStatus: () => ipcRenderer.invoke(providerSetupChannels.grokStatus),
  grokSignIn: () => ipcRenderer.invoke(providerSetupChannels.grokSignIn),
  grokCancel: () => ipcRenderer.invoke(providerSetupChannels.grokCancel),
  grokSignOut: () => ipcRenderer.invoke(providerSetupChannels.grokSignOut),
}
contextBridge.exposeInMainWorld('agentProviderSetup', providerSetup)
