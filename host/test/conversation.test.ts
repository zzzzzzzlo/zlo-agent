import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { ConversationService } from '../src/conversation.ts'
import type {
  ConversationEvent, ConversationHistory, ConversationSummary, DesktopErrorCode, SendMessageResult,
} from '../../shared/contracts/desktop.ts'
import { LocalAgentHost } from '../src/host.ts'
import { PiExecution } from '../src/pi.ts'
import { LocalStore } from '../src/store.ts'
import { TaskEngine } from '../src/task-engine.ts'

const desktopRoute = { provider: 'faux', model: 'desktop-test' }
const cliFile = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

async function paths(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'zlo-conversation-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, directory: join(root, 'data'), workspace }
}

test('Conversation Service keeps ordered history pages and archives without deleting the audit history', () => {
  const store = new LocalStore(':memory:')
  try {
    const service = new ConversationService(store)
    const engine = new TaskEngine(store)
    const create = { requestId: 'create-conversation', title: 'Demo' }
    const conversation = service.create(create, 'workspace')
    assert.deepEqual(service.create(create, 'workspace'), conversation)
    assert.throws(() => service.create({ ...create, title: 'different' }, 'workspace'), /Request ID/)
    for (let ordinal = 1; ordinal <= 53; ordinal++) {
      const command = { requestId: 'request-' + ordinal, conversationId: conversation.id, text: 'Turn ' + ordinal }
      const { taskId } = engine.create({
        requestId: 'task-' + ordinal, conversationId: conversation.id, goal: command.text, cwd: 'workspace',
      }, (task) => service.attachTask(command, task))
      engine.start(taskId)
      engine.beginVerification(taskId)
      engine.verify(taskId, { passed: true, evidence: 'test' })
    }
    const page = service.history({ conversationId: conversation.id })
    assert.equal(page.turns.length, 50)
    assert.equal(page.turns[0]?.user.text, 'Turn 4')
    assert.equal(page.turns.at(-1)?.user.text, 'Turn 53')
    assert.equal(page.nextBefore, 4)
    const first = service.history({ conversationId: conversation.id, before: page.nextBefore })
    assert.deepEqual(first.turns.map((turn) => turn.user.text), ['Turn 1', 'Turn 2', 'Turn 3'])
    assert.equal(first.cursor, page.cursor)
    assert.equal(first.nextBefore, undefined)
    const rename = { conversationId: conversation.id, requestId: 'rename', title: 'Renamed' }
    assert.equal(service.rename(rename).title, 'Renamed')
    assert.equal(service.rename(rename).title, 'Renamed')
    assert.throws(() => service.rename({ ...rename, title: 'Conflicting title' }), /Request ID/)
    assert.equal(service.list().length, 1)
    assert.equal(service.archive({ conversationId: conversation.id, requestId: 'archive' }).archived, true)
    assert.equal(service.list().length, 0)
    assert.deepEqual(service.history({ conversationId: conversation.id }).turns, page.turns)
    assert.throws(() => service.canSend(conversation.id), /archived/)
  } finally {
    store.close()
  }
})

test('A failed Task event transaction rolls back the user message, task, and idempotency receipt', () => {
  const store = new LocalStore(':memory:')
  try {
    const service = new ConversationService(store)
    const engine = new TaskEngine(store)
    const conversation = service.create({ requestId: 'create' }, 'workspace')
    store.projectEvents((event) => {
      if (event.type === 'task.created') throw new Error('Injected projection failure')
    })
    const command = { requestId: 'message', conversationId: conversation.id, text: 'Persist atomically' }
    assert.throws(() => engine.create({
      requestId: 'create-task', conversationId: conversation.id, goal: command.text, cwd: 'workspace',
    }, (task) => service.attachTask(command, task)), /Injected projection failure/)
    const snapshot = service.history({ conversationId: conversation.id })
    assert.deepEqual(snapshot.turns, [])
    assert.equal(snapshot.conversation.latestTaskId, undefined)
    assert.equal(snapshot.cursor, 1)
    assert.equal(service.sent(command), undefined)
    assert.deepEqual(engine.list(), [])
  } finally {
    store.close()
  }
})

test('Two Conversation messages use separate Task and Run IDs and reuse persisted Pi context', { timeout: 10000 }, async (t) => {
  const { root, directory, workspace } = await paths(t)
  const model = fauxProvider({ models: [{ id: desktopRoute.model }] })
  const route = desktopRoute
  const execution = new PiExecution(async () => {
    const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, refreshOnCreate: false })
    runtime.registerNativeProvider(model.provider)
    return runtime
  })
  const host = new LocalAgentHost({ directory, defaultWorkspace: workspace, defaultRoute: route, execution })
  let previousContext = ''
  let persistedBeforeModel = ''
  try {
    const conversation = host.createConversation({ requestId: 'create' })
    model.setResponses([
      () => {
        persistedBeforeModel = host.getConversationHistory({ conversationId: conversation.id }).turns[0]?.user.text ?? ''
        return fauxAssistantMessage('Earlier answer')
      },
      (context) => {
        previousContext = JSON.stringify(context.messages)
        return fauxAssistantMessage('Later answer')
      },
    ])
    const send = { requestId: 'message-one', conversationId: conversation.id, text: 'Earlier question' }
    const [first, duplicate] = await Promise.all([host.sendMessage(send), host.sendMessage(send)])
    assert.deepEqual(first, duplicate)
    await assert.rejects(host.sendMessage({ ...send, text: 'Changed question' }), /Request ID/)
    await host.idle()
    assert.equal(persistedBeforeModel, send.text)
    const later = await host.sendMessage({ ...send, requestId: 'message-two', text: 'Later question' })
    await host.idle()
    const history = host.getConversationHistory({ conversationId: conversation.id })
    assert.equal(history.turns.length, 2)
    assert.deepEqual(history.turns.map((turn) => turn.assistant.text), ['Earlier answer', 'Later answer'])
    assert.deepEqual(history.turns.map((turn) => turn.status), ['succeeded', 'succeeded'])
    assert.notEqual(first.taskId, later.taskId)
    assert.notEqual(first.taskRunId, later.taskRunId)
    assert.notEqual(first.taskId, first.taskRunId)
    assert.notEqual(first.taskRunId, history.turns[0]?.taskAttemptId)
    assert.notEqual(history.turns[0]?.user.id, history.turns[0]?.assistant.id)
    const session = host.getHistory(first.taskId).session
    assert.ok(session && session.id !== conversation.id)
    assert.equal(session.id, host.getHistory(later.taskId).session?.id)
    assert.equal(history.conversation.piSessionId, session.id)
    assert.equal(history.turns[0]?.verification?.evidence, 'assistant_response_present')
    assert.match(previousContext, /Earlier question/)
    assert.match(previousContext, /Earlier answer/)
    assert.throws(() => host.resumeConversation({
      conversationId: conversation.id, taskId: first.taskId, requestId: 'stale-resume',
    }), /no longer current/)
  } finally {
    await host.close()
  }
})

interface Frame {
  kind: string
  commandId?: string
  mode?: string
  result?: unknown
  event?: ConversationEvent
  error?: { code: DesktopErrorCode; message: string }
}

function launchCli(t: TestContext, directory: string, workspace: string, preload?: string) {
  const options = preload ? ['--import', preload] : []
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...options, cliFile, '--faux', '--data', directory], {
    env: {
      ...process.env, ZLO_AGENT_DEFAULT_WORKSPACE: workspace,
      ZLO_AGENT_MODEL_PROVIDER: desktopRoute.provider, ZLO_AGENT_MODEL_ID: desktopRoute.model,
    },
  })
  const exited = once(child, 'exit')
  const lines = createInterface({ input: child.stdout })
  const received: Frame[] = []
  let errors = ''
  let counter = 0
  lines.on('line', (line) => { received.push(JSON.parse(line) as Frame) })
  child.stderr.on('data', (chunk) => { errors += String(chunk) })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await exited
    }
    lines.close()
  })
  async function receive(predicate: (frame: Frame) => boolean): Promise<Frame> {
    for (let tick = 0; tick < 750; tick++) {
      const frame = received.find(predicate)
      if (frame) return frame
      if (child.exitCode !== null || child.signalCode !== null) break
      await delay(10, undefined, { signal: t.signal })
    }
    throw new Error('Host did not send the expected frame. Recent frames: ' + JSON.stringify(received.slice(-3)) + ' ' + errors)
  }
  async function request(type: string, input: object = {}): Promise<Frame> {
    const commandId = 'cmd-' + ++counter
    child.stdin.write(JSON.stringify({ schemaVersion: 1, type, commandId, ...input }) + '\n')
    return receive((frame) => frame.commandId === commandId)
  }
  return {
    receive,
    request,
    async result<T>(type: string, input?: object): Promise<T> {
      const frame = await request(type, input)
      assert.equal(frame.kind, 'result', JSON.stringify(frame))
      return frame.result as T
    },
    async stop() {
      await request('exit')
      assert.deepEqual(await exited, [0, null], errors)
    },
    async kill() {
      assert.ok(child.kill('SIGKILL'))
      assert.deepEqual(await exited, [null, 'SIGKILL'])
    },
  }
}

test('Desktop JSONL supports login page tools, durable deltas, usage, restart, and cursor replay', { timeout: 18000 }, async (t) => {
  const { directory, workspace } = await paths(t)
  const cli = launchCli(t, directory, workspace)
  assert.equal((await cli.receive((frame) => frame.kind === 'ready')).mode, 'faux')
  const invalid = await cli.request('createConversation', { requestId: 'invalid', workspace, check: { path: '../escape' } })
  assert.equal(invalid.error?.code, 'INVALID_INPUT')
  const { id: conversationId } = await cli.result<ConversationSummary>('createConversation', {
    requestId: 'create', title: '登录', workspace, check: { path: 'login.html', contains: '<form>' },
  })
  await cli.result('subscribeConversation', { conversationId, after: 0 })
  const first = await cli.result<SendMessageResult>('sendMessage', { conversationId, requestId: 'one', text: '帮我创建一个简单的登录页面' })
  const started = await cli.receive(({ event }) => event?.type === 'agent.started' && event.taskId === first.taskId)
  assert.equal(started.event?.payload.agentRole, 'root')
  assert.equal(started.event?.payload.agentStatus, 'active')
  assert.equal(started.event?.taskRunId, first.taskRunId)
  assert.notEqual(started.event?.taskAttemptId, first.taskRunId)
  await cli.receive(({ event }) => event?.type === 'agent.finished' && event.taskId === first.taskId && event.payload.agentStatus === 'completed')
  await cli.receive(({ event }) => event?.type === 'message.delta' && event.taskId === first.taskId)
  await cli.receive(({ event }) => event?.type === 'tool.updated' && event.payload.tool?.status === 'succeeded')
  await cli.receive(({ event }) => event?.type === 'model.usage' && (event.payload.usage?.output ?? 0) > 0)
  await cli.receive(({ event }) => event?.type === 'run.finished' && event.taskId === first.taskId)
  const before = await cli.result<ConversationHistory>('getConversationHistory', { conversationId })
  assert.equal(before.turns[0]?.status, 'succeeded')
  assert.ok(before.conversation.piSessionId)
  assert.equal(before.turns[0]?.assistant.text, '已创建简单登录页面，包含用户名和密码输入框。')
  assert.ok((await readFile(join(workspace, 'login.html'), 'utf8')).includes('<form>'))
  await cli.stop()

  const reopened = launchCli(t, directory, workspace)
  await reopened.receive((frame) => frame.kind === 'ready')
  assert.deepEqual(await reopened.result('getConversationHistory', { conversationId }), before)
  const second = await reopened.result<SendMessageResult>('sendMessage', { conversationId, requestId: 'two', text: '再给它添加一个验证码输入框' })
  assert.notEqual(second.taskId, first.taskId)
  assert.notEqual(second.taskRunId, first.taskRunId)
  await reopened.result('subscribeConversation', { conversationId, after: before.cursor })
  const firstReplayed = await reopened.receive((frame) => frame.kind === 'conversation.event')
  assert.equal(firstReplayed.event?.seq, before.cursor + 1)
  assert.equal(firstReplayed.event?.taskId, second.taskId)
  await reopened.receive(({ event }) => event?.type === 'run.finished' && event.taskId === second.taskId)
  const after = await reopened.result<ConversationHistory>('getConversationHistory', { conversationId })
  assert.equal(after.turns.at(-1)?.status, 'succeeded')
  assert.equal(after.conversation.piSessionId, before.conversation.piSessionId)
  assert.equal(after.turns.at(-1)?.assistant.text, '已在登录页中添加验证码输入框。')
  assert.match(await readFile(join(workspace, 'login.html'), 'utf8'), /name="captcha"/)
  const failingConversation = await reopened.result<ConversationSummary>('createConversation', {
    requestId: 'verification-failure', workspace, check: { path: 'missing.html' },
  })
  await reopened.result('subscribeConversation', { conversationId: failingConversation.id, after: 0 })
  const failed = await reopened.result<SendMessageResult>('sendMessage', {
    conversationId: failingConversation.id, requestId: 'failed-message', text: '请确认验收文件',
  })
  const failedRun = await reopened.receive(({ event }) => event?.type === 'run.finished' && event.taskId === failed.taskId)
  assert.equal(failedRun.event?.payload.status, 'failed')
  assert.equal(failedRun.event?.payload.reason, 'verification_failed')
  await reopened.stop()
})

test('Desktop controls steer live and stop without accepting a concurrent Task', { timeout: 18000 }, async (t) => {
  const { directory, workspace } = await paths(t)
  const cli = launchCli(t, directory, workspace)
  await cli.receive((frame) => frame.kind === 'ready')
  const { id: conversationId } = await cli.result<ConversationSummary>('createConversation', { requestId: 'create' })
  await cli.result('subscribeConversation', { conversationId, after: 0 })
  const first = await cli.result<SendMessageResult>('sendMessage', { conversationId, requestId: 'steer-task', text: '[steer]' })
  await cli.receive(({ event }) => event?.type === 'message.delta' && event.taskId === first.taskId)
  const concurrent = await cli.request('sendMessage', { conversationId, requestId: 'concurrent', text: 'Do not queue this' })
  assert.equal(concurrent.error?.code, 'CONFLICT')
  const archive = await cli.request('archiveConversation', { conversationId, requestId: 'early-archive' })
  assert.equal(archive.error?.code, 'CONFLICT')
  const instruction = { conversationId, taskId: first.taskId, requestId: 'instruction', text: '保留追加指令' }
  assert.deepEqual(await cli.result('steerConversation', instruction), { accepted: true })
  assert.deepEqual(await cli.result('steerConversation', instruction), { accepted: true })
  await cli.receive(({ event }) => event?.type === 'run.finished' && event.taskId === first.taskId)
  const steered = await cli.result<ConversationHistory>('getConversationHistory', { conversationId })
  assert.equal(steered.turns.length, 1)
  assert.deepEqual(steered.turns[0]?.instructions.map(({ text }) => text), [instruction.text])
  assert.match(steered.turns[0]?.assistant.text ?? '', /已应用追加指令：保留追加指令/)

  const second = await cli.result<SendMessageResult>('sendMessage', { conversationId, requestId: 'stop-task', text: '[slow]' })
  await cli.receive(({ event }) => event?.type === 'message.delta' && event.taskId === second.taskId)
  const beforeStop = await cli.result<ConversationHistory>('getConversationHistory', { conversationId })
  const legacy = await cli.request('stop', { taskId: second.taskId, requestId: 'bypass' })
  assert.equal(legacy.error?.code, 'CONFLICT')
  const stop = { conversationId, taskId: second.taskId, requestId: 'stop' }
  assert.deepEqual(await cli.result('stopConversation', stop), { accepted: true, status: 'stop_requested' })
  await cli.receive(({ event }) => event?.type === 'run.interrupted' && event.taskId === second.taskId)
  const stopped = await cli.result<ConversationHistory>('getConversationHistory', { conversationId })
  assert.equal(stopped.turns[1]?.status, 'stopped')
  assert.equal(stopped.turns[1]?.reason, 'user_stop')
  assert.ok(stopped.turns[1]?.assistant.text.startsWith(beforeStop.turns[1]?.assistant.text ?? ''))
  assert.deepEqual(await cli.result('resumeConversation', { ...stop, requestId: 'resume' }), { accepted: true, status: 'ready' })
  await cli.receive(({ event }) => event?.type === 'run.finished' && event.taskId === second.taskId)
  const resumed = await cli.result<ConversationHistory>('getConversationHistory', { conversationId })
  assert.equal(resumed.turns[1]?.taskRunId, second.taskRunId)
  assert.notEqual(resumed.turns[1]?.taskAttemptId, stopped.turns[1]?.taskAttemptId)
  await cli.stop()
})

test('Crash between a file write and its receipt projects reconciliation and refuses further messages', { timeout: 18000 }, async (t) => {
  const { directory, workspace } = await paths(t)
  const taskEngine = new URL('../src/task-engine.ts', import.meta.url).href
  const preload = 'data:text/javascript,' + encodeURIComponent(`
    import { writeSync } from 'node:fs'
    import { TaskEngine } from ${JSON.stringify(taskEngine)}
    const finishTool = TaskEngine.prototype.finishTool
    TaskEngine.prototype.finishTool = function(event, id, status) {
      if (status === 'succeeded' && this.operations(event.taskId).some((item) => item.id === id && item.effect === 'write')) {
        writeSync(1, JSON.stringify({ schemaVersion: 1, kind: 'fault-ready' }) + '\\n')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
      }
      return finishTool.call(this, event, id, status)
    }
  `)
  const cli = launchCli(t, directory, workspace, preload)
  await cli.receive((frame) => frame.kind === 'ready')
  const { id: conversationId } = await cli.result<ConversationSummary>('createConversation', {
    requestId: 'create', workspace, check: { path: 'login.html' },
  })
  const { taskId } = await cli.result<SendMessageResult>('sendMessage', { conversationId, requestId: 'write', text: '创建登录页' })
  await cli.receive((frame) => frame.kind === 'fault-ready')
  await cli.kill()
  const artifact = await readFile(join(workspace, 'login.html'), 'utf8')

  const reopened = launchCli(t, directory, workspace)
  await reopened.receive((frame) => frame.kind === 'ready')
  const history = await reopened.result<ConversationHistory>('getConversationHistory', { conversationId })
  assert.equal(history.turns[0]?.status, 'needs_reconciliation')
  assert.equal(history.turns[0]?.reason, 'unknown_effect')
  assert.deepEqual(history.turns[0]?.tools.map(({ name, status }) => [name, status]), [['create_text_file', 'unknown_effect']])
  assert.deepEqual(await reopened.result('resumeConversation', { conversationId, taskId, requestId: 'resume' }),
    { accepted: false, status: 'needs_reconciliation' })
  const blocked = await reopened.request('sendMessage', { conversationId, requestId: 'after', text: '再次创建登录页' })
  assert.equal(blocked.error?.code, 'CONFLICT')
  assert.equal(await readFile(join(workspace, 'login.html'), 'utf8'), artifact)
  await reopened.stop()
})

test('Host SIGKILL keeps the partial reply and resumes the same Task Run, Attempt and Pi Session', { timeout: 18000 }, async (t) => {
  const { directory, workspace } = await paths(t)
  const cli = launchCli(t, directory, workspace)
  await cli.receive((frame) => frame.kind === 'ready')
  const { id: conversationId } = await cli.result<ConversationSummary>('createConversation', { requestId: 'create' })
  await cli.result('subscribeConversation', { conversationId, after: 0 })
  const { taskId, taskRunId } = await cli.result<SendMessageResult>('sendMessage', { conversationId, requestId: 'slow', text: '[slow]' })
  await cli.receive(({ event }) => event?.type === 'message.delta' && event.taskId === taskId)
  const active = await cli.result<ConversationHistory>('getConversationHistory', { conversationId })
  assert.equal(active.turns[0]?.status, 'running')
  assert.ok(active.turns[0]?.assistant.text)
  assert.ok(active.turns[0]?.taskAttemptId)
  assert.ok(active.conversation.piSessionId)
  await cli.kill()

  const reopened = launchCli(t, directory, workspace)
  await reopened.receive((frame) => frame.kind === 'ready')
  const stopped = await reopened.result<ConversationHistory>('getConversationHistory', { conversationId })
  assert.equal(stopped.turns[0]?.status, 'stopped')
  assert.equal(stopped.turns[0]?.reason, 'process_interrupted')
  assert.ok(stopped.turns[0]?.assistant.text.startsWith(active.turns[0].assistant.text))
  assert.equal(stopped.turns[0]?.taskAttemptId, active.turns[0]?.taskAttemptId)
  await reopened.result('subscribeConversation', { conversationId, after: stopped.cursor })
  assert.deepEqual(await reopened.result('resumeConversation', { conversationId, taskId, requestId: 'resume' }), { accepted: true, status: 'ready' })
  await reopened.receive(({ event }) => event?.type === 'run.finished' && event.taskId === taskId)
  const resumed = await reopened.result<ConversationHistory>('getConversationHistory', { conversationId })
  assert.equal(resumed.turns.length, 1)
  assert.equal(resumed.turns[0]?.taskId, taskId)
  assert.equal(resumed.turns[0]?.taskRunId, taskRunId)
  assert.equal(resumed.turns[0]?.taskAttemptId, active.turns[0]?.taskAttemptId)
  assert.equal(resumed.conversation.piSessionId, active.conversation.piSessionId)
  assert.equal(resumed.turns[0]?.status, 'succeeded')
  assert.match(resumed.turns[0]?.assistant.text ?? '', /已从保存的会话继续/)
  await reopened.stop()
})
