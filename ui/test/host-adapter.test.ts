import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import type {
  ConversationEvent, ConversationHistory, ConversationSummary, ConversationTurn, DesktopHostApi, DesktopHostStatus, SetConversationModelInput,
} from '../../shared/contracts/desktop.ts'
import { HostAgentAdapter } from '../src/integrations/agent/HostAgentAdapter.ts'
import { applyHistory, applyHostEvent, applyOlderHistory, isBusy } from '../src/integrations/agent/conversationProjection.ts'

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
  let receiveStatus: (status: DesktopHostStatus) => void = () => {}
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
    onStatus(listener) { receiveStatus = listener; return () => { receiveStatus = () => {} } },
    createConversation: unavailable, listConversations: async () => [conversation], getConversation: unavailable,
    sendMessage: unavailable, steerConversation: unavailable, stopConversation: unavailable,
    resumeConversation: unavailable, renameConversation: unavailable, setConversationModel: unavailable, archiveConversation: unavailable,
    chooseWorkspace: unavailable, restart: unavailable,
  }
  return { api, actions, emit: (value: ConversationEvent) => receive(value), status: (value: DesktopHostStatus) => receiveStatus(value) }
}

function numberedPage(total: number, cursor: number, before?: number): ConversationHistory {
  const newest = Math.min(total, before === undefined ? total : before - 1)
  const oldest = Math.max(1, newest - 49)
  const turns = Array.from({ length: newest - oldest + 1 }, (_, index) => {
    const id = oldest + index
    return {
      ...turn, taskId: 'task-' + id, status: 'succeeded' as const,
      assistant: { ...turn.assistant, id: 'assistant-' + id, text: 'snapshot-' + cursor },
    }
  })
  return { conversation, turns, cursor, nextBefore: oldest > 1 ? oldest : undefined }
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

test('adapter refuses a gap repair snapshot older than the durable event', async () => {
  let snapshots = 0
  const { api, emit, actions } = testApi(async () => history(4))
  const adapter = new HostAgentAdapter(api)
  const failures: unknown[] = []
  adapter.watch(conversation.id, {
    history: () => { snapshots++ },
    event: () => assert.fail('out-of-sequence event applied'),
    error: (error) => failures.push(error),
  })
  await setImmediate()
  emit(event(7))
  await setImmediate()
  assert.equal(snapshots, 1)
  assert.equal(failures.length, 1)
  assert.deepEqual(actions, ['watch:4', 'unwatch'])
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

test('projection retains cached history across a disjoint snapshot and fills the highest gap', () => {
  let view = applyHistory(numberedPage(60, 100))
  view = applyOlderHistory(view, numberedPage(60, 100, view.nextBefore))
  view = applyHistory(numberedPage(130, 200), view)
  assert.equal(view.turns.length, 110)
  assert.equal(view.nextBefore, 81)
  assert.equal(view.turns[60].id, 'task-81')
  view = applyOlderHistory(view, numberedPage(130, 180, view.nextBefore))
  assert.deepEqual(view.turns.map(({ id }) => id), Array.from({ length: 130 }, (_, index) => 'task-' + (index + 1)))
  assert.equal(view.turns[40].response, 'snapshot-100')
  assert.equal(view.turns[70].response, 'snapshot-180')
  assert.equal(view.turns[129].response, 'snapshot-200')
  assert.equal(view.nextBefore, undefined)
  assert.equal(view.historyCursor, 200)
  assert.equal(applyHistory(numberedPage(130, 199), view), view)
})

async function loadWorkspaceFactory() {
  // Node's test loader resolves the same local TypeScript modules that Vite resolves.
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      const localSource = context.parentURL?.includes('/ui/src/') && specifier.startsWith('.')
      return nextResolve(localSource && !specifier.endsWith('.ts') ? specifier + '.ts' : specifier, context)
    },
  })
  try { return (await import('../src/stores/workspace.ts')).createWorkspace }
  finally { hook.deregister() }
}

test('Zustand retains older pages on reconnect and refreshes overlapping turns from the latest snapshot', async () => {
  const storeFactory = await loadWorkspaceFactory()
  let total = 65
  let cursor = 100
  const { api, actions, emit, status } = testApi(async ({ before }) => numberedPage(total, cursor, before))
  const adapter = new HostAgentAdapter(api)
  const store = storeFactory(adapter, false)
  const close = store.getState().initialize()
  try {
    await setImmediate()
    assert.equal(store.getState().sessions[0].turns.length, 50)
    assert.equal(await store.getState().loadOlder(), true)
    assert.equal(store.getState().sessions[0].turns.length, 65)
    status({ state: 'offline', mode: 'faux' })
    total = 69
    cursor = 140
    status({ state: 'ready', mode: 'faux' })
    await setImmediate()
    const restored = store.getState().sessions[0]
    assert.deepEqual(restored.turns.map(({ id }) => id), Array.from({ length: 69 }, (_, index) => 'task-' + (index + 1)))
    assert.equal(restored.nextBefore, undefined)
    assert.equal(restored.turns[0].response, 'snapshot-100')
    assert.equal(restored.turns[64].response, 'snapshot-140')
    assert.ok(actions.includes('watch:140'))
    const delta = { ...event(141, 'message.delta', { messageId: 'assistant-69', delta: ' replay' }), taskId: 'task-69' }
    emit(delta)
    emit(delta)
    assert.equal(store.getState().sessions[0].turns.at(-1)?.response, 'snapshot-140 replay')
  } finally {
    close()
    adapter.dispose()
  }
})

test('Zustand projects confirmed and pending models from events and sends null for cancellation', async () => {
  const storeFactory = await loadWorkspaceFactory()
  const a = { provider: 'faux', model: 'a' }
  const b = { provider: 'faux', model: 'b' }
  const c = { provider: 'faux', model: 'c' }
  const starting = { ...conversation, route: a }
  const { api, emit } = testApi(async () => ({ ...history(4), conversation: starting }))
  const requests: SetConversationModelInput[] = []
  api.setConversationModel = async (input) => {
    requests.push(input)
    if (input.route?.model === b.model) {
      const pending = { ...starting, pendingRoute: b }
      emit(event(5, 'conversation.model_requested', { conversation: pending }))
      emit(event(6, 'model.route_changed', { conversation: { ...starting, route: b } }))
      return pending // The original acknowledgement precedes the application event.
    }
    const updated = { ...starting, route: b, pendingRoute: input.route ?? undefined }
    emit(event(5 + requests.length, 'conversation.model_requested', { conversation: updated }))
    return updated
  }
  const adapter = new HostAgentAdapter(api)
  const store = storeFactory(adapter, false)
  const close = store.getState().initialize()
  try {
    await setImmediate()
    assert.deepEqual(store.getState().sessions[0].route, a)
    assert.equal(await store.getState().setConversationModel(conversation.id, b), true)
    assert.deepEqual(store.getState().sessions[0].route, b)
    assert.equal(store.getState().sessions[0].pendingRoute, undefined)
    assert.equal(await store.getState().setConversationModel(conversation.id, c), true)
    assert.deepEqual(store.getState().sessions[0].route, b)
    assert.deepEqual(store.getState().sessions[0].pendingRoute, c)
    assert.equal(await store.getState().setConversationModel(conversation.id, null), true)
    assert.equal(requests.at(-1)?.route, null)
    assert.deepEqual(store.getState().sessions[0].route, b)
    assert.equal(store.getState().sessions[0].pendingRoute, undefined)
  } finally {
    close()
    adapter.dispose()
  }
})
