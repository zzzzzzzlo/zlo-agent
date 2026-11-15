import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createArtifactTools } from '../src/artifact-tools.ts'
import { CodingCapabilities } from '../src/policies.ts'
import { LocalStore } from '../src/store.ts'
import { TaskEngine } from '../src/task-engine.ts'
import { ToolApprovalBroker } from '../src/tool-approval.ts'
import { ToolRun } from '../src/tool-run.ts'
import { CodingWorkspace } from '../src/workspace.ts'
import { publicReadApproval } from '../src/web-tools.ts'
import type { ToolApprovalMode } from '../../shared/contracts/tool-approval.ts'
import type { WorkspaceTool } from '../src/workspace.ts'

test('approval is single-use and a stopped run rejects a late native answer', async () => {
  const broker = new ToolApprovalBroker()
  let id: string | undefined
  let cancelled: string | undefined
  broker.subscribe(notice => {
    if (notice.kind === 'tool.approval') id = notice.request.id
    else cancelled = notice.approvalId
  })
  const stop = new AbortController()
  const approval = broker.request({ kind: 'shell', tool: 'shell_exec', detail: '{}', workspace: 'project' }, stop.signal)
  assert.ok(id)
  assert.equal(broker.resolve('unrelated', { approved: true }), false)
  stop.abort()
  assert.deepEqual(await approval, { approved: false })
  assert.equal(cancelled, id)
  assert.equal(broker.resolve(id, { approved: true }), false)
})

test('approval changes cancel only pending decisions for that task', async () => {
  const broker = new ToolApprovalBroker()
  const pending: string[] = []
  broker.subscribe(notice => { if (notice.kind === 'tool.approval') pending.push(notice.request.id) })
  const signal = new AbortController().signal
  const details = { kind: 'shell', tool: 'shell_exec', detail: '{}', workspace: 'project' } as const
  const left = broker.request(details, signal, 'one')
  const right = broker.request(details, signal, 'two')
  broker.cancelScope('one')
  assert.deepEqual(await left, { approved: false })
  assert.equal(broker.resolve(pending[0], { approved: true }), false)
  assert.equal(broker.resolve(pending[1], { approved: true }), true)
  assert.equal((await right).approved, true)
})

test('risk and unattended modes authorize only approved public reads and enforce the existing capability grant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zlo-tool-approval-mode-'))
  const db = new LocalStore(':memory:')
  try {
    const workspace = new CodingWorkspace(root)
    const tasks = new TaskEngine(db)
    const { taskId } = tasks.create({ requestId: 'approval-mode', cwd: root, goal: 'Check approval modes', workspaceAccess: 'trusted' })
    const task = tasks.start(taskId)
    const event = { taskId, taskNodeId: task.rootNodeId, taskAttemptId: task.attemptId, agentRunId: 'approval-mode-run', type: '', payload: {} }
    let mode: ToolApprovalMode = 'ask'
    const asked: string[] = []
    const executed: string[] = []
    let granted = true
    const run = new ToolRun(tasks, new ToolApprovalBroker(async request => {
      asked.push(request.tool)
      return { approved: false }
    }), undefined, undefined, undefined, () => mode)
    const tool = (name: string, effect: WorkspaceTool['effect'], policy: WorkspaceTool['policy']) =>
      run.wrap({
        name, description: '', parameters: {}, effect, policy,
        async execute() { executed.push(name); return { ok: true } },
      }, workspace, () => event, new AbortController().signal, () => granted)
    const get = tool('web_fetch', 'read', { approval: 'network', publicRead: publicReadApproval })
    const shell = tool('shell_exec', 'write', { approval: 'shell', publicRead: publicReadApproval })
    const url = { url: 'https://example.com/docs' }
    assert.equal((await get.execute('manual', url) as { ok: boolean }).ok, false)
    mode = 'routine'
    assert.deepEqual(await get.execute('automatic', url), { ok: true })
    assert.equal((await get.execute('query', { url: 'https://example.com/docs?q=x' }) as { ok: boolean }).ok, false)
    assert.equal((await shell.execute('shell-review', url) as { ok: boolean }).ok, false)
    mode = 'unattended'
    assert.deepEqual(await get.execute('background-read', url), { ok: true })
    assert.equal((await shell.execute('shell-blocked', url) as { ok: boolean }).ok, false)
    assert.equal((await get.execute('local-blocked', { url: 'https://127.0.0.1/path' }) as { ok: boolean }).ok, false)
    granted = false
    assert.equal((await get.execute('out-of-scope', url) as { ok: boolean }).ok, false)
    assert.deepEqual(asked, ['web_fetch', 'web_fetch', 'shell_exec'])
    assert.deepEqual(executed, ['web_fetch', 'web_fetch'])
    assert.equal(db.events(taskId).filter(e => e.type === 'tool.approval_resolved' && e.payload.automatic).length, 2)
    assert.equal(db.events(taskId).filter(e => e.type === 'tool.denied' && e.payload.reason === 'approval_unattended').length, 2)
    await run.close()
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('artifact export ignores model-supplied destinations and only creates the approved new file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zlo-export-'))
  const project = join(root, 'project')
  const privatePath = join(root, 'private')
  const bytes = Buffer.from([0, 1, 2, 3])
  const db = new LocalStore(':memory:')
  try {
    await Promise.all([mkdir(project), mkdir(privatePath)])
    await writeFile(join(project, 'artifact.bin'), bytes)
    const workspace = new CodingWorkspace(project)
    const tasks = new TaskEngine(db)
    const { taskId } = tasks.create({ requestId: 'export-test', cwd: project, goal: 'Export', workspaceAccess: 'write' })
    const task = tasks.start(taskId)
    const event = { taskId, taskNodeId: task.rootNodeId, taskAttemptId: task.attemptId, agentRunId: 'export-run', type: '', payload: {} }
    const expected = join(root, 'approved.bin')
    const fake = join(root, 'model.bin')
    let destination = join(privatePath, 'denied.bin')
    const broker = new ToolApprovalBroker(async () => ({ approved: true, destination }))
    const run = new ToolRun(tasks, broker)
    const exportTool = run.wrap(createArtifactTools(workspace, privatePath)[0], workspace, () => event, new AbortController().signal, () => true)
    assert.equal((await exportTool.execute('denied', { path: 'artifact.bin' }) as { ok: boolean }).ok, false)
    await assert.rejects(readFile(destination))
    destination = expected
    assert.deepEqual(await exportTool.execute('allowed', { path: 'artifact.bin', destination: fake }), { ok: true, bytes: 4 })
    assert.deepEqual(await readFile(expected), bytes)
    await assert.rejects(readFile(fake))
    assert.equal((await exportTool.execute('collision', { path: 'artifact.bin' }) as { ok: boolean }).ok, false)
    assert.deepEqual(tasks.operations(taskId).map(({ status }) => status).sort(), ['failed', 'failed', 'succeeded'])
    assert.ok(!JSON.stringify(db.events(taskId)).includes(expected))
    await run.close()
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('input-dependent tool authorization preserves read scope, approval and write receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zlo-tool-policy-'))
  const db = new LocalStore(':memory:')
  try {
    const workspace = new CodingWorkspace(root)
    const tasks = new TaskEngine(db)
    const { taskId } = tasks.create({ requestId: 'tool-policy', cwd: root, goal: 'Exercise tool policy', workspaceAccess: 'trusted' })
    const task = tasks.start(taskId)
    const event = { taskId, taskNodeId: task.rootNodeId, taskAttemptId: task.attemptId, agentRunId: 'tool-policy-run', type: '', payload: {} }
    const approvals: string[] = []
    const run = new ToolRun(tasks, new ToolApprovalBroker(async request => {
      approvals.push(request.kind)
      return { approved: false }
    }))
    const calls: unknown[] = []
    const tool: WorkspaceTool = {
      name: 'browser_screenshot', effect: 'read', description: '', parameters: {},
      policy: {
        effectFor: input => (input as { path?: string }).path ? 'write' : 'read',
        approvalFor: input => (input as { url?: string }).url ? 'network' : undefined,
      },
      async execute(_id, input) { calls.push(input); return { ok: true } },
    }
    const gateway = new CodingCapabilities()
    const signal = new AbortController().signal
    const as = (access: 'read' | 'trusted') =>
      run.wrap(tool, workspace, () => event, signal, input => gateway.authorize(gateway.root(access, false), tool, input))
    const saved = { path: 'capture.png' }
    assert.deepEqual(await as('read').execute('view', {}), { ok: true })
    assert.deepEqual(await as('read').execute('write-denied', saved), { ok: false, error: 'Tool work is unavailable' })
    assert.match((await as('trusted').execute('public-denied', { url: 'https://example.com' }) as { error: string }).error, /It did not run/)
    assert.deepEqual(await as('trusted').execute('saved', saved), { ok: true })
    assert.deepEqual(calls, [{}, saved])
    assert.deepEqual(approvals, ['network'])
    assert.deepEqual(new Map(tasks.operations(taskId).map(({ id, effect, target }) => [id, [effect, target]])),
      new Map([['tool-policy-run:view', ['read', undefined]], ['tool-policy-run:saved', ['write', saved.path]]]))
    await run.close()
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('only relevant workspace changes clear unchanged tool failures, and guards are isolated per run', async () => {
  const path = await mkdtemp(join(tmpdir(), 'zlo-tool-retries-'))
  const db = new LocalStore(':memory:')
  try {
    const workspace = new CodingWorkspace(path)
    const tasks = new TaskEngine(db)
    const { taskId } = tasks.create({ requestId: 'retry-scope', cwd: path, goal: 'Edit sample' })
    const task = tasks.start(taskId)
    const event = { taskId, taskNodeId: task.rootNodeId, taskAttemptId: task.attemptId, agentRunId: 'retry-root', type: '', payload: {} }
    const signal = new AbortController().signal
    let blocked = 0
    let executes = 0
    let changes = false
    let corrected = false
    const run = new ToolRun(tasks, new ToolApprovalBroker(), undefined, undefined, () => { blocked++ })
    const worker = new ToolRun(tasks, new ToolApprovalBroker())
    const patch: WorkspaceTool = {
      name: 'fixture_patch', description: '', parameters: {}, effect: 'write',
      async execute(_id, input) {
        executes++
        return corrected || (input as { text: string }).text === 'new plan' ? { ok: true } : { ok: false, error: 'Original mismatch' }
      },
    }
    const edit: WorkspaceTool = {
      name: 'fixture_edit', description: '', parameters: {}, effect: 'write',
      async execute() { return { ok: true, changed: changes } },
    }
    const bound = (toolRun: ToolRun, tool: WorkspaceTool) =>
      toolRun.guard(toolRun.wrap(tool, workspace, () => event, signal, () => true), () => event, signal, tool)
    const failing = bound(run, patch)
    const change = bound(run, edit)
    const input = { path: 'sample.txt', text: 'stale' }
    for (let i = 0; i < 4; i++) await failing.execute('initial-' + i, input)
    const otherArgs = await failing.execute('corrected-args', { ...input, path: 'other.txt', text: 'new plan' })
    assert.deepEqual(otherArgs, { ok: true })
    await change.execute('noop', { path: input.path })
    changes = true
    await change.execute('different-file', { path: 'elsewhere.txt' })
    assert.deepEqual(await bound(worker, patch).execute('worker-first', input), { ok: false, error: 'Original mismatch' })
    assert.equal(blocked, 0)
    await failing.execute('unchanged', { text: input.text, path: input.path })
    assert.equal(blocked, 1)
    assert.equal(executes, 6)
    await change.execute('changed-file', { path: input.path })
    corrected = true
    assert.deepEqual(await failing.execute('now-fixed', input), { ok: true })
    assert.equal(executes, 7)
    await Promise.all([run.close(), worker.close()])
  } finally {
    db.close()
    await rm(path, { recursive: true, force: true })
  }
})
