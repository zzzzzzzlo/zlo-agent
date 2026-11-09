import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import type {
  ConversationEvent, ConversationHistory, ConversationSummary, ConversationTurn, DesktopHostApi,
} from '../../host/src/contracts/desktop.ts'
import { HostAgentAdapter } from '../src/integrations/agent/HostAgentAdapter.ts'
import { applyHistory, applyHostEvent, isBusy } from '../src/integrations/agent/conversationProjection.ts'

const conversation: ConversationSummary = {
  id: 'conversation', title: 'Example', createdAt: 1, updatedAt: 1, archived: false, workspace: 'D:/workspace',
}
const turn: ConversationTurn = {
  taskId: 'task', taskRunId: 'cycle', taskAttemptId: 'attempt', status: 'running',
  user: { id: 'user', role: 'user', text: 'Create the artifact', createdAt: 1 },
  assistant: { id: 'assistant', role: 'assistant', text: 'start', createdAt: 1 },
  instructions: [], tools: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

function event(seq: number, type = 'message.delta', payload: ConversationEvent['payload'] = { messageId: 'assistant', delta: ' more' }): ConversationEvent {
  return { schemaVersion: 1, seq, type, payload, eventId: String(seq), timestamp: 1, conversationId: conversation.id, taskId: turn.taskId }
}

function history(cursor: number, text = 'start'): ConversationHistory {
  return { conversation, cursor, turns: [{ ...turn, assistant: { ...turn.assistant, text } }] }
}

function testApi(getHistory: DesktopHostApi['getHistory'], watchConversation?: DesktopHostApi['watchConversation']) {
  let receive: (event: ConversationEvent) => void = () => {}
  const actions: string[] = []
  const unavailable = async (): Promise<never> => { throw new Error('Unexpected call') }
  const api: DesktopHostApi = {
    getHistory, getStatus: async () => ({ state: 'ready', mode: 'faux' }),
    watchConversation: async (input) => {
      actions.push('watch:' + input.after)
      return watchConversation ? watchConversation(input) : true
    },
    unwatchConversation: async () => { actions.push('unwatch'); return true },
    onEvent(listener) { receive = listener; return () => { receive = () => {} } },
    onStatus: () => () => {},
    createConversation: unavailable, listConversations: unavailable, getConversation: unavailable,
    sendMessage: unavailable, steerConversation: unavailable, stopConversation: unavailable,
    resumeConversation: unavailable, renameConversation: unavailable, archiveConversation: unavailable,
    chooseWorkspace: unavailable, restart: unavailable,
  }
  return { api, actions, emit: (value: ConversationEvent) => receive(value) }
}

test('adapter replays events after a snapshot cursor without duplicate deltas', async () => {
  let resolveWatch: (value: true) => void = () => {}
  const ack = new Promise<true>((resolve) => { resolveWatch = resolve })
  const { api, emit, actions } = testApi(async () => history(4), () => ack)
  const adapter = new HostAgentAdapter(api)
  const received: number[] = []
  let text = ''
  const close = adapter.watch(conversation.id, {
    history: (value) => { text = value.turns[0].assistant.text },
    event: (value) => { received.push(value.seq); text += value.payload.delta },
    error: (error) => assert.fail(String(error)),
  })
  await setImmediate()
  emit(event(4))
  emit(event(6))
  emit(event(5))
  emit(event(5))
  resolveWatch(true)
  await setImmediate()
  assert.deepEqual(received, [5, 6])
  assert.equal(text, 'start more more')
  close()
  adapter.dispose()
  assert.deepEqual(actions, ['watch:4', 'unwatch'])
})

test('adapter restores a fresh snapshot when there is a gap', async () => {
  let calls = 0
  const { api, emit, actions } = testApi(async () => ++calls === 1 ? history(4) : history(7, 'restored partial output'))
  const adapter = new HostAgentAdapter(api)
  const snapshots: string[] = []
  const deltas: number[] = []
  adapter.watch(conversation.id, {
    history: (value) => snapshots.push(value.turns[0].assistant.text),
    event: (value) => deltas.push(value.seq),
    error: (error) => assert.fail(String(error)),
  })
  await setImmediate()
  emit(event(7))
  await setImmediate()
  emit(event(7))
  emit(event(8))
  assert.deepEqual(snapshots, ['start', 'restored partial output'])
  assert.deepEqual(deltas, [8])
  assert.deepEqual(actions, ['watch:4', 'watch:7'])
  adapter.dispose()
})

test('adapter does not subscribe a selection released while history was pending', async () => {
  let resolveHistory: (value: ConversationHistory) => void = () => {}
  const pending = new Promise<ConversationHistory>((resolve) => { resolveHistory = resolve })
  const { api, actions } = testApi(() => pending)
  const adapter = new HostAgentAdapter(api)
  const unexpected = () => assert.fail('closed watch received data')
  const close = adapter.watch(conversation.id, { history: unexpected, event: unexpected, error: unexpected })
  close()
  resolveHistory(history(0))
  await setImmediate()
  assert.deepEqual(actions, ['unwatch'])
  adapter.dispose()
})

test('projection preserves partial replies, tool status, usage and the reconciliation state', () => {
  let view = applyHistory(history(1))
  view = applyHostEvent(view, event(2))
  view = applyHostEvent(view, event(3, 'tool.started', { tool: { id: 'operation', name: 'write', status: 'running' } }))
  view = applyHostEvent(view, event(4, 'model.usage', { usage: { input: 12, output: 3, cacheRead: 1, cacheWrite: 0 } }))
  view = applyHostEvent(view, event(5, 'tool.updated', { tool: { id: 'operation', name: 'write', status: 'unknown_effect' } }))
  view = applyHostEvent(view, event(6, 'run.interrupted', { status: 'needs_reconciliation', reason: 'unknown_effect' }))
  const latest = view.turns[0]
  assert.equal(latest.response, 'start more')
  assert.equal(latest.usage?.input, 12)
  assert.equal(latest.tools[0].status, 'reconciliation')
  assert.equal(latest.status, 'reconciliation')
  assert.equal(latest.taskRunId, 'cycle')
  assert.equal(latest.attemptId, 'attempt')
  assert.equal(isBusy(latest.status), false)
})
