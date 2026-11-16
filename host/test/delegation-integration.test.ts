import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { toolImages } from '../src/execution.ts'
import type { ExecutionConfig, ExecutionResult, ToolImage } from '../src/execution.ts'
import { FakeExecution } from '../src/fake.ts'
import { LocalAgentHost } from '../src/host.ts'

interface Result {
  ok: boolean
  error?: string
  [toolImages]?: ToolImage[]
  [key: string]: unknown
}
type Call = (name: string, input: unknown) => Promise<Result>
type Script = (config: ExecutionConfig, call: Call, prompt: string) => Promise<string>

class DelegationFixture extends FakeExecution {
  readonly errors: unknown[] = []
  readonly #script: Script

  constructor(script: Script) { super(); this.#script = script }

  override async open(config: ExecutionConfig) {
    const session = await super.open(config)
    return {
      ...session,
      run: async (prompt: string): Promise<ExecutionResult> => {
        try {
          config.reserveRequest?.({ route: session.route, estimatedInputTokens: 20, maxOutputTokens: 80, kind: 'prompt' })
          config.onEvent({ type: 'model.request_started' })
          config.onEvent({ type: 'model.usage', input: 15, output: 5, cacheRead: 0, cacheWrite: 0 })
          const call: Call = async (name, input) => {
            const tool = config.tools.find(item => item.name === name)
            assert.ok(tool, `${config.role} is missing ${name}`)
            return await tool.execute(randomUUID(), input) as Result
          }
          return { status: 'completed', text: await this.#script(config, call, prompt) }
        } catch (error) {
          this.errors.push(error)
          return { status: 'runtime_error' }
        }
      },
    }
  }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'zlo-delegation-'))
  const cwd = join(root, 'project')
  await mkdir(join(cwd, 'src'), { recursive: true })
  t.after(() => rm(root, { recursive: true, force: true }))
  return { cwd, directory: join(root, 'state') }
}

test('a Team yields to a writable Worker and both remain within their inherited grant', { timeout: 15_000 }, async t => {
  const { cwd, directory } = await fixture(t)
  await writeFile(join(cwd, 'private.txt'), 'outside assigned scope')
  const tools = ['create_text_file', 'read_text_file']
  const check = { path: 'src/output.txt', contains: 'created by Worker' }
  const execution = new DelegationFixture(async (config, call) => {
    if (config.role === 'root') {
      assert.equal((await call('propose_task_plan', { nodes: [{ ref: 'team', role: 'team', teamKey: 'editing',
        goal: 'Coordinate the edit', access: 'write', scopePath: 'src', tools, check, budget: { requests: 2 } }] })).ok, true)
      return 'Team delivered the requested edit'
    }
    if (config.role === 'team') {
      assert.equal((await call('delegate_worker', { goal: 'Request excessive access', access: 'trusted' })).ok, false)
      assert.equal((await call('delegate_worker', { goal: 'Request an extra tool', access: 'write', tools: ['delete_file'] })).ok, false)
      assert.equal((await call('delegate_worker', { goal: 'Move outside parent scope', scopePath: 'src-other' })).ok, false)
      assert.equal((await call('delegate_worker', { goal: 'Request excessive budget', budget: { requests: 3 } })).ok, false)
      const delivery = await call('delegate_worker', { goal: 'Create the file', access: 'write', tools, check, budget: { requests: 1 } })
      assert.equal(delivery.ok, true)
      return 'Worker produced the expected file'
    }
    assert.deepEqual(config.tools.map(({ name }) => name).sort(), tools)
    assert.equal((await call('read_text_file', { path: 'private.txt' })).ok, false)
    assert.equal((await call('create_text_file', { path: 'outside.txt', content: 'denied' })).ok, false)
    assert.equal((await call('create_text_file', { path: check.path, content: check.contains })).ok, true)
    return 'Created the file within src'
  })
  const host = new LocalAgentHost({ directory, execution })
  try {
    const { taskId } = await host.createTask({ requestId: 'writable-worker', goal: 'Edit src through the Team', cwd, workspaceAccess: 'write', check })
    await host.idle()
    assert.deepEqual(execution.errors, [])
    const task = host.getTask(taskId)
    assert.equal(task.status, 'succeeded')
    const [team, worker] = task.nodes ?? []
    assert.equal(worker?.parentNodeId, team?.id)
    assert.equal(worker?.access, 'write')
    assert.equal(worker?.scopePath, 'src')
    assert.equal(worker?.verification?.verdict, 'verified')
    assert.equal(await readFile(join(cwd, 'src', 'output.txt'), 'utf8'), check.contains)
    await assert.rejects(readFile(join(cwd, 'outside.txt')), { code: 'ENOENT' })
    const writes = host.getHistory(taskId).operations.filter(({ tool }) => tool === 'create_text_file')
    assert.deepEqual(writes.map(({ status, taskNodeId }) => [status, taskNodeId]), [['succeeded', worker?.id]])
  } finally { await host.close() }
})

test('independent read-only Workers execute concurrently on the same workspace', { timeout: 12_000 }, async t => {
  const { cwd, directory } = await fixture(t)
  await writeFile(join(cwd, 'src', 'first.txt'), 'first evidence')
  await writeFile(join(cwd, 'src', 'second.txt'), 'second evidence')
  const bothStarted = Promise.withResolvers<void>()
  let workers = 0
  const execution = new DelegationFixture(async (config, call, prompt) => {
    if (config.role === 'root') {
      const results = await call('propose_task_plan', { nodes: [
        { ref: 'first', goal: 'Read first', scopePath: 'src', tools: ['read_text_file'] },
        { ref: 'second', goal: 'Read second', scopePath: 'src', tools: ['read_text_file'] },
      ] })
      assert.equal(results.ok, true, results.error)
      return 'Both read-only inspections succeeded'
    }
    workers++
    if (workers === 2) bothStarted.resolve()
    await Promise.race([bothStarted.promise, delay(3_000, undefined, { ref: false }).then(() => {
      throw new Error('The other read-only node did not start concurrently')
    })])
    const stem = prompt.startsWith('Read first') ? 'first' : 'second'
    const read = await call('read_text_file', { path: 'src/' + stem + '.txt' })
    assert.equal(read.text, stem + ' evidence')
    return 'Read assigned file'
  })
  const host = new LocalAgentHost({ directory, execution })
  try {
    const { taskId } = await host.createTask({ requestId: 'parallel-reads', goal: 'Read both independent files', cwd, workspaceAccess: 'read' })
    await host.idle()
    assert.deepEqual(execution.errors, [])
    assert.equal(workers, 2)
    const task = host.getTask(taskId)
    assert.equal(task.status, 'succeeded')
    assert.deepEqual(task.nodes?.map(node => node.status), ['succeeded', 'succeeded'])
  } finally { await host.close() }
})

test('an explicitly trusted Worker can launch and poll an approved Shell process', { timeout: 20_000 }, async t => {
  const { cwd, directory } = await fixture(t)
  let processId: string | undefined
  let approvals = 0
  const execution = new DelegationFixture(async (config, call) => {
    if (config.role === 'root') {
      const tools = ['shell_exec', 'process_status', 'process_output']
      assert.equal((await call('delegate_task', { goal: 'Try scoped Shell', access: 'trusted', scopePath: 'src', tools })).ok, false)
      assert.equal((await call('delegate_task', { goal: 'Run and inspect approved Shell', access: 'trusted', tools })).ok, true)
      assert.ok(processId)
      assert.equal((await call('process_status', { processId })).ok, false)
      return 'Worker completed the command'
    }
    assert.deepEqual(config.tools.map(({ name }) => name).sort(), ['process_output', 'process_status', 'shell_exec'])
    const launched = await call('shell_exec', { shell: process.platform === 'win32' ? 'cmd' : 'sh', command: 'echo delegated-worker-proof' })
    assert.equal(launched.ok, true)
    assert.equal(typeof launched.processId, 'string')
    processId = launched.processId as string
    for (let attempt = 0; attempt < 120; attempt++) {
      const status = await call('process_status', { processId })
      assert.equal(status.ok, true)
      if (status.state === 'exited') {
        assert.equal(status.exitCode, 0)
        const output = await call('process_output', { processId })
        assert.equal(output.ok, true)
        assert.match(JSON.stringify(output), /delegated-worker-proof/)
        return 'The approved process exited successfully'
      }
      await delay(25)
    }
    throw new Error('Delegated process did not exit')
  })
  const host = new LocalAgentHost({ directory, execution, approveTool: async request => {
    assert.equal(request.kind, 'shell')
    approvals++
    return { approved: true }
  } })
  try {
    const { taskId } = await host.createTask({ requestId: 'delegated-process', goal: 'Run an approved process through a Worker', cwd,
      workspaceAccess: 'trusted' })
    await host.idle()
    assert.deepEqual(execution.errors, [])
    assert.equal(approvals, 1)
    const worker = host.getTask(taskId).nodes?.[0]
    assert.equal(worker?.status, 'succeeded')
    const receipt = host.getHistory(taskId).operations.find(({ tool }) => tool === 'shell_exec')
    assert.equal(receipt?.taskNodeId, worker?.id)
    assert.equal(receipt?.managed, true)
    assert.equal(receipt?.status, 'succeeded')
  } finally { await host.close() }
})

test('a delegated browser has its own session and returns image bytes through the Host', {
  skip: process.platform !== 'win32', timeout: 45_000,
}, async t => {
  const { cwd, directory } = await fixture(t)
  await writeFile(join(cwd, 'root.html'), '<h1>Parent document</h1>')
  await writeFile(join(cwd, 'src', 'worker.html'), '<h1>Delegated document</h1>')
  let parentBrowserId: unknown
  let networkApprovals = 0
  const execution = new DelegationFixture(async (config, call) => {
    if (config.role === 'root') {
      assert.equal((await call('browser_open', { url: 'https://example.com/' })).ok, false)
      const parent = await call('browser_open', { path: 'root.html' })
      assert.equal(parent.ok, true)
      parentBrowserId = parent.browserId
      const handoff = await call('delegate_task', { goal: 'Inspect the delegated document and capture evidence', access: 'write', scopePath: 'src',
        tools: ['browser_open', 'browser_snapshot', 'browser_screenshot', 'view_image'] })
      assert.equal(handoff.ok, true, handoff.error)
      assert.match(JSON.stringify(await call('browser_snapshot', { browserId: parentBrowserId })), /Parent document/)
      return 'Independent browser inspections completed'
    }
    assert.equal((await call('browser_open', { path: 'root.html' })).ok, false)
    const own = await call('browser_open', { path: 'src/worker.html', width: 640, height: 360 })
    assert.equal(own.ok, true)
    assert.notEqual(own.browserId, parentBrowserId)
    const foreign = await call('browser_snapshot', { browserId: parentBrowserId })
    assert.equal(foreign.ok, false)
    assert.match(foreign.error ?? '', /unavailable for this Agent run/)
    assert.match(JSON.stringify(await call('browser_snapshot', { browserId: own.browserId })), /Delegated document/)
    const screenshot = await call('browser_screenshot', { browserId: own.browserId, path: 'src/capture.png' })
    assert.equal(screenshot.ok, true, screenshot.error)
    assert.ok(screenshot[toolImages]?.[0].bytes.length)
    const inspected = await call('view_image', { path: 'src/capture.png' })
    assert.equal(inspected.ok, true, inspected.error)
    assert.ok(inspected[toolImages]?.[0].bytes.length)
    return 'Captured the delegated document and read the PNG'
  })
  const host = new LocalAgentHost({ directory, execution, approveTool: async request => {
    assert.equal(request.kind, 'network')
    networkApprovals++
    return { approved: false }
  } })
  try {
    const { taskId } = await host.createTask({ requestId: 'delegated-browser', goal: 'Inspect independent workspace pages', cwd,
      workspaceAccess: 'trusted' })
    await host.idle()
    assert.deepEqual(execution.errors, [])
    assert.equal(networkApprovals, 1)
    const task = host.getTask(taskId)
    assert.equal(task.nodes?.[0].status, 'succeeded')
    assert.equal(task.nodes?.[0].verification?.verdict, 'unverified')
    const png = await readFile(join(cwd, 'src', 'capture.png'))
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    const screenshot = host.getHistory(taskId).operations.find(({ tool }) => tool === 'browser_screenshot')
    assert.equal(screenshot?.effect, 'write')
    assert.equal(screenshot?.target, 'src/capture.png')
    assert.equal(screenshot?.status, 'succeeded')
  } finally { await host.close() }
})

test('P1-5: rejects out-of-scope nested Team plans, separates deterministic check from turn.completion, reports multiple deferred shells, and recalls custom-provider memory', {
  timeout: 30_000,
}, async t => {
  const { cwd, directory } = await fixture(t)

  // 1. Off / Shadow / Active semantics for unified turn.completion when deterministic node.check passes, plus nested Team scope check.
  for (const mode of ['off', 'shadow', 'active'] as const) {
    const modeCheck = { path: `src/checked-${mode}.txt`, contains: 'deterministic-pass' }
    const modeDir = join(directory, 'handoff-' + mode)
    let childPasses = 0
    const execution = new DelegationFixture(async (config, call) => {
      if (config.role === 'root') {
        const invalidNested = await call('propose_task_plan', {
          nodes: [
            { ref: 'team', role: 'team', teamKey: 'scoped', goal: 'Scoped team', access: 'write', scopePath: 'src', tools: ['create_text_file'] },
            { ref: 'child', parentNodeId: 'team', goal: 'Out-of-scope tool', access: 'write', scopePath: 'src', tools: ['delete_file'] },
          ],
        })
        assert.equal(invalidNested.ok, false)
        const handoff = await call('delegate_task', {
          goal: 'Create checked file', access: 'write', scopePath: 'src', tools: ['create_text_file', 'read_text_file'], check: modeCheck,
        })
        assert.equal(handoff.ok, mode !== 'active')
        return 'Completed check run'
      }
      childPasses++
      if (childPasses === 1) {
        assert.equal((await call('create_text_file', { path: modeCheck.path, content: modeCheck.contains })).ok, true)
        return ' terse summary '
      }
      assert.equal((await call('read_text_file', { path: modeCheck.path })).ok, true)
      return ' verified on follow-up pass '
    })
    const host = new LocalAgentHost({
      directory: modeDir,
      execution,
      judgment: {
        modes: { 'turn.completion': mode },
        judge: {
          async evaluate(req) {
            if (req.id === 'turn.completion') return { output: true }
            return { output: undefined }
          },
        },
      },
    })
    try {
      const { taskId } = await host.createTask({ requestId: 'handoff-' + mode, goal: 'Verify handoff semantics', cwd, workspaceAccess: 'write' })
      await host.idle()
      const worker = host.getTask(taskId).nodes?.[0]
      assert.ok(worker)
      // Deterministic check passed in every mode, so verification verdict remains 'verified' even if active turn.completion rejects delivery after forced follow-up!
      assert.equal(worker.verification?.passed, true)
      assert.equal(worker.verification?.verdict, 'verified')
      assert.equal(childPasses, mode === 'active' ? 2 : 1)
      if (mode === 'active') {
        assert.equal(worker.status, 'failed')
        assert.ok(worker.result?.remainingRisks.includes('handoff_insufficient'))
        assert.ok(!worker.result?.remainingRisks.includes('verification_failed'))
      } else {
        assert.equal(worker.status, 'succeeded')
      }
    } finally {
      await host.close()
    }
  }

  // 2. Multiple deferred shell_exec rounds + custom provider memory visibility & deletion after model switch + approval conversation metadata.
  const seenApprovals: { conversationId?: string; conversationTitle?: string; tool: string }[] = []
  let rootRound = 0
  const shellType = process.platform === 'win32' ? 'cmd' : 'sh'
  const sleepCommand = process.platform === 'win32'
    ? 'ping -n 2 127.0.0.1 >nul & echo deferred-done'
    : 'sleep 0.1 && echo deferred-done'
  await mkdir(join(cwd, 'src'), { recursive: true })
  await writeFile(join(cwd, 'src', 'patched.ts'), 'export const x = 0\n', 'utf8')
  const customRoute = { provider: 'custom-local', model: 'local-1' }
  const switchedRoute = { provider: 'fake', model: 'coding' }
  class CustomProviderFixture extends DelegationFixture {
    override async validateRoute(route: { provider: string; model: string }) {
      if (route.provider === customRoute.provider && route.model === customRoute.model) return
      return super.validateRoute(route)
    }
    override async discoverModels(provider?: string) {
      const base = await super.discoverModels(provider)
      if (!provider || provider === customRoute.provider) {
        base.push({ route: customRoute, contextWindow: 32_768, input: ['text'], reasoning: false })
      }
      return base
    }
  }
  const multiRoundExec = new CustomProviderFixture(async (_config, call, prompt) => {
    if (prompt.includes('patch-memory')) {
      const patched = await call('apply_patch', {
        edits: [{ path: 'src/patched.ts', oldText: 'export const x = 0', newText: 'export const x = 1' }],
      })
      assert.equal(patched.ok, true, patched.error)
      return 'Applied patch'
    }
    rootRound++
    if (rootRound <= 2) {
      const started = await call('shell_exec', { shell: shellType, command: sleepCommand })
      assert.equal(started.ok, true)
      return 'Started background shell ' + rootRound
    }
    assert.match(prompt, /recorded result is now/)
    return 'Observed both deferred shell completions'
  })
  const host = new LocalAgentHost({
    directory: join(directory, 'deferred-and-memory'),
    execution: multiRoundExec,
    defaultRoute: customRoute,
    approveTool: async (request) => {
      seenApprovals.push({ conversationId: request.conversationId, conversationTitle: request.conversationTitle, tool: request.tool })
      return { approved: true }
    },
  })
  try {
    const conv = await host.createConversation({
      requestId: 'conv-1', title: '多轮后台与记忆会话', workspace: cwd, workspaceAccess: 'trusted',
    })
    await host.sendMessage({ requestId: 'msg-patch', conversationId: conv.id, text: 'patch-memory' })
    await host.idle()
    assert.deepEqual(multiRoundExec.errors, [])

    // Switch default model to a different provider and verify custom-provider memories remain listed & deletable!
    const currentPrefs = (await host.managementSnapshot(conv.id)).preferences
    await host.saveAgentPreferences({ ...currentPrefs, defaultRoute: switchedRoute })
    const another = await host.createConversation({
      requestId: 'conv-2', title: '默认模型会话', workspace: cwd, workspaceAccess: 'trusted', route: switchedRoute,
    })
    await host.sendMessage({ requestId: 'msg-shells', conversationId: another.id, text: 'run two background shells' })
    await host.idle()
    assert.deepEqual(multiRoundExec.errors, [])
    assert.equal(rootRound, 3)
    assert.equal(seenApprovals.length, 2)
    assert.ok(seenApprovals.every(item => item.conversationId === another.id && item.conversationTitle === '默认模型会话'))

    const snapshot = await host.managementSnapshot(conv.id)
    assert.equal(snapshot.memory?.entries.length, 1)
    assert.match(snapshot.memory?.entries[0]?.text ?? '', /apply_patch on src\/patched\.ts/)
    const deleted = await host.managementCommand({
      schemaVersion: 1, type: 'deleteConversationMemory', conversationId: conv.id, ids: [snapshot.memory!.entries[0]!.id],
    })
    assert.equal(deleted, 1)
    assert.equal((await host.managementSnapshot(conv.id)).memory?.entries.length, 0)
  } finally {
    await host.close()
  }
})

test('delegated subagents inherit read/git/command tools automatically, honor disallowedTools monotonically, and allow scoped trusted command checks', { timeout: 20_000 }, async t => {
  const { cwd, directory } = await fixture(t)
  await mkdir(join(cwd, 'ui'), { recursive: true })
  await writeFile(join(cwd, 'ui', 'package.json'), JSON.stringify({
    scripts: { test: 'node verify.cjs' },
  }))
  await writeFile(join(cwd, 'ui', 'verify.cjs'), 'process.exit(0)\n')
  await writeFile(join(cwd, 'src', 'outside.txt'), 'initial outside\n')
  const gitOpts = { cwd, encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'], windowsHide: true }
  execFileSync('git', ['init', '-b', 'main'], gitOpts)
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], gitOpts)
  execFileSync('git', ['config', 'user.name', 'Zlo test'], gitOpts)
  execFileSync('git', ['add', '--', 'ui/package.json', 'ui/verify.cjs', 'src/outside.txt'], gitOpts)
  execFileSync('git', ['commit', '-m', 'initial scoped repo'], gitOpts)
  await writeFile(join(cwd, 'ui', 'verify.cjs'), 'process.exit(0) // ui dirty\n')
  await writeFile(join(cwd, 'src', 'outside.txt'), 'dirty outside\n')

  let inspectedTools: string[] = []
  let teamTools: string[] = []
  const execution = new DelegationFixture(async (config, call) => {
    if (config.role === 'root') {
      const readonlyWorker = await call('delegate_task', { goal: 'Inspect repo via inherited read tools', disallowedTools: ['git_log'] })
      assert.equal(readonlyWorker.ok, true, readonlyWorker.error)

      const scopedPlan = await call('propose_task_plan', {
        nodes: [
          {
            ref: 'ui_team', role: 'team', teamKey: 'ui-spec', goal: 'Coordinate UI edits without delete_file',
            access: 'write', scopePath: 'ui', disallowedTools: ['delete_file'],
          },
          {
            ref: 'ui_child', parentNodeId: 'ui_team', goal: 'Reactivating delete_file must fail',
            access: 'write', scopePath: 'ui', tools: ['delete_file'],
          },
        ],
      })
      assert.equal(scopedPlan.ok, false)

      const teamOnly = await call('propose_task_plan', {
        nodes: [
          {
            ref: 'ui_team', role: 'team', teamKey: 'ui-spec', goal: 'Run scoped command inside ui',
            access: 'write', scopePath: 'ui', disallowedTools: ['delete_file'],
          },
        ],
      })
      assert.equal(teamOnly.ok, true, teamOnly.error)
      return 'Delegation permission inheritance verified'
    }
    if (config.role === 'worker') {
      inspectedTools = config.tools.map(({ name }) => name).sort()
      assert.ok((await call('list_directory', { path: '.' })).ok)
      return 'Read-only worker inherited inspection tools without git_log'
    }
    teamTools = config.tools.map(({ name }) => name).sort()
    assert.ok((await call('run_project_command', { command: 'npm_test', path: 'ui' })).ok)
    const scopedStatus = await call('git_status', {}) as { ok: boolean; entries?: { path: string }[] }
    assert.equal(scopedStatus.ok, true)
    assert.deepEqual(scopedStatus.entries?.map(item => item.path), ['ui/verify.cjs'])
    const scopedDiff = await call('git_diff', {}) as { ok: boolean; stdout?: string }
    assert.equal(scopedDiff.ok, true)
    assert.match(scopedDiff.stdout ?? '', /ui\/verify\.cjs/)
    assert.doesNotMatch(scopedDiff.stdout ?? '', /outside\.txt/)
    assert.equal((await call('git_diff', { path: 'src' })).ok, false)
    assert.ok((await call('git_log', {})).ok)
    return 'Scoped team ran npm_test and pathless scoped git inspection without explicit tools list'
  })

  const approvals: string[] = []
  const host = new LocalAgentHost({
    directory, execution, approveTool: async (request) => {
      approvals.push(request.tool)
      return { approved: false }
    },
  })
  try {
    const conv = host.createConversation({
      requestId: 'inherit-conv', workspace: cwd, workspaceAccess: 'trusted', toolApprovalMode: 'routine',
    })
    const { taskId } = await host.sendMessage({ requestId: 'inherit-and-disallowed', conversationId: conv.id, text: 'Test subagent permission inheritance' })
    await host.idle()
    assert.deepEqual(execution.errors, [])
    assert.deepEqual(approvals, [])
    assert.equal(host.getTask(taskId).status, 'succeeded')
    assert.ok(inspectedTools.includes('git_status'))
    assert.ok(inspectedTools.includes('git_diff'))
    assert.ok(!inspectedTools.includes('git_log'))
    assert.ok(!inspectedTools.includes('shell_exec'))
    assert.ok(teamTools.includes('run_project_command'))
    assert.ok(teamTools.includes('git_diff'))
    assert.ok(!teamTools.includes('delete_file'))
  } finally {
    await host.close()
  }

  // Also confirm TaskEngine permits command checks on scoped/worktree trusted nodes while still enforcing scope bounds.
  const { LocalStore } = await import('../src/store.ts')
  const { TaskEngine } = await import('../src/task-engine.ts')
  const store = new LocalStore(':memory:')
  try {
    const tasks = new TaskEngine(store)
    const { taskId } = tasks.create({ requestId: 'scoped-cmd-check', cwd, goal: 'Run scoped checks', workspaceAccess: 'trusted' })
    tasks.start(taskId)
    const scopedNodes = tasks.proposePlan(taskId, 'plan-1', 0, [{
      ref: 'ui', access: 'trusted', scopePath: 'ui', goal: 'Run UI tests',
      check: { command: { command: 'npm_test', path: 'ui' } },
    }])
    assert.equal(scopedNodes[0]?.check?.command?.path, 'ui')
    assert.throws(() => tasks.proposePlan(taskId, 'plan-2', 1, [{
      ref: 'escape', access: 'trusted', scopePath: 'ui', goal: 'Wrong check path',
      check: { command: { command: 'npm_test', path: 'backend' } },
    }]), /outside the node scope/)
    const worktreeId = '11111111-1111-4111-8111-111111111111'
    const wtNodes = tasks.proposePlan(taskId, 'plan-3', 1, [{
      ref: 'wt', access: 'trusted', worktreeId, goal: 'Run worktree tests',
      check: { command: { command: 'npm_test', path: '.' } },
    }])
    assert.equal(wtNodes[0]?.worktreeId, worktreeId)
  } finally {
    store.close()
  }
})
