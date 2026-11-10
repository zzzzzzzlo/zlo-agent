import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { agentChannels } from '../electron/agent-channels.ts'
import { desktopCommand, directoryOverlaps } from '../electron/main/agent-input.ts'

const denied = () => false
const workspace = resolve('permitted-workspace')
const allowed = (path: string) => path === workspace
const conversationId = '63b1d54c-af0d-4e83-9671-8fd7bda72e54'
const taskId = '60986de9-b7d9-4e9a-9390-04e6f083d5cf'

test('IPC input maps business calls to versioned commands', () => {
  assert.deepEqual(desktopCommand('listConversations', undefined, denied), {
    schemaVersion: 1, type: 'listConversations',
  })
  assert.deepEqual(desktopCommand('getHistory', { conversationId, before: 12 }, denied), {
    schemaVersion: 1, type: 'getConversationHistory', conversationId, before: 12,
  })
  assert.deepEqual(desktopCommand('watchConversation', { conversationId, after: 4 }, denied), {
    schemaVersion: 1, type: 'subscribeConversation', conversationId, after: 4,
  })
  assert.deepEqual(desktopCommand('stopConversation', { conversationId, taskId, requestId: 'req' }, denied), {
    schemaVersion: 1, type: 'stopConversation', conversationId, taskId, requestId: 'req',
  })
  const modelRequest = { conversationId, requestId: 'model-change', route: { provider: 'openai', model: 'gpt-4.1-mini' } }
  assert.deepEqual(desktopCommand('setConversationModel', modelRequest, denied), {
    schemaVersion: 1, type: 'setConversationModel', ...modelRequest,
  })
  assert.deepEqual(desktopCommand('setConversationModel', { ...modelRequest, route: null }, denied), {
    schemaVersion: 1, type: 'setConversationModel', ...modelRequest, route: null,
  })
  assert.equal(new Set(Object.values(agentChannels)).size, Object.keys(agentChannels).length)
})

test('IPC rejects malformed inputs and prevents Renderer command and path injection', () => {
  const send = { conversationId, requestId: 'r', text: '请帮我检查项目。' }
  const invalid = { code: 'INVALID_INPUT' }
  assert.throws(() => desktopCommand('listConversations', {}, denied), invalid)
  assert.throws(() => desktopCommand('sendMessage', { ...send, type: 'exit' }, denied), invalid)
  assert.throws(() => desktopCommand('sendMessage', { ...send, cwd: workspace }, denied), invalid)
  assert.throws(() => desktopCommand('sendMessage', { ...send, requestId: '\n' }, denied), invalid)
  assert.throws(() => desktopCommand('sendMessage', { ...send, text: 'x'.repeat(16_001) }, denied), invalid)
  assert.throws(() => desktopCommand('getConversation', { conversationId: 'not-a-conversation-id' }, denied), invalid)
  assert.throws(() => desktopCommand('watchConversation', { conversationId, after: -1 }, denied), invalid)
  assert.throws(() => desktopCommand('watchConversation', { conversationId, after: Infinity }, denied), invalid)
  assert.throws(() => desktopCommand('createConversation', { requestId: 'c', route: { provider: 'x', model: 'x', key: 'hidden' } }, denied), invalid)
  assert.throws(() => desktopCommand('createConversation', { requestId: 'c', workspace }, denied), invalid)
  const model = { conversationId, requestId: 'model-change' }
  assert.throws(() => desktopCommand('setConversationModel', model, denied), invalid)
  assert.throws(() => desktopCommand('setConversationModel', { ...model, route: { provider: 'x', model: 'x', token: 'hidden' } }, denied), invalid)
  assert.throws(() => desktopCommand('setConversationModel', { ...model, route: null, taskId }, denied), invalid)
})

test('IPC grants selected workspace and limits file verification to a relative path', () => {
  const request = { requestId: 'r', workspace }
  const check = { path: 'src/login.html', contains: 'form' }
  assert.deepEqual(desktopCommand('createConversation', { ...request, check }, allowed), {
    schemaVersion: 1, type: 'createConversation', ...request, check,
  })
  assert.deepEqual(desktopCommand('createConversation', { requestId: 'r' }, denied), {
    schemaVersion: 1, type: 'createConversation', requestId: 'r',
  })
  assert.throws(() => desktopCommand('createConversation', { requestId: 'r', check }, denied), { code: 'INVALID_INPUT' })
  for (const path of [workspace, '../login.html', 'src/../login.html', 'C:login.html', 'src//login.html']) {
    assert.throws(() => desktopCommand('createConversation', { ...request, check: { path } }, allowed), { code: 'INVALID_INPUT' })
  }
  assert.equal(directoryOverlaps(workspace, join(workspace, 'child')), true)
  assert.equal(directoryOverlaps(join(workspace, 'child'), workspace), true)
  assert.equal(directoryOverlaps(workspace, workspace + '-different'), false)
})

test('workspace writes are independent of acceptance and only trusted workspaces can use project checks', () => {
  const request = { requestId: 'workspace-grant', workspace }
  const invalid = { code: 'INVALID_INPUT' }
  assert.deepEqual(desktopCommand('createConversation', { ...request, workspaceAccess: 'write' }, allowed), {
    schemaVersion: 1, type: 'createConversation', ...request, workspaceAccess: 'write',
  })
  const trusted = { ...request, workspaceAccess: 'trusted' }
  const npm = { command: { command: 'npm_test', path: '.' } }
  assert.deepEqual(desktopCommand('createConversation', { ...trusted, check: npm }, allowed), {
    schemaVersion: 1, type: 'createConversation', ...trusted, check: npm,
  })
  assert.throws(() => desktopCommand('createConversation', { requestId: 'r', workspaceAccess: 'write' }, allowed), invalid)
  assert.throws(() => desktopCommand('createConversation', { requestId: 'r', workspaceAccess: 'trusted' }, allowed), invalid)
  assert.throws(() => desktopCommand('createConversation', { ...request, workspaceAccess: 'admin' }, allowed), invalid)
  assert.throws(() => desktopCommand('createConversation', { ...trusted, check: npm }, denied), invalid)
  for (const workspaceAccess of [undefined, 'read', 'write']) {
    assert.throws(() => desktopCommand('createConversation', { ...request, workspaceAccess, check: npm }, allowed), invalid)
  }
  for (const check of [
    { command: { command: 'cmd.exe', path: '.' } },
    { command: { command: 'npm_test', path: '../outside' } },
    { command: { command: 'npm_test', path: '.', args: ['--prefix', '../outside'] } },
    { command: { command: 'npm_test', path: '.', shell: true } },
    { command: { command: 'node_script', path: '.' } },
    { command: { command: 'node_script', path: 'test.mjs', args: ['nul\0byte'] } },
    { command: { command: 'node_script', path: 'test.mjs', args: Array(17).fill('arg') } },
    { command: npm.command, path: 'unexpected.html' },
  ]) {
    assert.throws(() => desktopCommand('createConversation', { ...trusted, check }, allowed), invalid)
  }
})
