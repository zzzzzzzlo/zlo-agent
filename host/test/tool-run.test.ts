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
    assert.deepEqual(await as('trusted').execute('public-denied', { url: 'https://example.com' }),
      { ok: false, error: 'Operation was not authorized' })
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
