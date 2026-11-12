import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { ConversationObservatory, ManagedOperation } from '../../shared/contracts/management.ts'
import { FakeExecution } from '../src/fake.ts'
import type { AgentExecution, ExecutionConfig } from '../src/execution.ts'
import { LocalAgentHost } from '../src/host.ts'
import { ExtensionRegistry } from '../src/policies.ts'

async function fixture(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'zlo-management-'))
  const workspace = join(path, 'workspace')
  await mkdir(workspace)
  t.after(() => rm(path, { recursive: true, force: true }))
  return { workspace, directory: join(path, 'state') }
}

test('workspace revocation quiesces the current run and persists across Host restarts', async (t) => {
  const { directory, workspace } = await fixture(t)
  const options = { directory, execution: new FakeExecution() }
  const host = new LocalAgentHost(options)
  const { id } = host.createConversation({ requestId: 'create', workspace, workspaceAccess: 'write' })
  const { taskId } = await host.sendMessage({ conversationId: id, requestId: 'send', text: 'slow task' })
  try {
    assert.equal(host.getTask(taskId).status, 'running')
    assert.throws(() => host.setConversationWorkspaceAccess(id, 'trusted', 'write'), /Stop the current run/)
    const revoked = host.setConversationWorkspaceAccess(id, 'read', 'write')
    assert.equal(revoked.workspaceAccess, 'read')
    assert.equal(host.getTask(taskId).workspaceAccess, 'read')
    assert.throws(() => host.setConversationWorkspaceAccess(id, 'trusted', 'write'), /permission changed/)
    await host.idle()
    assert.equal(host.getTask(taskId).status, 'stopped')
    const current = await host.managementSnapshot(id)
    assert.equal(current.tasks[0]?.nodes[0]?.access, 'read')
    assert.equal(current.tools.find(tool => tool.name === 'create_text_file')?.root, false)
    await host.saveAgentPreferences({ ...current.preferences, disabledTools: ['search_files'], workspaceAccess: 'read' })
  } finally { await host.close() }
  const restarted = new LocalAgentHost(options)
  try {
    const view = await restarted.managementSnapshot(id)
    assert.equal(view.conversation?.workspaceAccess, 'read')
    assert.equal(view.tools.find(tool => tool.name === 'search_files')?.enabled, false)
    assert.equal(view.preferences.workspaceAccess, 'read')
    assert.throws(() => restarted.getConversation(randomUUID()), /does not exist/)
    const next = restarted.createConversation({ requestId: 'next', workspace })
    assert.equal(next.workspaceAccess, 'read')
  } finally { await restarted.close() }
})

test('conversation observatory aggregates beyond a history page, preserves pricing coverage and isolates conversations', async (t) => {
  const { directory, workspace } = await fixture(t)
  const fake = new FakeExecution()
  const execution: AgentExecution = {
    validateRoute: route => fake.validateRoute(route),
    async open(config) {
      const session = await fake.open(config)
      return { ...session, async run(prompt) {
        config.onEvent({ type: 'model.request_started' })
        await config.tools.find(tool => tool.name === 'list_directory')!.execute(randomUUID(), { path: '.' })
        config.onEvent({ type: 'model.usage', input: 12, output: 8, cacheRead: 4, cacheWrite: 2,
          ...(prompt.includes('priced-turn') ? { estimatedCostUsd: 0.125 } : {}) })
        return { status: 'completed', text: 'Workspace inspected' }
      } }
    },
  }
  const options = { directory, execution }
  const host = new LocalAgentHost(options)
  const first = host.createConversation({ requestId: 'first', workspace }).id
  const second = host.createConversation({ requestId: 'second', workspace }).id
  const inspect = (instance: LocalAgentHost, conversationId: string) => instance.managementCommand({
    schemaVersion: 1, type: 'conversationObservatory', conversationId,
  }) as Promise<ConversationObservatory>
  let expected: ConversationObservatory
  try {
    let latestTaskId: string | undefined
    for (let index = 0; index < 52; index++) {
      const { taskId } = await host.sendMessage({ conversationId: first, requestId: 'turn-' + index,
        text: index === 0 ? 'List files priced-turn' : 'List workspace files' })
      await host.idle()
      latestTaskId = taskId
    }
    await host.sendMessage({ conversationId: second, requestId: 'other-turn', text: 'List files separately' })
    await host.idle()
    assert.equal(host.getConversationHistory({ conversationId: first }).turns.length, 50)
    expected = await inspect(host, first)
    assert.equal(expected.turns, 52)
    assert.deepEqual(expected.usage, { input: 624, output: 416, cacheRead: 208, cacheWrite: 104 })
    assert.equal(expected.modelRequests, 52)
    assert.equal(expected.usageReports, 52)
    assert.equal(expected.pricedReports, 1)
    assert.equal(expected.estimatedCostUsd, 0.125)
    assert.deepEqual(expected.tools, [{ name: 'list_directory', status: 'succeeded', count: 52 }])
    assert.equal(expected.latestTask?.id, latestTaskId)
    const other = await inspect(host, second)
    assert.equal(other.turns, 1)
    assert.equal(other.modelRequests, 1)
    assert.equal(other.estimatedCostUsd, null)
    await assert.rejects(inspect(host, randomUUID()), /does not exist/)
  } finally { await host.close() }
  const restarted = new LocalAgentHost(options)
  try { assert.deepEqual(await inspect(restarted, first), expected) }
  finally { await restarted.close() }
})

test('the tool gateway revokes an already exposed capability before its next invocation', { timeout: 15000 }, async (t) => {
  const { directory, workspace } = await fixture(t)
  const fake = new FakeExecution()
  const opened = Promise.withResolvers<ExecutionConfig>()
  const proceed = Promise.withResolvers<void>()
  let result: unknown
  const execution: AgentExecution = {
    validateRoute: route => fake.validateRoute(route),
    async open(config) {
      const session = await fake.open(config)
      return { ...session, async run() {
        opened.resolve(config)
        await proceed.promise
        result = await config.tools.find(tool => tool.name === 'search_files')!.execute('late-call', { pattern: '*' })
        return { status: 'completed', text: 'Done' }
      } }
    },
  }
  const host = new LocalAgentHost({ directory, execution })
  try {
    const { id } = host.createConversation({ requestId: 'conversation', workspace })
    await host.sendMessage({ requestId: 'message', conversationId: id, text: 'Search the workspace' })
    const config = await Promise.race([
      opened.promise,
      host.idle().then(() => { throw new Error('Task finished before opening its execution session') }),
    ])
    assert.ok(config.tools.some(tool => tool.name === 'search_files'))
    const snapshot = await host.managementSnapshot(id)
    await host.saveAgentPreferences({ ...snapshot.preferences, disabledTools: ['search_files'] })
    proceed.resolve()
    await host.idle()
    assert.deepEqual(result, { ok: false, error: 'Tool work is unavailable' })
  } finally { proceed.resolve(); await host.close() }
})

test('reconciliation verifies a recorded file postcondition after restart and refuses unrelated or changed evidence', async (t) => {
  const { directory, workspace } = await fixture(t)
  const registry = new ExtensionRegistry([{ id: 'fault', tools(root, role, access) {
    return root.tools(role, access).filter(tool => tool.name === 'create_text_file').map(tool => ({
      ...tool, async execute(...args) {
        await tool.execute(...args)
        throw new Error('Simulated crash between effect and receipt')
      },
    }))
  } }])
  registry.registerProfile({ id: 'fault', plugins: ['fault'], workflow: 'coding', delegation: false, workspaceWrites: true })
  const fake = new FakeExecution()
  const execution: AgentExecution = {
    validateRoute: route => fake.validateRoute(route),
    async open(config) {
      const session = await fake.open(config)
      return { ...session, async run() {
        await config.tools.find(tool => tool.name === 'create_text_file')!.execute('write', { path: 'target.txt', content: 'expected' })
        return { status: 'completed', text: 'Done' }
      } }
    },
  }
  const options = { directory, execution, extensions: registry, profileId: 'fault' }
  const host = new LocalAgentHost(options)
  let conversationId: string, taskId: string, operationId: string, unrelated: string
  try {
    conversationId = host.createConversation({ requestId: 'first', workspace }).id
    unrelated = host.createConversation({ requestId: 'second', workspace }).id
    taskId = (await host.sendMessage({ requestId: 'send', conversationId, text: 'Make target.txt' })).taskId
    await host.idle()
    assert.equal(host.getTask(taskId).status, 'needs_reconciliation')
    const snapshot = await host.managementSnapshot(conversationId)
    operationId = snapshot.tasks[0]!.operations[0]!.id
    assert.equal(snapshot.tasks[0]!.operations[0]!.status, 'unknown_effect')
    assert.doesNotMatch(JSON.stringify(snapshot), /workspaceIdentity|filePostcondition/u)
  } finally { await host.close() }
  const restarted = new LocalAgentHost(options)
  try {
    const command = { schemaVersion: 1, type: 'reconcileOperation', conversationId, taskId, operationId } as const
    await assert.rejects(restarted.managementCommand({ ...command, conversationId: unrelated }), /does not belong/)
    await writeFile(join(workspace, 'target.txt'), 'wrong')
    const mismatch = await restarted.managementCommand(command) as ManagedOperation
    assert.equal(mismatch.reconciliation?.status, 'unresolved')
    assert.equal(restarted.getTask(taskId).status, 'needs_reconciliation')
    await writeFile(join(workspace, 'target.txt'), 'expected')
    const matched = await restarted.managementCommand(command) as ManagedOperation
    assert.equal(matched.reconciliation?.evidence, 'file_content_matches_recorded_postcondition')
    assert.equal(restarted.getTask(taskId).status, 'stopped')
    assert.equal(await readFile(join(workspace, 'target.txt'), 'utf8'), 'expected')
    assert.deepEqual(await restarted.managementCommand(command), matched)
    await delay(10)
    assert.equal(restarted.getHistory(taskId).operations.length, 1)
  } finally { await restarted.close() }
})
