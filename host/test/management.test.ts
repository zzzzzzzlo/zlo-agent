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
import type { JudgmentOptions } from '../src/judgment.ts'
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
    assert.equal(expected.estimatedCostCny, 0.9)
    assert.equal(expected.usdToCnyRate, 7.2)
    assert.equal(expected.completion?.ended, 52)
    assert.equal(expected.completion?.unverified, 52)
    assert.equal(expected.turnMetrics?.length, 30)
    assert.equal(expected.turnMetrics?.at(-1)?.taskId, latestTaskId)
    assert.deepEqual(expected.tools, [{ name: 'list_directory', status: 'succeeded', count: 52 }])
    assert.equal(expected.latestTask?.id, latestTaskId)
    const other = await inspect(host, second)
    assert.equal(other.turns, 1)
    assert.equal(other.modelRequests, 1)
    assert.equal(other.estimatedCostUsd, null)
    assert.equal(other.estimatedCostCny, null)
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

test('evaluation evidence and reconciliation never invoke Git unless workspace access is currently trusted', async (t) => {
  const { directory, workspace } = await fixture(t)
  const { execFileSync } = await import('node:child_process')
  const { CodingWorkspace } = await import('../src/workspace.ts')
  const { evaluationEvidence } = await import('../src/telemetry-evidence.ts')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'ignore', windowsHide: true })
  git('init', '-q')
  await writeFile(join(workspace, 'note.txt'), 'initial\n')
  git('add', '--', 'note.txt')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'init')
  await writeFile(join(workspace, 'note.txt'), 'changed\n')

  let gitDiffCalls = 0
  const originalDiff = CodingWorkspace.prototype.gitDiffSnapshot
  t.mock.method(CodingWorkspace.prototype, 'gitDiffSnapshot', async function (this: InstanceType<typeof CodingWorkspace>, ...args: Parameters<typeof originalDiff>) {
    gitDiffCalls++
    return originalDiff.apply(this, args)
  })

  const registry = new ExtensionRegistry([{ id: 'git-fault', tools(root, role, access) {
    return [
      ...root.tools(role, access).filter(tool => tool.name === 'read_text_file'),
      ...(access === 'trusted' ? [{
        name: 'git_commit', description: 'Faulting git commit', effect: 'write' as const,
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        async execute() { throw new Error('Simulated crash during git commit') },
      }] : []),
    ]
  } }])
  registry.registerProfile({ id: 'git-fault', plugins: ['git-fault'], workflow: 'coding', delegation: false, workspaceWrites: true })

  let runMode: 'read_only' | 'git_crash' = 'read_only'
  const fake = new FakeExecution()
  const execution: AgentExecution = {
    validateRoute: route => fake.validateRoute(route),
    async open(config) {
      const session = await fake.open(config)
      return {
        ...session,
        async run() {
          if (runMode === 'git_crash') {
            await config.tools.find(tool => tool.name === 'git_commit')!.execute('commit-1', {})
          } else {
            await config.tools.find(tool => tool.name === 'read_text_file')!.execute('read-1', { path: 'note.txt' })
          }
          return { status: 'completed', text: 'Inspected' }
        },
      }
    },
  }

  const host = new LocalAgentHost({ directory, execution, extensions: registry, profileId: 'git-fault' })
  try {
    // 1. Low-privilege ('read' and 'write') evaluationEvidence must not call Git
    for (const access of ['read', 'write'] as const) {
      const conv = host.createConversation({ requestId: 'conv-' + access, workspace, workspaceAccess: access })
      const { taskId } = await host.sendMessage({ requestId: 'msg-' + access, conversationId: conv.id, text: 'Inspect note' })
      await host.idle()
      const evidence = await evaluationEvidence(host.getHistory(taskId), undefined, ['note.txt'], AbortSignal.timeout(5_000))
      assert.equal(evidence.artifacts.length, 1)
      assert.equal(evidence.artifacts[0]!.diff, undefined)
    }
    assert.equal(gitDiffCalls, 0)

    // Trusted task DOES collect Git diff
    const trustedConv = host.createConversation({ requestId: 'conv-trusted', workspace, workspaceAccess: 'trusted' })
    const { taskId: trustedTaskId } = await host.sendMessage({ requestId: 'msg-trusted', conversationId: trustedConv.id, text: 'Inspect trusted' })
    await host.idle()
    const trustedEvidence = await evaluationEvidence(host.getHistory(trustedTaskId), undefined, ['note.txt'], AbortSignal.timeout(5_000))
    assert.ok(gitDiffCalls > 0)
    assert.match(trustedEvidence.artifacts[0]!.diff ?? '', /\+changed/u)

    // 2. Downgrading conversation permission before reconcileOperation must skip Git probe
    runMode = 'git_crash'
    const { taskId: crashedTaskId } = await host.sendMessage({ requestId: 'msg-crash', conversationId: trustedConv.id, text: 'Commit note' })
    await host.idle()
    assert.equal(host.getTask(crashedTaskId).status, 'needs_reconciliation')
    const crashedSnapshot = await host.managementSnapshot(trustedConv.id)
    const opId = crashedSnapshot.tasks[0]!.operations.find(op => op.tool === 'git_commit')!.id

    let gitStatusCalls = 0
    const originalTools = CodingWorkspace.prototype.tools
    t.mock.method(CodingWorkspace.prototype, 'tools', function (this: InstanceType<typeof CodingWorkspace>, ...args: Parameters<typeof originalTools>) {
      return originalTools.apply(this, args).map(tool => tool.name !== 'git_status' ? tool : {
        ...tool,
        async execute(...execArgs: Parameters<typeof tool.execute>) {
          gitStatusCalls++
          return tool.execute(...execArgs)
        },
      })
    })

    host.setConversationWorkspaceAccess(trustedConv.id, 'write', 'trusted')
    const downgradedProbe = await host.managementCommand({
      schemaVersion: 1, type: 'reconcileOperation', conversationId: trustedConv.id, taskId: crashedTaskId, operationId: opId,
    }) as ManagedOperation
    assert.equal(downgradedProbe.reconciliation?.status, 'unresolved')
    assert.equal(downgradedProbe.reconciliation?.evidence, 'git_probe_requires_trusted_workspace')
    assert.equal(gitStatusCalls, 0)
  } finally {
    await host.close()
  }
})

test('P0-2: interrupted Git reads and pre-write errors stay structured, postconditions verify edits/patches/deletes, and acknowledged unknown effects block automatic replay', async (t) => {
  const { directory, workspace } = await fixture(t)
  const { execFileSync } = await import('node:child_process')
  const { rm } = await import('node:fs/promises')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'ignore', windowsHide: true })
  git('init', '-q')
  await writeFile(join(workspace, 'edit.txt'), 'before-edit\n')
  await writeFile(join(workspace, 'patch-a.txt'), 'alpha-1\n')
  await writeFile(join(workspace, 'patch-b.txt'), 'beta-1\n')
  await writeFile(join(workspace, 'remove.txt'), 'to-delete\n')
  git('add', '--', 'edit.txt', 'patch-a.txt', 'patch-b.txt', 'remove.txt')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'init')

  // 1. Pre-write errors return { ok: false } instead of throwing into unknown_effect
  const { CodingWorkspace } = await import('../src/workspace.ts')
  const fsPromises = await import('node:fs/promises')
  const cw = new CodingWorkspace(workspace)
  const createTool = cw.tools('root', 'write').find(item => item.name === 'create_text_file')!
  const originalOpen = fsPromises.open
  // Verify normal duplicate error is structured
  assert.equal((await createTool.execute('dup', { path: 'edit.txt', content: 'dup' }) as { ok: boolean }).ok, false)
  void originalOpen

  // 2. Postcondition verification for edit_text_file, apply_patch, delete_file, plus user acknowledgement & replay blocking
  const { createFileTools } = await import('../src/file-tools.ts')
  let scenario: 'git_read_abort' | 'edit_crash' | 'patch_crash' | 'delete_crash' | 'unknown_cmd' | 'resume_replay' = 'git_read_abort'
  let replayResult: unknown
  let safeNewWriteResult: unknown
  const registry = new ExtensionRegistry([{
    id: 'p02-suite',
    tools(root, role, access) {
      const base = [
        ...root.tools(role, access).filter(tool => ['read_text_file', 'create_text_file', 'edit_text_file', 'git_diff', 'git_status'].includes(tool.name)),
        ...createFileTools(root).filter(tool => ['apply_patch', 'delete_file'].includes(tool.name)),
      ]
      return base.map(tool => {
        if (tool.name === 'edit_text_file') {
          return {
            ...tool,
            async execute(...args: Parameters<typeof tool.execute>) {
              if (scenario === 'edit_crash') {
                await writeFile(join(workspace, 'edit.txt'), 'after-edit\n')
                throw new Error('Crash after rename')
              }
              return tool.execute(...args)
            },
          }
        }
        if (tool.name === 'apply_patch') {
          return {
            ...tool,
            async execute(...args: Parameters<typeof tool.execute>) {
              if (scenario === 'patch_crash') {
                await writeFile(join(workspace, 'patch-a.txt'), 'alpha-2\n')
                throw new Error('Crash mid-patch')
              }
              return tool.execute(...args)
            },
          }
        }
        if (tool.name === 'delete_file') {
          return {
            ...tool,
            async execute(...args: Parameters<typeof tool.execute>) {
              if (scenario === 'delete_crash') {
                await rm(join(workspace, 'remove.txt'))
                throw new Error('Crash after unlink')
              }
              return tool.execute(...args)
            },
          }
        }
        return tool
      }).concat(access === 'trusted' ? [{
        name: 'custom_mutation',
        description: 'Unverifiable external write',
        effect: 'write' as const,
        parameters: { type: 'object', additionalProperties: false, properties: { tag: { type: 'string' } }, required: ['tag'] },
        async execute(_id, input) {
          if (scenario === 'unknown_cmd') throw new Error('Process vanished')
          return { ok: true, input }
        },
      }] : [])
    },
  }])
  registry.registerProfile({ id: 'p02', plugins: ['p02-suite'], workflow: 'coding', delegation: false, workspaceWrites: true })

  const fake = new FakeExecution()
  const execution: AgentExecution = {
    verifySession: (ref) => fake.verifySession(ref),
    validateRoute: route => fake.validateRoute(route),
    async open(config) {
      const session = await fake.open(config)
      return {
        ...session,
        async run(prompt) {
          await session.run('fast')
          if (scenario === 'git_read_abort') {
            const abort = new AbortController()
            abort.abort()
            const res = await config.tools.find(item => item.name === 'git_diff')!.execute('gd-1', { path: 'edit.txt' }, abort.signal) as { ok: boolean }
            assert.equal(res.ok, false)
            return { status: 'interrupted' }
          }
          if (scenario === 'edit_crash') {
            await config.tools.find(item => item.name === 'edit_text_file')!.execute('ed-1', {
              path: 'edit.txt', oldText: 'before-edit', newText: 'after-edit',
            })
          }
          if (scenario === 'patch_crash') {
            await config.tools.find(item => item.name === 'apply_patch')!.execute('pa-1', {
              edits: [
                { path: 'patch-a.txt', oldText: 'alpha-1', newText: 'alpha-2' },
                { path: 'patch-b.txt', oldText: 'beta-1', newText: 'beta-2' },
              ],
            })
          }
          if (scenario === 'delete_crash') {
            await config.tools.find(item => item.name === 'delete_file')!.execute('del-1', { path: 'remove.txt' })
          }
          if (scenario === 'unknown_cmd') {
            await config.tools.find(item => item.name === 'custom_mutation')!.execute('cm-1', { tag: 'risky-1' })
          }
          if (scenario === 'resume_replay') {
            assert.match(prompt, /Resume the task using the saved conversation/u)
            replayResult = await config.tools.find(item => item.name === 'custom_mutation')!.execute('cm-replay', { tag: 'risky-1' })
            safeNewWriteResult = await config.tools.find(item => item.name === 'create_text_file')!.execute('new-safe', {
              path: 'fresh-after-resume.txt', content: 'ok\n',
            })
          }
          return { status: 'completed', text: 'Done' }
        },
      }
    },
  }

  const host = new LocalAgentHost({
    directory, execution, extensions: registry, profileId: 'p02',
    approveTool: async () => ({ approved: true }),
  })
  try {
    const conv = host.createConversation({ requestId: 'c-p02', workspace, workspaceAccess: 'read' })
    host.setConversationWorkspaceAccess(conv.id, 'trusted', 'read')

    // (a) Interrupted git_diff settles to 'stopped' (read accounting), never 'needs_reconciliation'
    scenario = 'git_read_abort'
    const { taskId: gitReadTask } = await host.sendMessage({ requestId: 'm-git-read', conversationId: conv.id, text: 'Inspect diff' })
    await host.idle()
    assert.equal(host.getTask(gitReadTask).status, 'stopped')

    // (b) edit_text_file postcondition verifies cleanly -> task transitions to 'stopped'
    scenario = 'edit_crash'
    const { taskId: editTask } = await host.sendMessage({ requestId: 'm-edit', conversationId: conv.id, text: 'Edit file' })
    await host.idle()
    assert.equal(host.getTask(editTask).status, 'needs_reconciliation')
    const editOpId = (await host.managementSnapshot(conv.id)).tasks[0]!.operations.find(op => op.tool === 'edit_text_file')!.id
    const editChecked = await host.managementCommand({
      schemaVersion: 1, type: 'reconcileOperation', conversationId: conv.id, taskId: editTask, operationId: editOpId,
    }) as ManagedOperation
    assert.equal(editChecked.reconciliation?.status, 'verified')
    assert.equal(editChecked.reconciliation?.evidence, 'file_content_matches_recorded_postcondition')
    assert.equal(host.getTask(editTask).status, 'stopped')

    // (c) apply_patch partial state stays unresolved, then full postcondition verifies
    scenario = 'patch_crash'
    const { taskId: patchTask } = await host.sendMessage({ requestId: 'm-patch', conversationId: conv.id, text: 'Patch files' })
    await host.idle()
    assert.equal(host.getTask(patchTask).status, 'needs_reconciliation')
    const patchOpId = (await host.managementSnapshot(conv.id)).tasks[0]!.operations.find(op => op.tool === 'apply_patch')!.id
    const partialPatch = await host.managementCommand({
      schemaVersion: 1, type: 'reconcileOperation', conversationId: conv.id, taskId: patchTask, operationId: patchOpId,
    }) as ManagedOperation
    assert.equal(partialPatch.reconciliation?.status, 'unresolved')
    assert.equal(partialPatch.reconciliation?.evidence, 'patch_partially_applied_or_modified')
    await writeFile(join(workspace, 'patch-b.txt'), 'beta-2\n')
    const fullPatch = await host.managementCommand({
      schemaVersion: 1, type: 'reconcileOperation', conversationId: conv.id, taskId: patchTask, operationId: patchOpId,
    }) as ManagedOperation
    assert.equal(fullPatch.reconciliation?.status, 'verified')
    assert.equal(fullPatch.reconciliation?.evidence, 'patch_matches_recorded_postcondition')
    assert.equal(host.getTask(patchTask).status, 'stopped')

    // (d) delete_file postcondition verifies deletion -> 'stopped'
    scenario = 'delete_crash'
    const { taskId: delTask } = await host.sendMessage({ requestId: 'm-del', conversationId: conv.id, text: 'Delete file' })
    await host.idle()
    assert.equal(host.getTask(delTask).status, 'needs_reconciliation')
    const delOpId = (await host.managementSnapshot(conv.id)).tasks[0]!.operations.find(op => op.tool === 'delete_file')!.id
    const delChecked = await host.managementCommand({
      schemaVersion: 1, type: 'reconcileOperation', conversationId: conv.id, taskId: delTask, operationId: delOpId,
    }) as ManagedOperation
    assert.equal(delChecked.reconciliation?.status, 'verified')
    assert.equal(delChecked.reconciliation?.evidence, 'file_deleted_matches_postcondition')
    assert.equal(host.getTask(delTask).status, 'stopped')

    // (e) Unprovable write: probe stays unresolved; user acknowledgement binds conversation/task/op, preserves unknown_effect history, and blocks replay on resume
    scenario = 'unknown_cmd'
    const { taskId: unknownTask } = await host.sendMessage({ requestId: 'm-unk', conversationId: conv.id, text: 'Run custom mutation' })
    await host.idle()
    assert.equal(host.getTask(unknownTask).status, 'needs_reconciliation')
    const unkOpId = (await host.managementSnapshot(conv.id)).tasks[0]!.operations.find(op => op.tool === 'custom_mutation')!.id
    const probed = await host.managementCommand({
      schemaVersion: 1, type: 'reconcileOperation', conversationId: conv.id, taskId: unknownTask, operationId: unkOpId,
    }) as ManagedOperation
    assert.equal(probed.reconciliation?.status, 'unresolved')

    const otherConv = host.createConversation({ requestId: 'c-other', workspace })
    await assert.rejects(host.managementCommand({
      schemaVersion: 1, type: 'reconcileOperation', conversationId: otherConv.id, taskId: unknownTask, operationId: unkOpId, disposition: 'acknowledge',
    }), /does not belong/u)

    const acknowledged = await host.managementCommand({
      schemaVersion: 1, type: 'reconcileOperation', conversationId: conv.id, taskId: unknownTask, operationId: unkOpId, disposition: 'acknowledge',
    }) as ManagedOperation
    assert.equal(acknowledged.status, 'unknown_effect')
    assert.equal(acknowledged.reconciliation?.status, 'acknowledged')
    assert.equal(acknowledged.reconciliation?.evidence, 'user_acknowledged_after_inspection')
    assert.equal(host.getTask(unknownTask).status, 'stopped')

    scenario = 'resume_replay'
    const resumed = host.resumeConversation({ requestId: 'r-unk', conversationId: conv.id, taskId: unknownTask })
    assert.equal(resumed.accepted, true)
    await host.idle()
    assert.equal(host.getTask(unknownTask).status, 'succeeded')
    assert.deepEqual(replayResult, {
      ok: false,
      code: 'REPLAY_BLOCKED',
      error: 'A previous invocation of this write operation had an unconfirmed effect and cannot be replayed automatically. Inspect current workspace state first or ask the user before making a new change.',
    })
    assert.deepEqual(safeNewWriteResult, { ok: true })
    // Historical unprovable operation still retains unknown_effect status after task completion
    const historyOps = host.getHistory(unknownTask).operations
    const historical = historyOps.find(op => op.id === unkOpId)!
    assert.equal(historical.status, 'unknown_effect')
    assert.equal(historical.reconciliation?.status, 'acknowledged')
  } finally {
    await host.close()
  }
})

test('saving trusted default workspaceAccess preserves trusted when creating new conversations', async (t) => {
  const { directory, workspace } = await fixture(t)
  const host = new LocalAgentHost({ directory, execution: new FakeExecution() })
  try {
    const conv = host.createConversation({ requestId: 'seed', workspace })
    const initial = await host.managementSnapshot(conv.id)
    const saved = await host.saveAgentPreferences({ ...initial.preferences, workspaceAccess: 'trusted' })
    assert.equal(saved.workspaceAccess, 'trusted')
    const trustedConv = host.createConversation({ requestId: 'new-after-trusted', workspace })
    assert.equal(trustedConv.workspaceAccess, 'trusted')
  } finally {
    await host.close()
  }
})

test('conversation observatory tracks causal Jev interventions across turns and preserves restart determinism without leaking private text', async (t) => {
  const { directory, workspace } = await fixture(t)
  const fake = new FakeExecution()
  let completionCalls = 0
  const extensions = new ExtensionRegistry([{
    id: 'mockweb',
    tools: () => [{
      name: 'web_fetch',
      effect: 'read',
      description: 'Mock fetch',
      parameters: {},
      execute: async () => ({
        ok: true, untrusted: true, title: 'Spec',
        text: 'benign documentation PRIVATE_OBSERVATORY_PROMPT_SECRET',
      }),
    }],
  }])
  const execution: AgentExecution = {
    validateRoute: route => fake.validateRoute(route),
    async open(config) {
      const session = await fake.open(config)
      let turn = 0
      return {
        ...session,
        async run() {
          turn++
          if (turn === 1) {
            await config.tools.find(tool => tool.name === 'web_fetch')!.execute(randomUUID(), {})
            await config.tools.find(tool => tool.name === 'create_text_file')!.execute(randomUUID(), {
              path: 'one.txt', content: 'first file',
            })
            return { status: 'completed', text: 'First pass' }
          }
          await config.tools.find(tool => tool.name === 'create_text_file')!.execute(randomUUID(), {
            path: 'two.txt', content: 'second file',
          })
          return { status: 'completed', text: 'Completed follow-up pass' }
        },
      }
    },
  }
  const judgment: JudgmentOptions = {
    policy: (point) => ({
      mode: point === 'tool.injection' || point === 'turn.completion' || point === 'memory.capture' ? 'active' : 'off',
      allowScopedEvidence: true,
      judge: {
        async evaluate(request) {
          if (request.id === 'turn.completion') {
            completionCalls++
            return {
              output: completionCalls === 1,
              model: 'jev-test-1',
              requestSent: true,
              usage: { input: 20, output: 2, estimatedCostUsd: 0.005 },
            }
          }
          return { output: false }
        },
        async evaluateBatch(request) {
          return {
            model: 'jev-test-1',
            requestSent: true,
            usage: { input: 30, output: 3, estimatedCostUsd: 0.005 },
            items: request.items.map((_, index) => ({
              output: request.id === 'tool.injection' ? index === 1 : index !== 0,
            })),
          }
        },
      },
    }),
  }
  const options = { directory, execution, extensions, judgment }
  const host = new LocalAgentHost(options)
  let convId: string
  let snapshotBeforeRestart: ConversationObservatory
  try {
    convId = host.createConversation({ requestId: 'jev-obs', workspace, workspaceAccess: 'write' }).id
    await host.sendMessage({
      requestId: 'msg-1', conversationId: convId, text: 'Inspect PRIVATE_OBSERVATORY_PROMPT_SECRET and write files',
    })
    await host.idle()
    snapshotBeforeRestart = await host.managementCommand({
      schemaVersion: 1, type: 'conversationObservatory', conversationId: convId,
    }) as ConversationObservatory
    const j = snapshotBeforeRestart.judgments!
    assert.equal(j.total, 3)
    assert.equal(j.injectionBlocks, 1)
    assert.equal(j.completionFollowUps, 1)
    assert.equal(j.memoryFiltered, 1)
    assert.equal(j.activeInterventions, 3)
    assert.equal(j.fallbacks, 0)
    assert.equal(Number(j.estimatedCostUsd?.toFixed(4)), 0.015)
    assert.equal(Number(j.estimatedCostCny?.toFixed(4)), 0.108)
    assert.ok(j.byPoint.some(p => p.point === 'tool.injection' && p.activeInterventions === 1))
    assert.ok(j.byPoint.some(p => p.point === 'turn.completion' && p.activeInterventions === 1))
    assert.ok(j.byPoint.some(p => p.point === 'memory.capture' && p.activeInterventions === 1))
    assert.ok(j.recent.some(item => item.point === 'tool.injection' && item.impactKind === 'intervened' && item.impactSummary.includes('隔离')))
    assert.ok(j.recent.some(item => item.point === 'turn.completion' && item.impactKind === 'intervened' && item.impactSummary.includes('补充自检')))
    assert.ok(j.recent.some(item => item.point === 'memory.capture' && item.impactKind === 'intervened' && item.impactSummary.includes('过滤 1 条')))
    assert.equal(snapshotBeforeRestart.turnMetrics?.[0]?.judgmentCalls, j.total)
    assert.equal(snapshotBeforeRestart.turnMetrics?.[0]?.judgmentInterventions, j.activeInterventions)
    assert.equal(JSON.stringify(j).includes('PRIVATE_OBSERVATORY_PROMPT_SECRET'), false)
  } finally {
    await host.close()
  }

  const restarted = new LocalAgentHost(options)
  try {
    const afterRestart = await restarted.managementCommand({
      schemaVersion: 1, type: 'conversationObservatory', conversationId: convId,
    }) as ConversationObservatory
    assert.deepEqual(afterRestart, snapshotBeforeRestart)
  } finally {
    await restarted.close()
  }
})
