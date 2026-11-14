export const agentChannels = {
  getStatus: 'agent-host:status',
  restart: 'agent-host:restart',
  chooseWorkspace: 'agent-host:choose-workspace',
  createConversation: 'agent-host:create',
  listConversations: 'agent-host:list',
  getConversation: 'agent-host:get',
  getHistory: 'agent-host:history',
  sendMessage: 'agent-host:send',
  steerConversation: 'agent-host:steer',
  stopConversation: 'agent-host:stop',
  resumeConversation: 'agent-host:resume',
  setConversationModel: 'agent-host:set-model',
  renameConversation: 'agent-host:rename',
  archiveConversation: 'agent-host:archive',
  watchConversation: 'agent-host:watch',
  unwatchConversation: 'agent-host:unwatch',
  event: 'agent-host:event',
  status: 'agent-host:status-event',
} as const

export const managementChannels = {
  snapshot: 'agent-management:snapshot',
  conversationObservatory: 'agent-management:conversation-observatory',
  recentDiagnostics: 'agent-management:recent-diagnostics',
  savePreferences: 'agent-management:save-preferences',
  setWorkspaceAccess: 'agent-management:set-workspace-access',
  setProviderKey: 'agent-management:set-provider-key',
  testProvider: 'agent-management:test-provider',
  removeProviderKey: 'agent-management:remove-provider-key',
  getJevStatus: 'agent-management:get-jev-status',
  saveJevSettings: 'agent-management:save-jev-settings',
  setJevKey: 'agent-management:set-jev-key',
  removeJevKey: 'agent-management:remove-jev-key',
  testJevConnection: 'agent-management:test-jev-connection',
  deleteMemory: 'agent-management:delete-memory',
  reconcile: 'agent-management:reconcile',
} as const

export const chatGptChannels = {
  status: 'agent-chatgpt:status',
  signIn: 'agent-chatgpt:sign-in',
  cancelSignIn: 'agent-chatgpt:cancel',
  signOut: 'agent-chatgpt:sign-out',
} as const

export const providerSetupChannels = {
  listCustom: 'agent-provider-setup:list',
  saveCustom: 'agent-provider-setup:save',
  setCustomKey: 'agent-provider-setup:set-key',
  removeCustomKey: 'agent-provider-setup:remove-key',
  deleteCustom: 'agent-provider-setup:delete',
  testCustom: 'agent-provider-setup:test',
  grokStatus: 'agent-provider-setup:grok-status',
  grokSignIn: 'agent-provider-setup:grok-sign-in',
  grokCancel: 'agent-provider-setup:grok-cancel',
  grokSignOut: 'agent-provider-setup:grok-sign-out',
} as const
