import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { ModelRoute } from '../src/contracts/domain.ts'
import type { AgentExecution, ExecutionConfig, ExecutionResult, ModelCandidate } from '../src/execution.ts'
import { LocalAgentHost } from '../src/host.ts'
import { CodingWorkspace } from '../src/workspace.ts'

interface ToolReply {
  ok: boolean
  error?: string
  [key: string]: unknown
}
type CallFn = (name: string, input: unknown) => Promise<ToolReply>
type ScriptFn = (
  config: ExecutionConfig,
  call: CallFn,
  prompt: string,
  sessionId: string,
  turn: number,
  route: ModelRoute,
) => Promise<ExecutionResult | string>

const routePrimary: ModelRoute = { provider: 'openai', model: 'planner-pro' }
const routeBackup: ModelRoute = { provider: 'google', model: 'gemini-long-cheap' }

class OrchestrationTestExecution implements AgentExecution {
  readonly opened: Array<{ role: string; route: ModelRoute; cwd: string; resumed?: string; sessionId: string }> = []
  readonly errors: unknown[] = []
  readonly #candidates: ModelCandidate[]
  readonly #script: ScriptFn
  readonly #onCheckpoint?: (role: string, sessionId: string) => void

  constructor(
    script: ScriptFn,
    options: { candidates?: ModelCandidate[]; onCheckpoint?: (role: string, sessionId: string) => void } = {},
  ) {
    this.#script = script
    this.#onCheckpoint = options.onCheckpoint
    this.#candidates = options.candidates ?? [
      { route: routePrimary, estimatedCost: 1, contextWindow: 128_000, input: ['text'], reasoning: true },
      { route: routeBackup, estimatedCost: 2, contextWindow: 256_000, input: ['text'], reasoning: false },
    ]
  }

  async validateRoute(route: ModelRoute): Promise<void> {
    if (!this.#candidates.some(item => item.route.provider === route.provider && item.route.model === route.model)) {
      throw new Error(`Unknown model ${route.provider}/${route.model}`)
    }
  }

  async discoverModels(provider?: string): Promise<ModelCandidate[]> {
    return this.#candidates.filter(item => !provider || item.route.provider === provider)
  }

  async open(config: ExecutionConfig) {
    const route = config.route ?? this.#candidates[0]!.route
    const ref = config.session ?? { id: randomUUID(), path: join(config.sessionDirectory ?? config.cwd, `${randomUUID()}.jsonl`) }
    if (!config.session && config.sessionDirectory) {
      await mkdir(config.sessionDirectory, { recursive: true })
      await writeFile(ref.path, JSON.stringify({ id: ref.id }) + '\n', 'utf8')
    }
    this.opened.push({
      role: config.role ?? 'worker',
      route,
      cwd: config.cwd,
      resumed: config.session?.id,
      sessionId: ref.id,
    })
    let turn = 0
    return {
      ref,
      route,
      run: async (prompt: string): Promise<ExecutionResult> => {
        turn++
        try {
          config.reserveRequest?.({ route, estimatedInputTokens: 20, maxOutputTokens: 80, kind: 'prompt' })
          config.onEvent({ type: 'prompt.accepted' })
          config.onEvent({ type: 'model.request_started' })
          config.onEvent({ type: 'model.usage', input: 10, output: 10, cacheRead: 0, cacheWrite: 0 })
          const call: CallFn = async (name, input) => {
            const tool = config.tools.find(item => item.name === name)
            assert.ok(tool, `${config.role} is missing tool ${name}`)
            return await tool.execute(randomUUID(), input) as ToolReply
          }
          const res = await this.#script(config, call, prompt, ref.id, turn, route)
          return typeof res === 'string' ? { status: 'completed', text: res } : res
        } catch (error) {
          this.errors.push(error)
          return { status: 'runtime_error' }
        }
      },
      steer: async () => {},
      requestStop: async () => {},
      checkpoint: async () => { this.#onCheckpoint?.(config.role ?? 'worker', ref.id) },
      dispose: async () => {},
    }
  }
}

async function workspaceFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'zlo-batch1-'))
  const cwd = join(root, 'workspace')
  const directory = join(root, 'state')
  await mkdir(join(cwd, 'src'), { recursive: true })
  await writeFile(join(cwd, 'src', 'a.txt'), 'alpha\n', 'utf8')
  await writeFile(join(cwd, 'src', 'b.txt'), 'beta\n', 'utf8')
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, cwd, directory }
}

test('wait_task_nodes never returns empty prematurely on repeated any waits or ready dependency-blocked targets', { timeout: 15_000 }, async (t) => {
  const { cwd, directory } = await workspaceFixture(t)
  const slowGate = Promise.withResolvers<void>()
  let slowSettled = false
  let depSettled = false

  const execution = new OrchestrationTestExecution(async (config, call, prompt, _sid, turn) => {
    if (config.role === 'root') {
      if (turn > 1) return 'Root observed remaining upstream notification'
      const plan = await call('propose_task_plan', {
        wait: 'none',
        nodes: [
          { ref: 'fastA', goal: 'Fast read A', access: 'read', scopePath: 'src' },
          { ref: 'slowB', goal: 'Slow read B', access: 'read', scopePath: 'src' },
          { ref: 'depC', goal: 'Dependent C', access: 'read', scopePath: 'src', dependencies: ['slowB'] },
        ],
      }) as ToolReply & { nodes: Array<{ nodeId: string }> }
      assert.equal(plan.ok, true)
      const [fastId, slowId, depId] = plan.nodes.map(n => n.nodeId)

      // 1st wait(any) wakes on fastA while slowB is still gated.
      const firstAny = await call('wait_task_nodes', { nodeIds: [fastId, slowId], mode: 'any' }) as ToolReply & {
        completedNodes: Array<{ nodeId: string }>
      }
      assert.equal(firstAny.ok, true)
      assert.ok(firstAny.completedNodes.some(n => n.nodeId === fastId))
      assert.equal(slowSettled, false)

      // Release slowB slightly asynchronously, then immediately issue 2nd wait(any) on [fastId, slowId].
      setTimeout(() => slowGate.resolve(), 40)
      const secondAny = await call('wait_task_nodes', { nodeIds: [fastId, slowId], mode: 'any' }) as ToolReply & {
        completedNodes: Array<{ nodeId: string }>
      }
      assert.equal(secondAny.ok, true)
      assert.equal(secondAny.completedNodes.length, 1)
      assert.equal(secondAny.completedNodes[0]?.nodeId, slowId)
      assert.equal(slowSettled, true)

      // Now wait(all) on depC alone (which starts 'ready' behind slowB or just starting) must wait until depC finishes.
      const waitDep = await call('wait_task_nodes', { nodeIds: [depId], mode: 'all' }) as ToolReply & {
        nodes: Array<{ nodeId: string; status: string }>
      }
      assert.equal(waitDep.ok, true)
      assert.equal(depSettled, true)
      assert.equal(waitDep.nodes.find(n => n.nodeId === depId)?.status, 'succeeded')
      return 'All wait_task_nodes invariants verified'
    }

    if (prompt.startsWith('Fast read A')) {
      assert.equal((await call('read_text_file', { path: 'src/a.txt' })).ok, true)
      return 'Fast A done'
    }
    if (prompt.startsWith('Slow read B')) {
      await slowGate.promise
      assert.equal((await call('read_text_file', { path: 'src/b.txt' })).ok, true)
      slowSettled = true
      return 'Slow B done'
    }
    await delay(30)
    assert.equal((await call('read_text_file', { path: 'src/a.txt' })).ok, true)
    depSettled = true
    return 'Dependent C done'
  })

  const host = new LocalAgentHost({ directory, execution, defaultRoute: routePrimary })
  try {
    const { taskId } = await host.createTask({ requestId: 'wait-semantics', goal: 'Verify wait_task_nodes', cwd, workspaceAccess: 'read' })
    await host.idle()
    assert.deepEqual(execution.errors, [])
    assert.equal(host.getTask(taskId).status, 'succeeded')
  } finally {
    await host.close()
  }
})

test('wait_task_nodes mode=all on a ready downstream node waits through its active upstream dependency', { timeout: 15_000 }, async (t) => {
  const { cwd, directory } = await workspaceFixture(t)
  const gate = Promise.withResolvers<void>()
  let upDone = false
  let downDone = false

  const execution = new OrchestrationTestExecution(async (config, call, prompt, _sid, turn) => {
    if (config.role === 'root') {
      if (turn > 1) return 'Root observed remaining upstream notification'
      const plan = await call('propose_task_plan', {
        wait: 'none',
        nodes: [
          { ref: 'up', goal: 'Upstream read', access: 'read', scopePath: 'src' },
          { ref: 'down', goal: 'Downstream read', access: 'read', scopePath: 'src', dependencies: ['up'] },
        ],
      }) as ToolReply & { nodes: Array<{ nodeId: string }> }
      const [, downId] = plan.nodes.map(n => n.nodeId)
      setTimeout(() => gate.resolve(), 50)
      // At the moment wait_task_nodes is called, 'down' is still 'ready' waiting on running 'up'.
      const waited = await call('wait_task_nodes', { nodeIds: [downId], mode: 'all' }) as ToolReply & {
        nodes: Array<{ status: string }>
      }
      assert.equal(waited.ok, true)
      assert.equal(upDone, true)
      assert.equal(downDone, true)
      assert.equal(waited.nodes[0]?.status, 'succeeded')
      return 'Upstream and downstream settled'
    }
    if (prompt.startsWith('Upstream read')) {
      await gate.promise
      assert.equal((await call('read_text_file', { path: 'src/a.txt' })).ok, true)
      upDone = true
      return 'Upstream done'
    }
    assert.equal(upDone, true)
    assert.equal((await call('read_text_file', { path: 'src/b.txt' })).ok, true)
    downDone = true
    return 'Downstream done'
  })

  const host = new LocalAgentHost({ directory, execution, defaultRoute: routePrimary })
  try {
    const { taskId } = await host.createTask({ requestId: 'wait-dep-all', goal: 'Wait on ready dep', cwd, workspaceAccess: 'read' })
    await host.idle()
    assert.deepEqual(execution.errors, [])
    assert.equal(host.getTask(taskId).status, 'succeeded')
  } finally {
    await host.close()
  }
})

test('delegate_worker wait=true queues cleanly when activeAgents slots are saturated instead of failing with capacity or interrupt errors', { timeout: 15_000 }, async (t) => {
  const { cwd, directory } = await workspaceFixture(t)
  const bgStarted = Promise.withResolvers<void>()

  const execution = new OrchestrationTestExecution(async (config, call, prompt, _sid, turn) => {
    if (config.role === 'root') {
      if (turn > 1) return 'Root observed remaining upstream notification'
      const plan = await call('propose_task_plan', {
        nodes: [{ ref: 'team', role: 'team', teamKey: 'tight-slots', goal: 'Coordinate under 2 activeAgents slots', access: 'read', scopePath: 'src' }],
      })
      assert.equal(plan.ok, true, plan.error)
      return 'Root succeeded under tight model slots'
    }
    if (config.role === 'team') {
      // Launch background reader and synchronous delegate_worker while Root + Team occupy both activeAgents slots initially.
      const bg = await call('delegate_worker', { goal: 'Background reader', access: 'read', scopePath: 'src', wait: false })
      assert.equal(bg.ok, true, bg.error)
      const sync = await call('delegate_worker', { goal: 'Synchronous queued worker', access: 'read', scopePath: 'src', wait: true })
      assert.equal(sync.ok, true, String(sync.error ?? sync.failureReason))
      assert.equal(sync.resultStatus, 'succeeded')
      return 'Team finished both workers cleanly'
    }
    if (prompt.startsWith('Background reader')) {
      bgStarted.resolve()
      await delay(60)
      assert.equal((await call('read_text_file', { path: 'src/a.txt' })).ok, true)
      return 'Background reader done'
    }
    await bgStarted.promise
    assert.equal((await call('read_text_file', { path: 'src/b.txt' })).ok, true)
    return 'Sync worker done'
  })

  // Only 2 activeAgents slots total for Root + Team + bg + sync.
  const host = new LocalAgentHost({ directory, execution, defaultRoute: routePrimary, modelLimits: { activeAgents: 2 } })
  try {
    const { taskId } = await host.createTask({ requestId: 'slot-queue', goal: 'Queue slots cleanly', cwd, workspaceAccess: 'read' })
    await host.idle()
    assert.deepEqual(execution.errors, [])
    assert.equal(host.getTask(taskId).status, 'succeeded')
    assert.deepEqual(await host.command({ schemaVersion: 1, type: 'getRouteStatus' }), { quota: 'unknown', activeReservations: 0 })
  } finally {
    await host.close()
  }
})

test('Team wakes immediately when pre-planned fast child finishes before slow sibling and avoids WorkspaceLease deadlock on write delegation + tool call', { timeout: 15_000 }, async (t) => {
  const { cwd, directory } = await workspaceFixture(t)
  const slowGate = Promise.withResolvers<void>()
  let teamTurn1At = 0
  let slowFinishedAt = 0

  const execution = new OrchestrationTestExecution(async (config, call, prompt, _sid, turn) => {
    if (config.role === 'root') {
      const plan = await call('propose_task_plan', {
        nodes: [
          { ref: 'team', role: 'team', teamKey: 'fast-wake', goal: 'Coordinate pre-planned readers and write handoff', access: 'write', scopePath: 'src' },
          { ref: 'fastR', parentNodeId: 'team', goal: 'Fast child read', access: 'read', scopePath: 'src' },
          { ref: 'slowR', parentNodeId: 'team', goal: 'Slow child read', access: 'read', scopePath: 'src' },
        ],
      })
      assert.equal(plan.ok, true, plan.error)
      return 'Root verified Team early wake and lease handoff'
    }
    if (config.role === 'team') {
      if (turn === 1) {
        teamTurn1At = performance.now()
        setTimeout(() => slowGate.resolve(), 60)
        // Team immediately delegates async write worker AND invokes create_text_file in the SAME turn -> must not deadlock!
        const w = await call('delegate_worker', { goal: 'Child write file', access: 'write', scopePath: 'src', wait: false })
        assert.equal(w.ok, true, w.error)
        const own = await call('create_text_file', { path: 'src/team-own.txt', content: 'team own write' })
        assert.equal(own.ok, true, own.error)
        return 'Team wrote own file after async child write settled cleanly'
      }
      return 'Team processed remaining child completion'
    }
    if (prompt.startsWith('Fast child read')) {
      assert.equal((await call('read_text_file', { path: 'src/a.txt' })).ok, true)
      return 'Fast child ok'
    }
    if (prompt.startsWith('Slow child read')) {
      await slowGate.promise
      assert.equal((await call('read_text_file', { path: 'src/b.txt' })).ok, true)
      slowFinishedAt = performance.now()
      return 'Slow child ok'
    }
    assert.equal((await call('create_text_file', { path: 'src/child-write.txt', content: 'child write ok' })).ok, true)
    return 'Child write ok'
  })

  const host = new LocalAgentHost({ directory, execution, defaultRoute: routePrimary })
  try {
    const { taskId } = await host.createTask({ requestId: 'team-wake-lease', goal: 'Verify Team wakeup and lease handoff', cwd, workspaceAccess: 'write' })
    await host.idle()
    assert.deepEqual(execution.errors, [])
    assert.equal(host.getTask(taskId).status, 'succeeded')
    assert.ok(teamTurn1At > 0 && slowFinishedAt > 0 && teamTurn1At < slowFinishedAt,
      `Expected Team Turn 1 (${teamTurn1At}) to start before slow child finished (${slowFinishedAt})`)
    assert.equal(await readFile(join(cwd, 'src', 'child-write.txt'), 'utf8'), 'child write ok')
    assert.equal(await readFile(join(cwd, 'src', 'team-own.txt'), 'utf8'), 'team own write')
    assert.deepEqual(new CodingWorkspace(cwd).leaseState(), { readers: [], waitingCount: 0 })
  } finally {
    await host.close()
  }
})

test('checkless Team rejects partial success when a failed child is unrecovered, and succeeds only with post-failure recovery', { timeout: 15_000 }, async (t) => {
  const { cwd, directory } = await workspaceFixture(t)

  const partialExec = new OrchestrationTestExecution(async (config, call, prompt) => {
    if (config.role === 'root') {
      await call('propose_task_plan', {
        nodes: [
          { ref: 'team', role: 'team', teamKey: 'partial-mask', goal: 'Attempt team work without recovery', access: 'write', scopePath: 'src' },
          { ref: 'goodR', parentNodeId: 'team', goal: 'Read succeeds', access: 'read', scopePath: 'src' },
          { ref: 'badW', parentNodeId: 'team', goal: 'Write fails', access: 'write', scopePath: 'src' },
        ],
      })
      return 'Root reports result'
    }
    if (config.role === 'team') {
      return 'Claiming success despite badW failing and zero recovery'
    }
    if (prompt.startsWith('Read succeeds')) {
      assert.equal((await call('read_text_file', { path: 'src/a.txt' })).ok, true)
      return 'Good read'
    }
    await call('create_text_file', { path: 'src/partial.txt', content: 'written before failure' })
    return '' // empty summary forces failed status on badW
  })

  const host1 = new LocalAgentHost({ directory: join(directory, 'unrecovered'), execution: partialExec, defaultRoute: routePrimary })
  try {
    const { taskId } = await host1.createTask({ requestId: 'unrecovered-team', goal: 'Reject masked failure', cwd, workspaceAccess: 'write' })
    await host1.idle()
    assert.deepEqual(partialExec.errors, [])
    const task = host1.getTask(taskId)
    assert.equal(task.status, 'failed')
    const team = task.nodes?.find(n => n.role === 'team')
    assert.equal(team?.status, 'failed')
  } finally {
    await host1.close()
  }

  const recoveryExec = new OrchestrationTestExecution(async (config, call, prompt) => {
    if (config.role === 'root') {
      const plan = await call('propose_task_plan', {
        nodes: [{ ref: 'team', role: 'team', teamKey: 'recover-ok', goal: 'Recover failed child explicitly', access: 'write', scopePath: 'src' }],
      })
      assert.equal(plan.ok, true)
      return 'Root succeeded after Team recovery'
    }
    if (config.role === 'team') {
      const first = await call('delegate_worker', { goal: 'Failing write attempt', access: 'write', scopePath: 'src' })
      assert.equal(first.ok, false)
      const fix = await call('delegate_worker', { goal: 'Replacement write attempt', access: 'write', scopePath: 'src' })
      assert.equal(fix.ok, true)
      return 'Team recovered with replacement write worker'
    }
    if (prompt.startsWith('Failing write attempt')) {
      await call('read_text_file', { path: 'src/a.txt' })
      return ''
    }
    assert.equal((await call('create_text_file', { path: 'src/recovered.txt', content: 'fixed' })).ok, true)
    return 'Replacement write succeeded'
  })

  const host2 = new LocalAgentHost({ directory: join(directory, 'recovered'), execution: recoveryExec, defaultRoute: routePrimary })
  try {
    const { taskId } = await host2.createTask({ requestId: 'recovered-team', goal: 'Allow verified recovery', cwd, workspaceAccess: 'write' })
    await host2.idle()
    assert.deepEqual(recoveryExec.errors, [])
    const task = host2.getTask(taskId)
    assert.equal(task.status, 'succeeded')
    assert.equal(task.nodes?.find(n => n.role === 'team')?.status, 'succeeded')
  } finally {
    await host2.close()
  }
})

test('persistent Team in an isolated Git worktree resumes its session when node.route is omitted and never leaks to primary workspace', { timeout: 20_000 }, async (t) => {
  const { cwd, directory } = await workspaceFixture(t)
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { windowsHide: true, stdio: 'pipe' })
  git('init', '-q')
  git('config', '--local', 'user.name', 'Zlo Test')
  git('config', '--local', 'user.email', 'zlo@example.test')
  git('add', '--', 'src/a.txt', 'src/b.txt')
  git('commit', '-qm', 'baseline')

  const sessions: Array<{ cwd: string; sessionId: string; resumed?: string }> = []
  let worktreeId = ''

  const execution = new OrchestrationTestExecution(async (config, call, prompt, sessionId) => {
    if (config.role === 'root') {
      const wt = await call('git_worktree', { branch: 'feat/team-resume' }) as ToolReply & { worktreeId: string }
      assert.equal(wt.ok, true, wt.error)
      worktreeId = wt.worktreeId

      // Wave 1: persistent Team runs in isolated Git worktree with no explicit node.route.
      const w1 = await call('propose_task_plan', {
        nodes: [{ ref: 'wt1', role: 'team', teamKey: 'shared-wt-key', goal: 'Wave 1 worktree edit', access: 'write', scopePath: 'src', worktreeId }],
      })
      assert.equal(w1.ok, true, w1.error)

      // Wave 2: same teamKey and worktreeId, still omitting node.route -> must resume Wave 1's worktree session!
      const w2 = await call('propose_task_plan', {
        nodes: [{ ref: 'wt2', role: 'team', teamKey: 'shared-wt-key', goal: 'Wave 2 worktree edit', access: 'write', scopePath: 'src', worktreeId }],
      })
      assert.equal(w2.ok, true, w2.error)

      // Wave 3: same teamKey on primary workspace (no worktreeId) -> must open a distinct primary session!
      const primary = await call('propose_task_plan', {
        nodes: [{ ref: 'pri', role: 'team', teamKey: 'shared-wt-key', goal: 'Primary workspace edit', access: 'write', scopePath: 'src' }],
      })
      assert.equal(primary.ok, true, primary.error)
      return 'Worktree and primary Team session isolation verified'
    }
    assert.equal(config.role, 'team')
    sessions.push({ cwd: config.cwd, sessionId, resumed: config.session?.id })
    const file = prompt.startsWith('Wave 1') ? 'src/wt1.txt' : prompt.startsWith('Wave 2') ? 'src/wt2.txt' : 'src/primary.txt'
    assert.equal((await call('create_text_file', { path: file, content: file })).ok, true)
    return `Created ${file}`
  })

  const host = new LocalAgentHost({ directory, execution, defaultRoute: routePrimary, approveTool: async () => ({ approved: true }) })
  try {
    const { taskId } = await host.createTask({ requestId: 'wt-team-resume', goal: 'Test worktree Team resume', cwd, workspaceAccess: 'trusted' })
    await host.idle()
    assert.deepEqual(execution.errors, [])
    assert.equal(host.getTask(taskId).status, 'succeeded')
    assert.equal(sessions.length, 3)
    assert.equal(sessions[0]!.resumed, undefined)
    assert.equal(sessions[1]!.resumed, sessions[0]!.sessionId)
    assert.equal(sessions[1]!.sessionId, sessions[0]!.sessionId)
    assert.equal(sessions[1]!.cwd, sessions[0]!.cwd)
    assert.equal(sessions[2]!.resumed, undefined)
    assert.notEqual(sessions[2]!.sessionId, sessions[0]!.sessionId)
  } finally {
    await host.close()
  }
})

test('mailbox crash recovery rehydrates settled wait=none child notifications upon task resume', { timeout: 20_000 }, async (t) => {
  const { root, cwd, directory } = await workspaceFixture(t)
  const runnerScript = join(root, 'crash-mailbox-runner.mjs')
  await writeFile(runnerScript, [
    "import assert from 'node:assert/strict'",
    "import { randomUUID } from 'node:crypto'",
    "import { mkdir, writeFile } from 'node:fs/promises'",
    "import { join } from 'node:path'",
    "import { LocalAgentHost } from " + JSON.stringify(new URL('../src/host.ts', import.meta.url).href),
    '',
    'const [directory, cwd] = process.argv.slice(2)',
    'const turn1Checkpointed = Promise.withResolvers()',
    'let notifiedBoundary = false',
    'const execution = {',
    '  async validateRoute() {},',
    '  async open(config) {',
    '    const route = config.route ?? { provider: "openai", model: "planner-pro" }',
    '    const ref = config.session ?? { id: randomUUID(), path: join(config.sessionDirectory, randomUUID() + ".jsonl") }',
    '    if (!config.session) {',
    '      await mkdir(config.sessionDirectory, { recursive: true })',
    '      await writeFile(ref.path, JSON.stringify({ id: ref.id }) + "\\n", "utf8")',
    '    }',
    '    return {',
    '      ref, route,',
    '      async run(prompt) {',
    '        config.reserveRequest?.({ route, estimatedInputTokens: 20, maxOutputTokens: 80, kind: "prompt" })',
    '        config.onEvent({ type: "prompt.accepted" })',
    '        config.onEvent({ type: "model.request_started" })',
    '        config.onEvent({ type: "model.usage", input: 10, output: 10, cacheRead: 0, cacheWrite: 0 })',
    '        const call = async (name, input) => config.tools.find(i => i.name === name).execute(randomUUID(), input)',
    '        if (config.role === "root") {',
    '          if (!prompt.includes("Child node completion events")) {',
    '            const plan = await call("propose_task_plan", {',
    '              wait: "none",',
    '              nodes: [{ ref: "bg", goal: "Background read marker", access: "read", scopePath: "src" }],',
    '            })',
    '            assert.equal(plan.ok, true)',
    '            return { status: "completed", text: "Scheduled bg node" }',
    '          }',
    '          if (!notifiedBoundary) {',
    '            notifiedBoundary = true',
    '            console.log(JSON.stringify({ readyToCrash: true }))',
    '            await new Promise(() => {})',
    '          }',
    '          return { status: "completed", text: "Unreachable" }',
    '        }',
    '        await turn1Checkpointed.promise',
    '        assert.equal((await call("read_text_file", { path: "src/a.txt" })).ok, true)',
    '        return { status: "completed", text: "CRASH_RECOVERY_MARKER" }',
    '      },',
    '      async steer() {},',
    '      async requestStop() {},',
    '      async checkpoint() { turn1Checkpointed.resolve() },',
    '      async dispose() {},',
    '    }',
    '  },',
    '}',
    'const host = new LocalAgentHost({ directory, execution, defaultRoute: { provider: "openai", model: "planner-pro" } })',
    'const { taskId } = await host.createTask({ requestId: "crash-mb", goal: "Survive crash after bg settle", cwd, workspaceAccess: "read" })',
    'console.log(JSON.stringify({ taskId }))',
  ].join('\n'), 'utf8')

  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', runnerScript, directory, cwd], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const exited = once(child, 'exit')
  const lines = createInterface({ input: child.stdout })
  let taskId = ''
  try {
    let sawCrashBoundary = false
    for await (const raw of lines) {
      const msg = JSON.parse(raw) as { taskId?: string; readyToCrash?: boolean }
      if (msg.taskId) taskId = msg.taskId
      if (msg.readyToCrash) {
        sawCrashBoundary = true
        break
      }
    }
    assert.ok(taskId && sawCrashBoundary)
  } finally {
    lines.close()
    child.kill('SIGKILL')
    const [, sig] = await exited
    assert.equal(sig, 'SIGKILL')
  }

  const resumedPrompts: string[] = []
  const resumeExec = new OrchestrationTestExecution(async (config, _call, prompt) => {
    assert.equal(config.role, 'root')
    resumedPrompts.push(prompt)
    return 'Resumed Root observed settled wait=none child notification'
  })
  const host = new LocalAgentHost({ directory, execution: resumeExec, defaultRoute: routePrimary })
  try {
    const pre = host.getTask(taskId)
    assert.equal(pre.status, 'stopped')
    assert.equal(pre.reason, 'process_interrupted')
    assert.equal(pre.nodes?.[0]?.status, 'succeeded')
    assert.equal(host.resume(taskId, 'resume-after-crash').accepted, true)
    await host.idle()
    assert.deepEqual(resumeExec.errors, [])
    assert.equal(host.getTask(taskId).status, 'succeeded')
    assert.equal(resumedPrompts.length, 1)
    assert.ok(resumedPrompts[0]!.startsWith('Resume the task using the saved conversation.'))
    assert.match(resumedPrompts[0]!, /Child node completion events/)
    assert.match(resumedPrompts[0]!, /CRASH_RECOVERY_MARKER/)
  } finally {
    await host.close()
  }
})

test('worker executes one-shot runtime allocateFallback on model_error and multi-node DAG exceeds 96 default requests cleanly', { timeout: 20_000 }, async (t) => {
  const { cwd, directory } = await workspaceFixture(t)

  // Part A: Runtime fallback on first-turn model_error
  let primaryWorkerCalls = 0
  const seenWorkerRoutes: ModelRoute[] = []
  const fallbackExec = new OrchestrationTestExecution(async (config, call, prompt, _sid, _turn, route) => {
    if (config.role === 'root') {
      const res = await call('delegate_task', { goal: 'Inspect src/a.txt via healthy fallback' })
      assert.equal(res.ok, true, res.error)
      return 'Root completed after runtime fallback'
    }
    seenWorkerRoutes.push(route)
    if (route.provider === routePrimary.provider && route.model === routePrimary.model) {
      primaryWorkerCalls++
      return { status: 'model_error' }
    }
    assert.equal(prompt.startsWith('Inspect src/a.txt'), true)
    assert.equal((await call('read_text_file', { path: 'src/a.txt' })).ok, true)
    return 'Succeeded on backup route'
  })

  const hostA = new LocalAgentHost({ directory: join(directory, 'fallback'), execution: fallbackExec, defaultRoute: routePrimary })
  try {
    const { taskId } = await hostA.createTask({ requestId: 'runtime-fallback', goal: 'Fallback test', cwd, workspaceAccess: 'read' })
    await hostA.idle()
    assert.deepEqual(fallbackExec.errors, [])
    const task = hostA.getTask(taskId)
    assert.equal(task.status, 'succeeded')
    assert.equal(primaryWorkerCalls, 1)
    assert.deepEqual(seenWorkerRoutes, [routePrimary, routeBackup])
    assert.ok(hostA.events(taskId).some(ev => ev.type === 'model.route_changed'))
  } finally {
    await hostA.close()
  }

  // Part B: 4-node DAG collectively making 112+ model requests exceeds legacy 96-request ceiling when modelLimits.requests is unset
  let workerTurnsCompleted = 0
  const multiTurnExec = {
    async validateRoute() {},
    async discoverModels() {
      return [{ route: routePrimary, estimatedCost: 1, contextWindow: 128_000, input: ['text'], reasoning: true }]
    },
    async open(config: ExecutionConfig) {
      const ref = config.session ?? { id: randomUUID(), path: join(config.sessionDirectory ?? cwd, `${randomUUID()}.jsonl`) }
      if (!config.session && config.sessionDirectory) {
        await mkdir(config.sessionDirectory, { recursive: true })
        await writeFile(ref.path, JSON.stringify({ id: ref.id }) + '\n', 'utf8')
      }
      let session: { run(prompt: string): Promise<ExecutionResult> }
      let remaining = 28
      const callTool = async (name: string, input: unknown) => {
        const tool = config.tools.find(item => item.name === name)
        assert.ok(tool, `${config.role} missing ${name}`)
        return await tool.execute(randomUUID(), input) as ToolReply
      }
      session = {
        async run(): Promise<ExecutionResult> {
          if (config.role === 'root') {
            config.reserveRequest?.({ route: routePrimary, estimatedInputTokens: 10, maxOutputTokens: 40, kind: 'prompt' })
            config.onEvent({ type: 'prompt.accepted' })
            config.onEvent({ type: 'model.request_started' })
            config.onEvent({ type: 'model.usage', input: 5, output: 5, cacheRead: 0, cacheWrite: 0 })
            if (workerTurnsCompleted === 0) {
              const plan = await callTool('propose_task_plan', {
                nodes: [
                  { ref: 'n1', goal: '28-request worker 1', access: 'read', scopePath: 'src' },
                  { ref: 'n2', goal: '28-request worker 2', access: 'read', scopePath: 'src' },
                  { ref: 'n3', goal: '28-request worker 3', access: 'read', scopePath: 'src' },
                  { ref: 'n4', goal: '28-request worker 4', access: 'read', scopePath: 'src' },
                ],
              })
              assert.equal(plan.ok, true, plan.error)
            }
            return { status: 'completed', text: 'Large DAG completed >112 model requests cleanly' }
          }
          // Make 28 metered model requests within a single Worker attempt (under per-attempt cap 32, total 112+ > 96).
          for (let i = 0; i < remaining; i++) {
            config.reserveRequest?.({ route: routePrimary, estimatedInputTokens: 10, maxOutputTokens: 40, kind: 'prompt' })
            config.onEvent({ type: 'model.request_started' })
            config.onEvent({ type: 'model.usage', input: 5, output: 5, cacheRead: 0, cacheWrite: 0 })
          }
          remaining = 0
          workerTurnsCompleted++
          assert.equal((await callTool('read_text_file', { path: 'src/a.txt' })).ok, true)
          return { status: 'completed', text: 'Worker completed 28 metered requests' }
        },
      }
      return {
        ref,
        route: routePrimary,
        ...session,
        steer: async () => {},
        requestStop: async () => {},
        checkpoint: async () => {},
        dispose: async () => {},
      }
    },
  } satisfies AgentExecution

  const hostB = new LocalAgentHost({ directory: join(directory, 'large-budget'), execution: multiTurnExec, defaultRoute: routePrimary })
  try {
    const { taskId } = await hostB.createTask({ requestId: 'large-dag-budget', goal: 'Exceed legacy 96 requests safely', cwd, workspaceAccess: 'read' })
    await hostB.idle()
    const task = hostB.getTask(taskId)
    assert.equal(task.status, 'succeeded')
    assert.equal(workerTurnsCompleted, 4)
    const reservedRequests = hostB.events(taskId).filter(ev => ev.type === 'model.reserved').length
    assert.ok(reservedRequests >= 112, `Expected >= 112 metered requests, got ${reservedRequests}`)
  } finally {
    await hostB.close()
  }
})
