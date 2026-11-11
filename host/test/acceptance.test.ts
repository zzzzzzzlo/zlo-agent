import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { AgentExecution, ExecutionConfig } from '../src/execution.ts'
import { FakeExecution } from '../src/fake.ts'
import { LocalAgentHost } from '../src/host.ts'
import { LocalStore } from '../src/store.ts'
import { TaskEngine } from '../src/task-engine.ts'

async function fixture(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'zlo-acceptance-'))
  const cwd = join(path, 'workspace')
  await mkdir(cwd)
  t.after(() => rm(path, { recursive: true, force: true }))
  return { cwd, directory: join(path, 'state') }
}

function execution(run: (config: ExecutionConfig, prompt: string) => Promise<string>): AgentExecution {
  const fake = new FakeExecution()
  return {
    validateRoute: route => fake.validateRoute(route),
    async open(config) {
      const session = await fake.open(config)
      return {
        ...session,
        async run(prompt) { return { status: 'completed', text: await run(config, prompt) } },
      }
    },
  }
}

async function tool(config: ExecutionConfig, name: string, input: unknown) {
  const candidate = config.tools.find(entry => entry.name === name)
  assert.ok(candidate, 'Tool unavailable: ' + name)
  return candidate.execute(randomUUID(), input)
}

test('text, including a claimed coding success, remains unverified in desktop history after restart', async (t) => {
  const options = { ...await fixture(t), execution: execution(async () => 'I fixed the bug and all tests passed.') }
  const initial = new LocalAgentHost(options)
  let conversationId: string
  let taskId: string
  try {
    conversationId = initial.createConversation({ requestId: 'conversation', workspace: options.cwd }).id
    const sent = await initial.sendMessage({ requestId: 'send', conversationId, text: 'Fix the bug and run the tests' })
    taskId = sent.taskId
    await initial.idle()
    assert.equal(initial.getTask(taskId).status, 'succeeded')
    const evidence = initial.events(taskId).find(event => event.type === 'verification.finished')?.payload
    assert.equal(evidence?.executionStatus, 'completed')
    assert.equal(evidence?.verdict, 'unverified')
    assert.equal(evidence?.passed, false)
  } finally {
    await initial.close()
  }
  const restarted = new LocalAgentHost(options)
  try {
    const { turns } = restarted.getConversationHistory({ conversationId })
    assert.equal(turns[0]?.taskId, taskId)
    assert.equal(turns[0]?.verification?.verdict, 'unverified')
    assert.equal(restarted.getTask(taskId).verification?.passed, false)
  } finally {
    await restarted.close()
  }
})

test('successful write receipts are facts and an unrelated file cannot satisfy a declared check', async (t) => {
  const options = await fixture(t)
  const host = new LocalAgentHost({
    ...options, execution: execution(async (config, prompt) => {
      const path = prompt.includes('With expected file') ? 'expected.txt'
        : prompt.includes('Write a note') ? 'note.txt' : 'unrelated.txt'
      const result = await tool(config, 'create_text_file', { path, content: 'expected output' })
      assert.ok(result && typeof result === 'object' && 'ok' in result && result.ok === true)
      return 'Work complete'
    }),
  })
  try {
    const run = async (requestId: string, goal: string, checked: boolean) => {
      const { taskId } = await host.createTask({
        requestId, goal, cwd: options.cwd, workspaceAccess: 'write',
        ...(checked ? { check: { path: 'expected.txt', contains: 'expected output' } } : {}),
      })
      await host.idle()
      return host.getHistory(taskId)
    }
    const missed = await run('unrelated', 'Change something else', true)
    assert.equal(missed.operations[0]?.status, 'succeeded')
    assert.equal(missed.task.status, 'failed')
    assert.equal(missed.task.verification?.verdict, 'failed')
    const unverified = await run('no-check', 'Write a note', false)
    assert.equal(unverified.operations[0]?.status, 'succeeded')
    assert.deepEqual(unverified.task.verification, {
      passed: false, verdict: 'unverified', evidence: 'confirmed_workspace_operation', basis: 'none',
    })
    const verified = await run('verified', 'With expected file', true)
    assert.equal(verified.task.status, 'succeeded')
    assert.deepEqual(verified.task.verification, {
      passed: true, verdict: 'verified', evidence: 'workspace_file_contains_expected_text', basis: 'workspace_path',
    })
  } finally {
    await host.close()
  }
})

test('a failed tool and an empty response cannot produce a completed task', async (t) => {
  const options = await fixture(t)
  const host = new LocalAgentHost({
    ...options, execution: execution(async config => {
      await tool(config, 'read_text_file', { path: 'missing.txt' })
      return ''
    }),
  })
  try {
    const { taskId } = await host.createTask({ requestId: 'failure', goal: 'Read a file', cwd: options.cwd })
    await host.idle()
    const history = host.getHistory(taskId)
    assert.equal(history.operations[0]?.status, 'failed')
    assert.equal(history.task.status, 'failed')
    assert.equal(history.task.verification?.evidence, 'tool_execution_failed')
    assert.equal(history.task.verification?.passed, false)
  } finally {
    await host.close()
  }
})

test('legacy text and tool-only acceptance remains unverified without mutating stored history', (t) => {
  const store = new LocalStore(':memory:')
  t.after(() => store.close())
  const engine = new TaskEngine(store)
  for (const evidence of ['assistant_response_present', 'confirmed_workspace_operation', 'workspace_text_file_exists']) {
    const { taskId } = engine.create({ requestId: evidence, goal: 'Legacy goal', cwd: 'ignored' })
    const snapshot = { ...engine.get(taskId), status: 'succeeded', verification: { passed: true, evidence } }
    store.transaction(() => store.put('tasks', taskId, snapshot))
    const verified = evidence === 'workspace_text_file_exists'
    assert.equal(engine.get(taskId).verification?.verdict, verified ? 'verified' : 'unverified')
    assert.equal(engine.get(taskId).verification?.passed, verified)
    assert.deepEqual(store.get('tasks', taskId), snapshot)
  }
})
