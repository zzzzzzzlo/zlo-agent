import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { EventDraft, ModelRoute } from '../src/contracts/domain.ts'
import type { AgentExecution, ExecutionConfig, ExecutionResult, ModelCandidate } from '../src/execution.ts'
import { ModelUnavailableError } from '../src/execution.ts'
import { LocalAgentHost } from '../src/host.ts'
import { LocalJudgment } from '../src/judgment.ts'
import { distillTaskMemories, LocalMemory, ScopedContext } from '../src/memory.ts'
import { LocalModelScheduler } from '../src/model-scheduler.ts'
import { LocalStore } from '../src/store.ts'
import { TaskEngine } from '../src/task-engine.ts'
import type { WorkerNode, WorkerResult } from '../src/task-engine.ts'

interface ToolReply {
  ok: boolean
  error?: string
  [key: string]: unknown
}
type ToolCallFn = (name: string, input: unknown) => Promise<ToolReply>
type RunScript = (config: ExecutionConfig, call: ToolCallFn, prompt: string, sessionId: string) => Promise<string>

const routePlanner: ModelRoute = { provider: 'openai', model: 'planner-pro' }
const routeResearch: ModelRoute = { provider: 'google', model: 'gemini-long-cheap' }
const routeCoding: ModelRoute = { provider: 'anthropic', model: 'claude-coder' }
const routeReview: ModelRoute = { provider: 'xai', model: 'grok-reviewer' }

class MultiAgentFixture implements AgentExecution {
  readonly opened: Array<{ role: string; route?: ModelRoute; cwd: string; resumed?: string; sessionId: string; tools: string[] }> = []
  readonly sessionConcurrentPeaks = new Map<string, number>()
  readonly #activeRuns = new Map<string, number>()
  readonly #knownModels: ModelCandidate[]
  readonly #unavailable = new Set<string>()
  readonly #script: RunScript
  readonly errors: unknown[] = []

  constructor(script: RunScript, models?: ModelCandidate[]) {
    this.#script = script
    this.#knownModels = models ?? [
      { route: routePlanner, estimatedCost: 12, contextWindow: 128_000, input: ['text'], reasoning: true },
      { route: routeResearch, estimatedCost: 0.4, contextWindow: 1_000_000, input: ['text'], reasoning: false },
      { route: routeCoding, estimatedCost: 3, contextWindow: 200_000, input: ['text'], reasoning: true },
      { route: routeReview, estimatedCost: 1.5, contextWindow: 128_000, input: ['text'], reasoning: true },
    ]
  }

  markUnavailable(route: ModelRoute): void {
    this.#unavailable.add(`${route.provider}\n${route.model}`)
  }

  async validateRoute(route: ModelRoute): Promise<void> {
    if (this.#unavailable.has(`${route.provider}\n${route.model}`)) {
      throw new ModelUnavailableError(`Model ${route.provider}/${route.model} unavailable`)
    }
    const found = this.#knownModels.some(item => item.route.provider === route.provider && item.route.model === route.model)
    if (!found) throw new ModelUnavailableError(`Unknown model ${route.provider}/${route.model}`)
  }

  async discoverModels(provider?: string): Promise<ModelCandidate[]> {
    return this.#knownModels.filter(item =>
      (!provider || item.route.provider === provider) &&
      !this.#unavailable.has(`${item.route.provider}\n${item.route.model}`))
  }

  async open(config: ExecutionConfig) {
    const route = config.route ?? routePlanner
    if (this.#unavailable.has(`${route.provider}\n${route.model}`)) {
      throw new ModelUnavailableError(`Model ${route.provider}/${route.model} unavailable`)
    }
    const ref = config.session ?? { id: randomUUID(), path: join(config.sessionDirectory ?? config.cwd, `${randomUUID()}.jsonl`) }
    this.opened.push({
      role: config.role ?? 'worker',
      route,
      cwd: config.cwd,
      resumed: config.session?.id,
      sessionId: ref.id,
      tools: config.tools.map(t => t.name),
    })
    return {
      ref,
      route,
      run: async (prompt: string): Promise<ExecutionResult> => {
        const active = (this.#activeRuns.get(ref.id) ?? 0) + 1
        this.#activeRuns.set(ref.id, active)
        this.sessionConcurrentPeaks.set(ref.id, Math.max(this.sessionConcurrentPeaks.get(ref.id) ?? 0, active))
        try {
          if (active > 1) throw new Error(`Concurrent session.run detected on session ${ref.id}`)
          config.reserveRequest?.({ route, estimatedInputTokens: 25, maxOutputTokens: 100, kind: 'prompt' })
          config.onEvent({ type: 'prompt.accepted' })
          config.onEvent({ type: 'model.request_started' })
          config.onEvent({ type: 'model.usage', input: 20, output: 10, cacheRead: 0, cacheWrite: 0 })
          const call: ToolCallFn = async (name, input) => {
            const tool = config.tools.find(item => item.name === name)
            assert.ok(tool, `${config.role} is missing tool ${name}`)
            return await tool.execute(randomUUID(), input) as ToolReply
          }
          return { status: 'completed', text: await this.#script(config, call, prompt, ref.id) }
        } catch (error) {
          this.errors.push(error)
          return { status: 'runtime_error' }
        } finally {
          this.#activeRuns.set(ref.id, (this.#activeRuns.get(ref.id) ?? 1) - 1)
        }
      },
      steer: async () => {},
      requestStop: async () => {},
      checkpoint: async () => {},
      abort: async () => {},
      dispose: async () => {},
    }
  }
}

async function workspaceFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'zlo-multi-opt-'))
  const cwd = join(root, 'project')
  await mkdir(join(cwd, 'src'), { recursive: true })
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'opt-demo', version: '1.0.0' }))
  await writeFile(join(cwd, 'src', 'app.ts'), 'export const value = 1\n')
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, cwd, directory: join(root, 'state') }
}

function nodeEvent(taskId: string, taskNodeId: string, taskAttemptId?: string): EventDraft {
  return { taskId, taskNodeId, taskAttemptId, type: '', payload: {} }
}

const okResult: WorkerResult = {
  resultStatus: 'succeeded', summary: 'Delivered verified changes', artifactRefs: [], evidenceRefs: [], remainingRisks: [],
}

test('Req 1 (TaskEngine): Team succeeds after child Worker failure without mutating failed record, while unresolved ops still block', (t) => {
  const store = new LocalStore(':memory:')
  t.after(() => store.close())
  const engine = new TaskEngine(store)
  const { taskId } = engine.create({
    requestId: 'req1-engine',
    goal: 'Implement feature with Team resilience',
    cwd: 'ignored',
    workspaceAccess: 'write',
  })
  const [team, failingChild, blockedDownstream, recoveryChild] = engine.proposePlan(taskId, 'plan-1', 0, [
    { ref: 'team', goal: 'Own feature module', role: 'team', teamKey: 'core', access: 'write', scopePath: 'src' },
    { ref: 'failChild', goal: 'Initial attempt', parentNodeId: 'team', access: 'write', scopePath: 'src' },
    { ref: 'blockedDown', goal: 'Blocked downstream', parentNodeId: 'team', dependencies: ['failChild'] },
    { ref: 'recovery', goal: 'Replacement attempt', parentNodeId: 'team', access: 'write', scopePath: 'src' },
  ])

  engine.start(taskId)
  const teamAttempt = engine.startWorker(taskId, team.id)
  const failAttempt = engine.startWorker(taskId, failingChild.id, { suspendParent: true })
  const failEv = nodeEvent(taskId, failingChild.id, failAttempt)
  engine.beginTool(taskId, failEv, 'fail-read', 'read_text_file', 'read')
  engine.finishTool(failEv, 'fail-read', 'failed', 'tool_result_failed')
  const settledFail = engine.settleWorker(taskId, failingChild.id, {
    resultStatus: 'failed',
    summary: 'Initial script failed',
    artifactRefs: ['src/app.ts'],
    evidenceRefs: ['fail-read'],
    remainingRisks: ['syntax_error'],
  }, { passed: false, evidence: 'syntax_error' })
  assert.equal(settledFail?.status, 'failed')

  // Run recovery child to prove Team can recover cleanly even with a failed sibling and a blocked downstream child.
  const recAttempt = engine.startWorker(taskId, recoveryChild.id, { suspendParent: true })
  const recEv = nodeEvent(taskId, recoveryChild.id, recAttempt)
  engine.beginTool(taskId, recEv, 'rec-edit', 'edit_text_file', 'write', 'src/app.ts')
  engine.finishTool(recEv, 'rec-edit', 'succeeded')
  const settledRec = engine.settleWorker(taskId, recoveryChild.id, {
    ...okResult,
    artifactRefs: ['src/app.ts'],
    evidenceRefs: ['rec-edit'],
  })
  assert.equal(settledRec?.status, 'succeeded')

  // Unblocked ready sibling would still prevent Team settlement; only blockedDown (blocked on failChild) may stay ready.
  const teamSettled = engine.settleWorker(taskId, team.id, {
    ...okResult,
    artifactRefs: ['src/app.ts'],
    evidenceRefs: ['rec-edit'],
  })
  assert.equal(teamSettled?.status, 'succeeded')

  // Preserves failed child status, evidence, and failed Attempt untouched.
  const snap = engine.get(taskId)
  const storedFail = snap.nodes?.find(n => n.id === failingChild.id)
  assert.equal(storedFail?.status, 'failed')
  assert.deepEqual(storedFail?.result?.remainingRisks, ['syntax_error'])
  assert.equal(snap.nodes?.find(n => n.id === blockedDownstream.id)?.status, 'ready')
  assert.equal(engine.attempts(taskId).find(a => a.id === failAttempt)?.status, 'failed')

  // Hierarchical Root acceptance: formal delivery node (team) succeeded, so Root TaskEngine.verify passes!
  engine.beginVerification(taskId)
  const verifiedTask = engine.verify(taskId, { passed: true, evidence: 'confirmed_workspace_operation' })
  assert.equal(verifiedTask.status, 'succeeded')

  // Safety invariant: unresolved/started operation on a failed child MUST still block BOTH parent settlement & Root verify.
  const { taskId: unsafeTask } = engine.create({ requestId: 'req1-unsafe', goal: 'Unsafe op check', cwd: 'ignored', workspaceAccess: 'write' })
  const [unsafeTeam, unsafeChild] = engine.proposePlan(unsafeTask, 'plan-u', 0, [
    { ref: 'uteam', goal: 'Team', role: 'team', teamKey: 'u', access: 'write' },
    { ref: 'uchild', goal: 'Fail with started write', parentNodeId: 'uteam', access: 'write' },
  ])
  engine.start(unsafeTask)
  engine.startWorker(unsafeTask, unsafeTeam.id)
  const uAttempt = engine.startWorker(unsafeTask, unsafeChild.id, { suspendParent: true })
  engine.beginTool(unsafeTask, nodeEvent(unsafeTask, unsafeChild.id, uAttempt), 'dangling-write', 'edit_text_file', 'write', 'src/app.ts')
  // Child fails without settling or with dangling started write
  engine.settleWorker(unsafeTask, unsafeChild.id, {
    resultStatus: 'failed', summary: 'Crashed', artifactRefs: [], evidenceRefs: [], remainingRisks: ['crash'],
  })
  const rejectedTeam = engine.settleWorker(unsafeTask, unsafeTeam.id, {
    resultStatus: 'succeeded', summary: 'Ignore crash', artifactRefs: [], evidenceRefs: [], remainingRisks: [],
  })
  assert.equal(rejectedTeam?.status, 'failed')
  assert.equal(rejectedTeam?.verification?.evidence, 'node_unsettled_operations')
  engine.beginVerification(unsafeTask)
  assert.throws(() => engine.verify(unsafeTask, { passed: false, evidence: 'dag_not_converged' }), /Tool receipts prevent/)
  // Resolve task state cleanly for DB hygiene.
  engine.end(unsafeTask, 'unknown_effect')
  assert.equal(engine.get(unsafeTask).status, 'needs_reconciliation')

  // Direct formal delivery node failure under Root STILL causes Root verification to fail with dag_not_converged.
  const { taskId: formalFailTask } = engine.create({ requestId: 'req1-formal-fail', goal: 'Root formal failure', cwd: 'ignored' })
  const [formalNode] = engine.proposePlan(formalFailTask, 'plan-f', 0, [{ ref: 'direct', goal: 'Inspect' }])
  engine.start(formalFailTask)
  engine.startWorker(formalFailTask, formalNode.id)
  engine.settleWorker(formalFailTask, formalNode.id, {
    resultStatus: 'failed', summary: 'Direct formal node failed', artifactRefs: [], evidenceRefs: [], remainingRisks: ['missing'],
  })
  engine.beginVerification(formalFailTask)
  assert.equal(engine.verify(formalFailTask, { passed: false, evidence: 'dag_not_converged' }).status, 'failed')
})

test('Req 1 (Host e2e): Team recovers from failing Worker via Mailbox feedback and Root delivers normally', { timeout: 15_000 }, async (t) => {
  const { cwd, directory } = await workspaceFixture(t)
  let teamTurn = 0
  let failingWorkerId = ''
  let recoveryWorkerId = ''
  const teamPrompts: string[] = []

  const execution = new MultiAgentFixture(async (config, call, prompt) => {
    if (config.role === 'root') {
      const res = await call('propose_task_plan', {
        nodes: [{ ref: 'featureTeam', goal: 'Implement src/app.ts change safely', role: 'team', teamKey: 'feature', access: 'write', scopePath: 'src' }],
      })
      assert.equal(res.ok, true)
      return 'Root verified and accepted Team delivery.'
    }
    if (config.role === 'team') {
      teamTurn++
      teamPrompts.push(prompt)
      if (teamTurn === 1) {
        // First Worker attempt fails! Wait=true returns full failure details.
        const first = await call('delegate_worker', {
          goal: 'Attempt #1: inspect nonexistent file',
          access: 'read',
          scopePath: 'src',
        })
        assert.equal(first.ok, false)
        assert.equal(first.resultStatus, 'failed')
        assert.ok(first.failureReason)
        assert.ok(Array.isArray(first.remainingRisks) && first.remainingRisks.length > 0)
        failingWorkerId = String(first.nodeId)

        // Team inspects details and immediately dispatches recovery replacement Worker!
        const second = await call('delegate_worker', {
          goal: 'Attempt #2: patch src/app.ts to export value = 2',
          access: 'write',
          scopePath: 'src',
        })
        assert.equal(second.ok, true)
        recoveryWorkerId = String(second.nodeId)
        return 'Recovered after initial Worker failure; src/app.ts updated via replacement Worker.'
      }
      return 'Team delivery completed.'
    }
    // Worker role
    if (prompt.includes('Attempt #1')) {
      await call('read_text_file', { path: 'src/missing-file.txt' })
      return '' // Empty summary + failed tool forces Worker failure with remainingRisks & failureReason.
    }
    const edited = await call('edit_text_file', { path: 'src/app.ts', oldText: 'value = 1', newText: 'value = 2' })
    assert.equal(edited.ok, true)
    return 'Updated src/app.ts to value = 2'
  })

  const host = new LocalAgentHost({ directory, execution, defaultRoute: routePlanner })
  try {
    const { taskId } = await host.createTask({ requestId: 'req1-host-recover', goal: 'Safely update app.ts', cwd, workspaceAccess: 'write' })
    await host.idle()
    assert.deepEqual(execution.errors, [])
    const task = host.getTask(taskId)
    assert.equal(task.status, 'succeeded')
    const failNode = task.nodes?.find(n => n.id === failingWorkerId)
    const recNode = task.nodes?.find(n => n.id === recoveryWorkerId)
    const teamNode = task.nodes?.find(n => n.role === 'team')
    assert.equal(failNode?.status, 'failed')
    assert.equal(recNode?.status, 'succeeded')
    assert.equal(teamNode?.status, 'succeeded')
  } finally {
    await host.close()
  }
})

test('Req 2: Event-driven scheduling removes wave barriers, supports async wait_task_nodes, and keeps Pi Session turns sequential', { timeout: 15_000 }, async (t) => {
  const { cwd, directory } = await workspaceFixture(t)
  await writeFile(join(cwd, 'src', 'a.txt'), 'alpha')
  await writeFile(join(cwd, 'src', 'b.txt'), 'beta')

  const timestamps: Record<string, number> = {}
  const rootPrompts: string[] = []
  let rootTurn = 0
  let fastNodeId = ''
  let slowNodeId = ''
  let afterFastNodeId = ''

  const execution = new MultiAgentFixture(async (config, call, prompt) => {
    if (config.role === 'root') {
      rootTurn++
      rootPrompts.push(prompt)
      if (rootTurn === 1) {
        // Non-blocking plan submission!
        const plan = await call('propose_task_plan', {
          wait: 'none',
          nodes: [
            { ref: 'fast', goal: 'Fast step', scopePath: 'src', tools: ['read_text_file'] },
            { ref: 'slow', goal: 'Slow step', scopePath: 'src', tools: ['read_text_file'] },
            { ref: 'afterFast', goal: 'After fast', dependencies: ['fast'], scopePath: 'src', tools: ['read_text_file'] },
          ],
        })
        assert.equal(plan.ok, true)
        assert.equal(plan.scheduled, true)
        const nodes = plan.nodes as Array<{ nodeId: string }>
        fastNodeId = nodes[0]!.nodeId
        slowNodeId = nodes[1]!.nodeId
        afterFastNodeId = nodes[2]!.nodeId

        // Explicitly wait for just ONE node ('any') -> wakes as soon as fast finishes, BEFORE slow finishes!
        const firstWake = await call('wait_task_nodes', { nodeIds: [fastNodeId, slowNodeId], mode: 'any', timeoutMs: 5000 })
        assert.equal(firstWake.ok, true)
        timestamps.rootWokeAny = Date.now()
        return 'Handled fast step completion via wait_task_nodes while slow continues.'
      }
      // Subsequent turns arrive safely at Mailbox boundaries as remaining nodes settle!
      const inspect = await call('get_task_nodes', {})
      assert.equal(inspect.ok, true)
      return 'All DAG steps observed via event-driven mailbox.'
    }

    if (prompt.startsWith('Fast step')) {
      timestamps.fastStart = Date.now()
      await call('read_text_file', { path: 'src/a.txt' })
      await delay(15)
      timestamps.fastEnd = Date.now()
      return 'Fast done'
    }
    if (prompt.startsWith('Slow step')) {
      timestamps.slowStart = Date.now()
      await call('read_text_file', { path: 'src/b.txt' })
      await delay(220)
      timestamps.slowEnd = Date.now()
      return 'Slow done'
    }
    if (prompt.startsWith('After fast')) {
      timestamps.afterFastStart = Date.now()
      await call('read_text_file', { path: 'src/a.txt' })
      return 'After fast done'
    }
    return 'Ok'
  })

  const host = new LocalAgentHost({ directory, execution, defaultRoute: routePlanner })
  try {
    const { taskId } = await host.createTask({ requestId: 'req2-event-driven', goal: 'Verify zero wave barrier', cwd, workspaceAccess: 'read' })
    await host.idle()
    assert.deepEqual(execution.errors, [])
    const task = host.getTask(taskId)
    assert.equal(task.status, 'succeeded')

    // Key proof 1: afterFast started BEFORE slow finished (no Promise.allSettled wave barrier!).
    assert.ok(timestamps.afterFastStart !== undefined && timestamps.slowEnd !== undefined)
    assert.ok(timestamps.afterFastStart < timestamps.slowEnd,
      `Expected afterFastStart (${timestamps.afterFastStart}) < slowEnd (${timestamps.slowEnd})`)

    // Key proof 2: Root wait_task_nodes('any') woke BEFORE slow finished!
    assert.ok(timestamps.rootWokeAny < timestamps.slowEnd,
      `Expected rootWokeAny (${timestamps.rootWokeAny}) < slowEnd (${timestamps.slowEnd})`)

    // Key proof 3: Pi Session concurrency safety (never > 1 concurrent run on any Session).
    for (const [sid, peak] of execution.sessionConcurrentPeaks) {
      assert.equal(peak, 1, `Expected peak <= 1 on session ${sid}`)
    }

    // Key proof 4: Slow and afterFast woke subsequent Root turn cleanly with structured Mailbox update.
    assert.ok(rootPrompts.length >= 2)
    assert.ok(rootPrompts.some(p => p.includes(slowNodeId) || p.includes(afterFastNodeId)))
  } finally {
    await host.close()
  }
})

test('Req 3: Team Identity decouples from permissions, worktree, and Provider; revoked writes apply immediately; omitted access inherits write safely', { timeout: 15_000 }, async (t) => {
  const { cwd, directory } = await workspaceFixture(t)
  let phase = 1
  const teamSessions: string[] = []
  const teamAgentIds: string[] = []
  let deniedRevokedWrite = false

  const execution = new MultiAgentFixture(async (config, call, prompt, sessionId) => {
    if (config.role === 'root') {
      if (phase === 1) {
        const res = await call('propose_task_plan', {
          nodes: [{
            ref: 'fe',
            goal: 'Phase 1 write task under Team',
            role: 'team',
            teamKey: 'frontend',
            access: 'write',
            scopePath: 'src',
          }],
        })
        assert.equal(res.ok, true)
        return 'Phase 1 root done'
      }
      if (phase === 2) {
        // Note: omits `access: 'read'` intentionally so we prove Conversation-level revocation applies live on resume!
        const res = await call('propose_task_plan', {
          nodes: [{
            ref: 'fe2',
            goal: 'Phase 2 same Provider after user revoked write',
            role: 'team',
            teamKey: 'frontend',
            scopePath: 'src',
          }],
        })
        assert.equal(res.ok, true)
        return 'Phase 2 root done'
      }
      // Phase 3: same TeamKey on DIFFERENT Provider -> identity preserved, fresh Session!
      const res = await call('propose_task_plan', {
        nodes: [{
          ref: 'fe3',
          goal: 'Phase 3 different Provider',
          role: 'team',
          teamKey: 'frontend',
          route: routeCoding,
        }],
      })
      assert.equal(res.ok, true)
      return 'Phase 3 root done'
    }

    if (config.role === 'team') {
      teamSessions.push(sessionId)
      if (phase === 1) {
        // Child omits `access` under a write-authorized Team -> inherits 'write' automatically (Req 3.8)!
        const w = await call('delegate_worker', {
          goal: 'Edit src/app.ts via omitted inherited write access',
          scopePath: 'src',
        })
        assert.equal(w.ok, true)
        return 'Team phase 1 done'
      }
      if (phase === 2) {
        // Parent access was downgraded to read -> Team does NOT inherit write tools from old Session!
        assert.equal(config.tools.some(item => item.name === 'edit_text_file'), false)
        const r = await call('read_text_file', { path: 'src/app.ts' })
        assert.equal(r.ok, true)
        // Attempting to delegate a write Worker when Team is read-only MUST be rejected by boundary checks!
        const badWrite = await call('delegate_worker', {
          goal: 'Try unauthorized escalation',
          access: 'write',
          scopePath: 'src',
        })
        assert.equal(badWrite.ok, false)
        deniedRevokedWrite = true
        return 'Team phase 2 done cleanly within narrowed read grant'
      }
      await call('read_text_file', { path: 'src/app.ts' })
      return 'Team phase 3 done on new provider'
    }

    // Worker
    if (prompt.includes('inherited write access')) {
      assert.ok(config.tools.some(item => item.name === 'edit_text_file'), 'Omitted child access should inherit write under write parent')
      const edit = await call('edit_text_file', { path: 'src/app.ts', oldText: 'value = 1', newText: 'value = 10' })
      assert.equal(edit.ok, true)
      return 'Edited under inherited write grant'
    }
    return 'Worker read ok'
  })

  const host = new LocalAgentHost({ directory, execution, defaultRoute: routePlanner })
  try {
    const conv = host.createConversation({ requestId: 'conv-req3', title: 'Identity decoupling', workspace: cwd, workspaceAccess: 'write' })

    // Task 1: Team 'frontend' with write access on openai/planner-pro
    const s1 = await host.sendMessage({ conversationId: conv.id, requestId: 'msg-1', text: 'Phase 1' })
    await host.idle()
    assert.equal(host.getTask(s1.taskId).status, 'succeeded')

    // User revokes write access on the Conversation before Task 2!
    host.setConversationWorkspaceAccess(conv.id, 'read', 'write')
    phase = 2
    const s2 = await host.sendMessage({ conversationId: conv.id, requestId: 'msg-2', text: 'Phase 2' })
    await host.idle()
    assert.equal(host.getTask(s2.taskId).status, 'succeeded')
    assert.equal(deniedRevokedWrite, true)

    // Phase 3: Different Provider for the same Team
    phase = 3
    const s3 = await host.sendMessage({ conversationId: conv.id, requestId: 'msg-3', text: 'Phase 3' })
    await host.idle()
    assert.equal(host.getTask(s3.taskId).status, 'succeeded')

    for (const taskId of [s1.taskId, s2.taskId, s3.taskId]) {
      const teamEvent = host.events(taskId).find(ev => ev.type === 'agent.started' && ev.payload.role === 'team')
      assert.ok(teamEvent?.agentId)
      teamAgentIds.push(teamEvent.agentId)
    }

    assert.deepEqual(execution.errors, [])
    // All 3 phases share the EXACT SAME logical Team agentId!
    assert.equal(new Set(teamAgentIds).size, 1)
    // Phase 2 resumed compatible same-(provider, cwd) Session; Phase 3 switched Provider so started a fresh Session!
    assert.equal(teamSessions[1], teamSessions[0])
    assert.notEqual(teamSessions[2], teamSessions[0])
  } finally {
    await host.close()
  }
})

test('Req 4: ModelScheduler routes cross-provider fresh Workers by role, preserves Memory across Providers, and handles fallback', { timeout: 15_000 }, async (t) => {
  // Part A: Scheduler unit checks
  const store = new LocalStore(':memory:')
  t.after(() => store.close())
  const observedTaskRoles: unknown[] = []
  const fixtureExec = new MultiAgentFixture(async () => 'unused')
  const judgment = new LocalJudgment(store, {
    modes: { 'model.task_fit': 'shadow' },
    judge: {
      async evaluate(decision) {
        observedTaskRoles.push({ role: decision.input.taskRole, budget: decision.input.budgetRemaining })
        return { output: 0 }
      },
    },
  })
  const scheduler = new LocalModelScheduler(fixtureExec, store, judgment)
  const ev: EventDraft = { taskId: 't-route', taskRunId: 'r1', agentRunId: 'root', type: '', payload: {} }

  // Existing session resume MUST refuse cross-provider switching.
  await assert.rejects(
    scheduler.allocate(ev, routePlanner, routeCoding, false, 'Resume session', undefined, { sessionMode: 'resume' }),
    /Cross-provider/,
  )
  // Fresh Worker sessions allocate cross-provider by inferred task role!
  const pickedResearch = await scheduler.allocate(ev, routePlanner, undefined, true, 'Research and inspect codebase docs')
  assert.deepEqual(pickedResearch, routeResearch)
  const pickedReview = await scheduler.allocate(ev, routePlanner, undefined, true, 'Review and verify diff')
  assert.notEqual(pickedReview.provider, routePlanner.provider)
  assert.ok(observedTaskRoles.length >= 2)

  // Unavailable primary falls back via allocateFallback after markRouteFailed.
  fixtureExec.markUnavailable(routeResearch)
  scheduler.markRouteFailed(routeResearch)
  const fallback = await scheduler.allocateFallback(ev, routePlanner, routeResearch, 'Research codebase')
  assert.ok(fallback)
  assert.notEqual(fallback.model, routeResearch.model)

  // Part B: End-to-end cross-provider Workers + Memory continuity across Root Provider switch
  const { cwd, directory } = await workspaceFixture(t)
  const recalledInTask2: string[] = []
  let taskTurn = 1
  const e2eExec = new MultiAgentFixture(async (config, call, prompt) => {
    if (config.role === 'root') {
      if (taskTurn === 1) {
        const res = await call('propose_task_plan', {
          nodes: [
            { ref: 'res', goal: 'Research and read src/app.ts', scopePath: 'src', tools: ['read_text_file'], route: routeResearch },
            { ref: 'cod', goal: 'Implement feature update in src/app.ts', scopePath: 'src', route: routeCoding, dependencies: ['res'] },
            { ref: 'rev', goal: 'Review and verify src/app.ts', scopePath: 'src', tools: ['read_text_file'], route: routeReview, dependencies: ['cod'] },
          ],
        })
        assert.equal(res.ok, true)
        return 'Completed cross-provider research -> coding -> review pipeline.'
      }
      recalledInTask2.push(prompt)
      return 'Task 2 recalled cross-provider memories successfully.'
    }
    if (config.route?.provider === routeResearch.provider) {
      await call('read_text_file', { path: 'src/app.ts' })
      return 'Research complete'
    }
    if (config.route?.provider === routeCoding.provider) {
      await call('edit_text_file', { path: 'src/app.ts', oldText: 'value = 1', newText: 'value = 42' })
      return 'Coding complete'
    }
    await call('read_text_file', { path: 'src/app.ts' })
    return 'Review complete'
  })

  const host = new LocalAgentHost({ directory, execution: e2eExec, defaultRoute: routePlanner })
  try {
    const conv = host.createConversation({ requestId: 'conv-req4', title: 'Cross-provider', workspace: cwd, workspaceAccess: 'write' })
    const first = await host.sendMessage({ conversationId: conv.id, requestId: 'm1', text: 'Run cross-provider pipeline' })
    await host.idle()
    assert.equal(host.getTask(first.taskId).status, 'succeeded')

    // Verify fresh cross-provider Worker sessions NEVER reused Root's session ref.
    const rootOpened = e2eExec.opened.find(item => item.role === 'root')!
    const workerOpened = e2eExec.opened.filter(item => item.role !== 'root')
    assert.deepEqual(
      workerOpened.map(item => item.route?.provider),
      [routeResearch.provider, routeCoding.provider, routeReview.provider],
    )
    for (const w of workerOpened) {
      assert.equal(w.resumed, undefined)
      assert.notEqual(w.sessionId, rootOpened.sessionId)
    }

    taskTurn = 2
    // Start Task 2 and inspect recalled memory across providers!
    const second = await host.sendMessage({ conversationId: conv.id, requestId: 'm2', text: 'Confirm workspace src/app.ts state' })
    await host.idle()
    assert.equal(host.getTask(second.taskId).status, 'succeeded')
    assert.ok(recalledInTask2[0]?.includes('src/app.ts'))
    assert.deepEqual(e2eExec.errors, [])
  } finally {
    await host.close()
  }
})

test('Req 5: Structured Memory distills all 7 kinds safely, deduplicates/updates versions, and never promotes failed writes to facts', { timeout: 15_000 }, async (t) => {
  // Part A: Pure unit verification of distillTaskMemories & ScopedContext
  const candidates = distillTaskMemories({
    taskId: 'task-m',
    rootNodeId: 'root-m',
    goal: 'Refactor src/app.ts cleanly',
    project: 'opt-demo',
    status: 'succeeded',
    route: routePlanner,
    check: { path: 'src/app.ts', contains: 'value = 2' },
    verification: { passed: true, verdict: 'verified', evidence: 'check_passed', basis: 'workspace_path' },
    nodes: [
      {
        id: 'team-1', parentNodeId: 'root-m', role: 'team', teamKey: 'backend', goal: 'Own backend refactor',
        status: 'succeeded', dependencies: [], scopePath: 'src',
        check: { path: 'src/app.ts', contains: 'value = 2' },
        verification: { passed: true, verdict: 'verified', evidence: 'check_passed', basis: 'workspace_path' },
        result: { resultStatus: 'succeeded', summary: 'Team verified', artifactRefs: ['src/app.ts'], evidenceRefs: ['op-ok'], remainingRisks: ['watch edge case'] },
      },
      {
        id: 'fail-w', parentNodeId: 'team-1', role: 'worker', goal: 'Bad initial patch',
        status: 'failed', dependencies: [], scopePath: 'src',
        result: { resultStatus: 'failed', summary: 'Failed', artifactRefs: [], evidenceRefs: [], remainingRisks: ['missing import'] },
        verification: { passed: false, verdict: 'failed', evidence: 'nonzero_exit', basis: 'handoff' },
      },
      {
        id: 'ok-w', parentNodeId: 'team-1', role: 'worker', goal: 'Good replacement patch',
        status: 'succeeded', dependencies: [], scopePath: 'src', route: routeCoding,
        result: { resultStatus: 'succeeded', summary: 'Fixed', artifactRefs: ['src/app.ts'], evidenceRefs: ['op-ok'], remainingRisks: [] },
        verification: { passed: false, verdict: 'unverified', evidence: 'node_receipt_present', basis: 'handoff' },
        replans: 1,
      },
      {
        id: 'consumer-w', parentNodeId: 'root-m', role: 'worker', goal: 'Consume backend deliverable',
        status: 'succeeded', dependencies: ['team-1'], scopePath: 'tests',
        result: { resultStatus: 'succeeded', summary: 'Checked', artifactRefs: [], evidenceRefs: [], remainingRisks: [] },
        verification: { passed: false, verdict: 'unverified', evidence: 'node_unverified', basis: 'handoff' },
      },
    ],
    operations: [
      { id: 'op-fail', tool: 'edit_text_file', effect: 'write', status: 'succeeded', target: 'src/bogus.ts', taskNodeId: 'fail-w' },
      { id: 'op-ok', tool: 'edit_text_file', effect: 'write', status: 'succeeded', target: 'src/app.ts', taskNodeId: 'ok-w' },
    ],
  })

  const kinds = new Set(candidates.map(c => c.kind))
  for (const expectedKind of ['fact', 'experience', 'decision', 'contract', 'failure_pattern', 'risk', 'assumption'] as const) {
    assert.ok(kinds.has(expectedKind), `Missing distilled MemoryKind ${expectedKind}`)
  }
  // Failed Worker's write must NEVER be recorded as a fact!
  assert.equal(candidates.some(c => c.kind === 'fact' && c.text.includes('src/bogus.ts')), false)
  assert.equal(candidates.some(c => c.kind === 'fact' && c.text.includes('src/app.ts')), true)
  // Parent-verified failure resolution is preserved with team provenance.
  const resolvedExp = candidates.find(c => c.kind === 'experience' && c.text.includes('Resolved worker failure'))
  assert.ok(resolvedExp?.teamKey === 'backend')
  assert.ok(resolvedExp?.sourceRefs.includes('fail-w'))

  // LocalMemory deduplication & versioned superseding + ScopedContext formatting
  const store = new LocalStore(':memory:')
  t.after(() => store.close())
  const memory = new LocalMemory(store)
  const judgment = new LocalJudgment(store)
  const context = new ScopedContext(memory, judgment)
  const ev: EventDraft = { taskId: 'mem-task', taskRunId: 'run1', agentRunId: 'root', type: '', payload: {} }
  const scope = JSON.stringify(['conv-mem'])

  memory.capture(ev, scope, candidates)
  // Re-capturing identical key & text from the SAME source deduplicates cleanly without creating a second row or bumping version!
  const initialCount = memory.list(scope).length
  memory.capture(ev, scope, [candidates.find(c => c.kind === 'failure_pattern')!])
  assert.equal(memory.list(scope).length, initialCount)

  // Updating text on an existing logical key from a NEW source increments version cleanly and records supersedes!
  const failPattern = candidates.find(c => c.kind === 'failure_pattern')!
  memory.capture({ ...ev, taskId: 'mem-task-2' }, scope, [{
    ...failPattern,
    text: failPattern.text + ' -> fixed with explicit import',
    sourceRefs: ['node-fixed'],
  }])
  const updated = memory.list(scope).find(item => item.key === failPattern.key)
  assert.equal(updated?.version, 2)
  assert.equal(updated?.supersedes, 1)
  assert.equal(memory.list(scope).length, initialCount)

  const prompt = await context.build(ev, { scope, goal: 'Check backend src failure assumption risk edge case' })
  assert.ok(prompt.includes('(unverified') || prompt.includes('team:backend'))

  // Part B: Failed task end-to-end memory capture & management deletion
  const { cwd, directory } = await workspaceFixture(t)
  const failExec = new MultiAgentFixture(async (config, call) => {
    if (config.role === 'root') {
      await call('propose_task_plan', {
        nodes: [{ ref: 'broken', goal: 'Attempt risky change', access: 'write', scopePath: 'src' }],
      })
      return ''
    }
    await call('edit_text_file', { path: 'src/app.ts', oldText: 'value = 1', newText: 'value = 99' })
    // Return empty summary to force Worker failure even after write, verifying failed write is NOT saved as fact!
    return ''
  })

  const host = new LocalAgentHost({ directory, execution: failExec, defaultRoute: routePlanner })
  try {
    const conv = host.createConversation({ requestId: 'conv-req5', title: 'Failed memory test', workspace: cwd, workspaceAccess: 'write' })
    const sent = await host.sendMessage({ conversationId: conv.id, requestId: 'm-fail', text: 'Run failing task for memory capture' })
    await host.idle()
    assert.equal(host.getTask(sent.taskId).status, 'failed')

    const snap = await host.managementSnapshot(conv.id)
    const entries = snap.memory?.entries ?? []
    assert.ok(entries.some(e => e.kind === 'failure_pattern'), 'Failed task should capture failure_pattern')
    assert.ok(entries.some(e => e.kind === 'risk' && e.confidence === 'unverified'), 'Failed task should capture unverified risk')
    assert.equal(entries.some(e => e.kind === 'fact'), false, 'Failed Worker write must NEVER become a fact')

    const removed = await host.managementCommand({
      schemaVersion: 1,
      type: 'deleteConversationMemory',
      conversationId: conv.id,
      ids: entries.map(e => e.id),
    }) as number
    assert.equal(removed, entries.length)
    assert.equal((await host.managementSnapshot(conv.id)).memory?.entries.length, 0)
  } finally {
    await host.close()
  }
})

test('Req 2b: Team runs read-only child Workers concurrently and wakes on first child completion via Mailbox before slow sibling ends', { timeout: 15_000 }, async (t) => {
  const { cwd, directory } = await workspaceFixture(t)
  await writeFile(join(cwd, 'src', 'one.txt'), 'one')
  await writeFile(join(cwd, 'src', 'two.txt'), 'two')

  const timings: Record<string, number> = {}
  const bothStarted = Promise.withResolvers<void>()
  let readWorkers = 0
  let teamTurn = 0

  const execution = new MultiAgentFixture(async (config, call, prompt) => {
    if (config.role === 'root') {
      const res = await call('propose_task_plan', {
        nodes: [{ ref: 't1', goal: 'Coordinate concurrent internal readers', role: 'team', teamKey: 'readers', access: 'write', scopePath: 'src' }],
      })
      assert.equal(res.ok, true)
      return 'Root done'
    }
    if (config.role === 'team') {
      teamTurn++
      if (teamTurn === 1) {
        const w1 = await call('delegate_worker', { goal: 'Fast internal read', access: 'read', scopePath: 'src', wait: false })
        const w2 = await call('delegate_worker', { goal: 'Slow internal read', access: 'read', scopePath: 'src', wait: false })
        assert.equal(w1.ok, true)
        assert.equal(w2.ok, true)
        return 'Launched both internal read Workers concurrently'
      }
      if (teamTurn === 2) {
        timings.teamTurn2 = Date.now()
        assert.ok(prompt.includes('Child node completion events'))
        return 'Observed fast child completion immediately'
      }
      timings.teamTurn3 = Date.now()
      return 'Observed remaining child completion'
    }
    readWorkers++
    if (readWorkers === 2) bothStarted.resolve()
    await Promise.race([bothStarted.promise, delay(3_000, undefined, { ref: false }).then(() => {
      throw new Error('Internal Team read Workers did not start concurrently')
    })])
    if (prompt.startsWith('Fast internal read')) {
      const r = await call('read_text_file', { path: 'src/one.txt' })
      assert.equal(r.ok, true)
      timings.fastDone = Date.now()
      return 'Fast read complete'
    }
    const r = await call('read_text_file', { path: 'src/two.txt' })
    assert.equal(r.ok, true)
    await delay(200)
    timings.slowDone = Date.now()
    return 'Slow read complete'
  })

  const host = new LocalAgentHost({ directory, execution, defaultRoute: routePlanner })
  try {
    const { taskId } = await host.createTask({ requestId: 'req2b-team', goal: 'Test Team Mailbox concurrency', cwd, workspaceAccess: 'write' })
    await host.idle()
    assert.deepEqual(execution.errors, [])
    assert.equal(host.getTask(taskId).status, 'succeeded')
    assert.ok(timings.teamTurn2 < timings.slowDone,
      `Expected Team Turn 2 (${timings.teamTurn2}) to wake before slow sibling (${timings.slowDone})`)
    for (const [, peak] of execution.sessionConcurrentPeaks) assert.equal(peak, 1)
  } finally {
    await host.close()
  }
})
