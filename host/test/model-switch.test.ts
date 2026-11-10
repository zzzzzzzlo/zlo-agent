import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { ModelUnavailableError } from '../src/execution.ts'
import type { AgentExecution } from '../src/execution.ts'
import type { ConversationEvent } from '../../shared/contracts/desktop.ts'
import { LocalAgentHost } from '../src/host.ts'
import { PiExecution } from '../src/pi.ts'

const routeA = { provider: 'faux', model: 'switch-a' }
const routeB = { provider: 'faux', model: 'switch-b' }

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'zlo-model-switch-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  t.after(() => rm(root, { recursive: true, force: true }))
  const provider = fauxProvider({ models: [{ id: routeA.model }, { id: routeB.model }] })
  const execution = new PiExecution(async () => {
    const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, refreshOnCreate: false })
    runtime.registerNativeProvider(provider.provider)
    return runtime
  })
  const options = { directory: join(root, 'data'), defaultWorkspace: workspace, defaultRoute: routeA }
  return { provider, options, execution }
}

test('idle model choice survives Host restart and applies to the next real prompt in the same Pi Session', { timeout: 10_000 }, async (t) => {
  const { provider, options, execution } = await fixture(t)
  const models: string[] = []
  const context: string[] = []
  provider.setResponses([
    (_, _options, _state, model) => { models.push(model.id); return fauxAssistantMessage('Reply from A') },
    (request, _options, _state, model) => {
      models.push(model.id)
      context.push(JSON.stringify(request.messages))
      return fauxAssistantMessage('Reply from B')
    },
  ])
  let host = new LocalAgentHost({ ...options, execution })
  try {
    const { id: conversationId } = host.createConversation({ requestId: 'create' })
    await host.sendMessage({ conversationId, requestId: 'first', text: 'First prompt' })
    await host.idle()
    const first = host.getConversation(conversationId)
    const cursor = host.getConversationHistory({ conversationId }).cursor
    assert.ok(first.piSessionId)
    const request = { conversationId, requestId: 'switch', route: routeB }
    const queued = await host.setConversationModel(request)
    assert.deepEqual(queued.route, routeA)
    assert.deepEqual(queued.pendingRoute, routeB)
    assert.deepEqual(await host.setConversationModel(request), queued)
    await assert.rejects(host.setConversationModel({ ...request, route: routeA }), { code: 'CONFLICT' })
    await assert.rejects(host.setConversationModel({ ...request, requestId: 'cross', route: { provider: 'other', model: 'new' } }),
      { code: 'CONFLICT' })
    await assert.rejects(host.setConversationModel({ ...request, requestId: 'unknown', route: { ...routeA, model: 'not-listed' } }),
      { code: 'MODEL_UNAVAILABLE' })
    assert.deepEqual(models, [routeA.model])
    await host.close()

    host = new LocalAgentHost({ ...options, execution })
    assert.deepEqual(host.getConversation(conversationId), queued)
    const replayed = Promise.withResolvers<ConversationEvent>()
    const unsubscribe = host.subscribeConversation({ conversationId, after: cursor }, (event) => replayed.resolve(event))
    try {
      const event = await replayed.promise
      assert.equal(event.type, 'conversation.model_requested')
      assert.equal(event.seq, cursor + 1)
      assert.deepEqual(event.payload.conversation, queued)
    } finally {
      unsubscribe()
    }
    await host.sendMessage({ conversationId, requestId: 'second', text: 'Second prompt' })
    await host.idle()
    const history = host.getConversationHistory({ conversationId })
    assert.deepEqual(models, [routeA.model, routeB.model])
    assert.match(context[0] ?? '', /First prompt/)
    assert.equal(history.conversation.piSessionId, first.piSessionId)
    assert.deepEqual(history.conversation.route, routeB)
    assert.equal(history.conversation.pendingRoute, undefined)
    assert.equal(history.turns.at(-1)?.assistant.text, 'Reply from B')
    assert.deepEqual(await host.setConversationModel(request), queued)
    assert.deepEqual(host.getConversation(conversationId).route, routeB)
  } finally {
    await host.close()
  }
})

test('active requests can be canceled and a route-only request does not add a model call', { timeout: 10_000 }, async (t) => {
  const { provider, options, execution } = await fixture(t)
  const firstEntered = Promise.withResolvers<void>()
  const secondEntered = Promise.withResolvers<void>()
  const releaseFirst = Promise.withResolvers<void>()
  const releaseSecond = Promise.withResolvers<void>()
  const models: string[] = []
  provider.setResponses([
    async (_, _options, _state, model) => {
      models.push(model.id)
      firstEntered.resolve()
      await releaseFirst.promise
      return fauxAssistantMessage('First')
    },
    async (_, _options, _state, model) => {
      models.push(model.id)
      secondEntered.resolve()
      await releaseSecond.promise
      return fauxAssistantMessage('Second')
    },
    (_, _options, _state, model) => { models.push(model.id); return fauxAssistantMessage('Third') },
  ])
  const host = new LocalAgentHost({ ...options, execution })
  try {
    const { id: conversationId } = host.createConversation({ requestId: 'create' })
    await host.sendMessage({ conversationId, requestId: 'first', text: 'First prompt' })
    await firstEntered.promise
    const set = await host.setConversationModel({ conversationId, requestId: 'switch', route: routeB })
    assert.deepEqual(set.pendingRoute, routeB)
    const cancel = { conversationId, requestId: 'cancel', route: null }
    const canceled = await host.setConversationModel(cancel)
    assert.equal(canceled.pendingRoute, undefined)
    assert.deepEqual(canceled.route, routeA)
    assert.deepEqual(await host.setConversationModel(cancel), canceled)
    releaseFirst.resolve()
    await host.idle()
    assert.deepEqual(models, [routeA.model])

    await host.sendMessage({ conversationId, requestId: 'second', text: 'Second prompt' })
    await secondEntered.promise
    await host.setConversationModel({ conversationId, requestId: 'switch-next', route: routeB })
    releaseSecond.resolve()
    await host.idle()
    assert.deepEqual(models, [routeA.model, routeA.model])
    assert.deepEqual(host.getConversation(conversationId).pendingRoute, routeB)
    await host.sendMessage({ conversationId, requestId: 'third', text: 'Third prompt' })
    await host.idle()
    assert.deepEqual(models, [routeA.model, routeA.model, routeB.model])
    assert.equal(host.getConversation(conversationId).pendingRoute, undefined)
  } finally {
    releaseFirst.resolve()
    releaseSecond.resolve()
    await host.close()
  }
})

test('pending route can apply at a safe in-task boundary when durable steering needs another prompt', { timeout: 10_000 }, async (t) => {
  const { provider, options, execution } = await fixture(t)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const models: string[] = []
  let secondPrompt = ''
  provider.setResponses([
    async (_, _options, _state, model) => {
      models.push(model.id)
      entered.resolve()
      await release.promise
      return fauxAssistantMessage('Before switch')
    },
    (request, _options, _state, model) => {
      models.push(model.id)
      secondPrompt = JSON.stringify(request.messages)
      return fauxAssistantMessage('After switch')
    },
  ])
  const host = new LocalAgentHost({
    ...options,
    execution: {
      validateRoute: (route) => execution.validateRoute(route),
      async open(config) {
        const session = await execution.open(config)
        return { ...session, async steer() { throw new Error('Use durable instruction delivery in this test') } }
      },
    },
  })
  try {
    const { id: conversationId } = host.createConversation({ requestId: 'create' })
    const { taskId } = await host.sendMessage({ conversationId, requestId: 'first', text: 'First prompt' })
    await entered.promise
    const session = host.getConversation(conversationId).piSessionId
    await host.setConversationModel({ conversationId, requestId: 'switch', route: routeB })
    await host.steerConversation({ conversationId, taskId, requestId: 'steer', text: 'Required extra instruction' })
    release.resolve()
    await host.idle()
    const history = host.getConversationHistory({ conversationId })
    assert.deepEqual(models, [routeA.model, routeB.model])
    assert.match(secondPrompt, /Required extra instruction/)
    assert.deepEqual(history.conversation.route, routeB)
    assert.equal(history.conversation.pendingRoute, undefined)
    assert.equal(history.conversation.piSessionId, session)
    assert.equal(history.turns[0]?.status, 'succeeded')
    assert.equal(history.turns.length, 1)
  } finally {
    release.resolve()
    await host.close()
  }
})

for (const checkpointFailure of [false, true]) {
  const label = checkpointFailure ? 'checkpoint is untrustworthy' : 'chosen model is unavailable'
  test('failed session reopen preserves the applied route when ' + label, { timeout: 10_000 }, async (t) => {
    const { provider, options, execution } = await fixture(t)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    provider.setResponses([fauxAssistantMessage('Before reopen')])
    const wrapped: AgentExecution = {
      validateRoute: (route) => execution.validateRoute(route),
      async open(config) {
        if (config.session && config.route?.model === routeB.model) {
          entered.resolve()
          await release.promise
          if (checkpointFailure) throw new Error('Injected transcript failure')
          throw new ModelUnavailableError('Injected model rejection')
        }
        return execution.open(config)
      },
    }
    const host = new LocalAgentHost({ ...options, execution: wrapped })
    try {
      const { id: conversationId } = host.createConversation({ requestId: 'create' })
      await host.sendMessage({ conversationId, requestId: 'first', text: 'First prompt' })
      await host.idle()
      const session = host.getConversation(conversationId).piSessionId
      await host.setConversationModel({ conversationId, requestId: 'switch', route: routeB })
      await host.sendMessage({ conversationId, requestId: 'second', text: 'Second prompt' })
      await entered.promise
      await assert.rejects(host.setConversationModel({ conversationId, requestId: 'cancel-inflight', route: null }), { code: 'CONFLICT' })
      release.resolve()
      await host.idle()
      const actual = host.getConversation(conversationId)
      assert.deepEqual(actual.route, routeA)
      assert.deepEqual(actual.pendingRoute, routeB)
      assert.equal(actual.piSessionId, session)
      assert.equal(actual.latestStatus, checkpointFailure ? 'needs_reconciliation' : 'blocked')
      assert.equal(provider.state.callCount, 1)
      if (!checkpointFailure) {
        await host.setConversationModel({ conversationId, requestId: 'cancel-after-failure', route: null })
        assert.equal(host.getConversation(conversationId).pendingRoute, undefined)
      }
    } finally {
      release.resolve()
      await host.close()
    }
  })
}

test('stop during session reopen does not publish or use the new model before resume', { timeout: 10_000 }, async (t) => {
  const { provider, options, execution } = await fixture(t)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const models: string[] = []
  const recordModel = (_request: unknown, _options: unknown, _state: unknown, model: { id: string }) => {
    models.push(model.id)
    return fauxAssistantMessage('Reply')
  }
  provider.setResponses([recordModel, recordModel])
  const host = new LocalAgentHost({
    ...options,
    execution: {
      validateRoute: (route) => execution.validateRoute(route),
      async open(config) {
        if (config.session && config.route?.model === routeB.model) {
          entered.resolve()
          await release.promise
        }
        return execution.open(config)
      },
    },
  })
  try {
    const { id: conversationId } = host.createConversation({ requestId: 'create' })
    await host.sendMessage({ conversationId, requestId: 'first', text: 'First prompt' })
    await host.idle()
    const session = host.getConversation(conversationId).piSessionId
    await host.setConversationModel({ conversationId, requestId: 'switch', route: routeB })
    const { taskId } = await host.sendMessage({ conversationId, requestId: 'second', text: 'Second prompt' })
    await entered.promise
    assert.equal(host.stopConversation({ conversationId, taskId, requestId: 'stop' }).accepted, true)
    release.resolve()
    await host.idle()
    const stopped = host.getConversation(conversationId)
    assert.equal(stopped.latestStatus, 'stopped')
    assert.deepEqual(stopped.route, routeA)
    assert.deepEqual(stopped.pendingRoute, routeB)
    assert.equal(stopped.piSessionId, session)
    assert.deepEqual(models, [routeA.model])
    assert.equal(host.resumeConversation({ conversationId, taskId, requestId: 'resume' }).accepted, true)
    await host.idle()
    const resumed = host.getConversation(conversationId)
    assert.deepEqual(resumed.route, routeB)
    assert.equal(resumed.pendingRoute, undefined)
    assert.equal(resumed.piSessionId, session)
    assert.deepEqual(models, [routeA.model, routeB.model])
  } finally {
    release.resolve()
    await host.close()
  }
})
