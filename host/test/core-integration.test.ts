import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { ExecutionConfig, ExecutionResult } from '../src/execution.ts'
import { FakeExecution } from '../src/fake.ts'
import { LocalAgentHost } from '../src/host.ts'
import { PiExecution } from '../src/pi.ts'
import { ExtensionRegistry } from '../src/policies.ts'
import { jevEndpoint, judgmentPoints, phaseTwoJudgmentPoints } from '../../shared/contracts/jev.ts'
import { createFileTools } from '../src/file-tools.ts'
import type { JevStatus } from '../../shared/contracts/jev.ts'

type Call = (name: string, input: unknown) => Promise<unknown>
type Script = (config: ExecutionConfig, prompt: string, call: Call, signal: AbortSignal) => Promise<string>
const route = { provider: 'fake', model: 'coding' }

class ScriptExecution extends FakeExecution {
  readonly #script: Script
  readonly #fixtureSkills: boolean

  constructor(script: Script, fixtureSkills = false) { super(); this.#script = script; this.#fixtureSkills = fixtureSkills }

  override async open(config: ExecutionConfig) {
    const session = await super.open(config)
    if (this.#fixtureSkills && config.role === 'root') await config.selectSkills?.([
      { name: 'local-docs', description: 'How to write project documentation' },
      { name: 'backend-test', description: 'How to verify local API code' },
    ])
    const abort = new AbortController()
    let active: Promise<ExecutionResult> | undefined
    return {
      ...session,
      run: async (prompt: string) => {
        const call: Call = async (name, input) => {
          const tool = config.tools.find(item => item.name === name)
          assert.ok(tool, name)
          return tool.execute(randomUUID(), input, abort.signal)
        }
        active = (async (): Promise<ExecutionResult> => {
          try {
            config.reserveRequest?.({ route: session.route, estimatedInputTokens: 20, maxOutputTokens: 80, kind: 'prompt' })
            config.onEvent({ type: 'model.request_started' })
            config.onEvent({ type: 'model.usage', input: 15, output: 5, cacheRead: 0, cacheWrite: 0 })
            const text = await this.#script(config, prompt, call, abort.signal)
            return abort.signal.aborted ? { status: 'interrupted' } : { status: 'completed', text }
          } catch {
            return { status: abort.signal.aborted ? 'interrupted' : 'runtime_error' }
          }
        })()
        try { return await active } finally { active = undefined }
      },
      async requestStop() { abort.abort(); await active },
    }
  }
}

async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'zlo-core-'))
  const workspace = join(path, 'project')
  await mkdir(join(workspace, 'src'), { recursive: true })
  return { path, workspace, directory: join(path, 'state'), defaultRoute: route }
}

function ok(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && 'ok' in value && value.ok === true)
}

test('Host journals an approved shell command while it runs and accepts only its owner polling it', { timeout: 20_000 }, async () => {
  const env = await fixture()
  const script = join(env.workspace, 'approved-process.cjs')
  await writeFile(script, [
    "const { existsSync } = require('node:fs')",
    "console.log('approved-process')",
    "const timer = setInterval(() => { if (existsSync('release.flag')) clearInterval(timer) }, 25)",
  ].join('\n'))
  let approvals = 0
  let pollingFailure: unknown
  const execution = new ScriptExecution(async (_config, _prompt, call) => {
    try {
      const launched = await call('shell_exec', process.platform === 'win32'
        ? { shell: 'powershell', command: `& '${process.execPath.replaceAll("'", "''")}' '${script.replaceAll("'", "''")}'` }
        : { shell: 'sh', command: `"${process.execPath}" "${script}"` }) as { ok: boolean; processId: string }
      assert.ok(launched.ok)
      const input = { processId: launched.processId }
      assert.equal(ok(await call('create_text_file', { path: 'blocked.txt', content: 'overlap' })), false)
      await writeFile(join(env.workspace, 'release.flag'), '')
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const status = await call('process_status', input) as { ok: boolean; state: string; exitCode?: number }
        assert.equal(status.ok, true, 'The owning Agent must be able to poll a managed command')
        if (status.state === 'exited') {
          assert.equal(status.exitCode, 0)
          assert.match(JSON.stringify(await call('process_output', input)), /approved-process/)
          return 'Command completed'
        }
        await delay(50)
      }
      throw new Error('Shell did not settle')
    } catch (error) {
      pollingFailure = error
      throw error
    }
  })
  const host = new LocalAgentHost({ ...env, execution, approveTool: async request => {
    assert.equal(request.kind, 'shell')
    assert.match(request.detail, /approved-process/)
    approvals++
    return { approved: true }
  } })
  try {
    const { taskId } = await host.createTask({
      requestId: 'shell', goal: 'Execute the command', cwd: env.workspace, workspaceAccess: 'trusted',
    })
    await host.idle()
    assert.ifError(pollingFailure)
    assert.equal(host.getTask(taskId).status, 'succeeded')
    assert.equal(approvals, 1)
    const operations = host.getHistory(taskId).operations
    assert.ok(operations.some(({ tool, status, managed }) => tool === 'shell_exec' && status === 'succeeded' && managed))
    assert.ok(operations.some(({ tool, status }) => tool === 'process_output' && status === 'succeeded'))
    assert.ok(!operations.some(({ tool }) => tool === 'create_text_file'))
  } finally {
    await host.close()
    await rm(env.path, { recursive: true, force: true })
  }
})

test('Phase 2 judges run at real tool, worker, and turn boundaries with bounded Active follow-up', async () => {
  const env = await fixture()
  const publicText = 'Example public documentation. '.repeat(110)
  const extensions = new ExtensionRegistry([
    { id: 'files', tools: createFileTools },
    { id: 'test-web', tools: () => [{
      name: 'web_fetch', description: 'Fixture that returns a public document', effect: 'read',
      parameters: { type: 'object' },
      async execute() { return { ok: true, untrusted: true, title: 'Example', text: publicText } },
    }] },
  ])
  let rootPasses = 0
  let scriptError: unknown
  const execution = new ScriptExecution(async (config, prompt, call) => {
    try {
      if (config.role === 'worker') {
        assert.ok(ok(await call('create_text_file', { path: 'src/child.txt', content: 'worker artifact' })))
        await call('read_text_file', { path: 'src/child.txt' })
        return 'Worker delivered and checked child.txt'
      }
      rootPasses++
      if (rootPasses === 1) {
        assert.ok(ok(await call('create_text_file', { path: 'src/root.txt', content: 'root artifact' })))
        const child = await call('delegate_task', { goal: 'Write and read child.txt', access: 'write', scopePath: 'src' })
        assert.ok(ok(child), JSON.stringify(child))
        assert.ok(JSON.stringify(child).includes('patch_scope_review'))
        assert.ok(ok(await call('search_files', { glob: '**/*.txt' })))
        const web = await call('web_fetch', {}) as { ok: boolean; text: string; evidenceId?: string }
        assert.ok(web.ok)
        assert.ok(web.evidenceId)
        assert.ok(web.text.includes('[Excerpt omitted.]'))
        const evidence = await call('read_tool_evidence', { evidenceId: web.evidenceId })
        assert.ok(JSON.stringify(evidence).includes(publicText))
        return 'The files were written. I still need a local verification pass.'
      }
      assert.match(prompt, rootPasses === 2 ? /Before closing/ : /Continue any unfinished work/)
      assert.equal(ok(await call('web_fetch', {})), false)
      assert.ok(ok(await call('read_text_file', { path: 'src/root.txt' })))
      return 'Verified the current root file.'
    } catch (error) { scriptError = error; throw error }
  }, true)
  const jevFetch: typeof fetch = async (_url, init) => {
    const { questions } = JSON.parse(String(init?.body)) as { questions: Record<string, { instructions: string }> }
    return Response.json({ model: 'jev-1.14.0', usage: { input_tokens: 38, output_tokens: 8 },
      answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => {
        const supportsFollowUp = /At this completion boundary|Did the agent stop before/i.test(question.instructions)
        const workerDone = /Worker delivered/i.test(String(init?.body))
        const flagPatch = /reported changes appear unrelated/i.test(question.instructions)
        return [id, { type: 'noul', noul: (supportsFollowUp && !workerDone) || flagPatch ? 0.99 : 0.01 }]
      })) })
  }
  const host = new LocalAgentHost({ ...env, execution, extensions, jevFetch, jevKey: 'synthetic-test-key' })
  try {
    const { settings } = await host.managementCommand({ schemaVersion: 1, type: 'getJevStatus' }) as JevStatus
    for (const { id } of phaseTwoJudgmentPoints) settings.modes[id] = 'active'
    await host.managementCommand({ schemaVersion: 1, type: 'saveJevSettings', settings: { ...settings, enabled: true } })
    const { taskId } = await host.createTask({ requestId: 'phase-2', cwd: env.workspace, goal: 'Write scoped artifacts', workspaceAccess: 'write' })
    await host.idle()
    assert.ifError(scriptError)
    assert.equal(rootPasses, 3)
    assert.equal(host.getTask(taskId).verification?.verdict, 'unverified')
    const evaluated = host.events(taskId).filter(event => event.type === 'judgment.evaluated' && event.payload.requestSent)
    const actual = new Set(evaluated.map(event => event.payload.id))
    assert.deepEqual(actual, new Set(phaseTwoJudgmentPoints.map(({ id }) => id)))
    assert.equal(evaluated.filter(event => event.payload.id === 'turn.completion').length, 1)
    assert.equal(evaluated.filter(event => event.payload.id === 'turn.continue' && event.payload.output === true).length, 1)
    assert.ok(!JSON.stringify(evaluated).includes(publicText.slice(0, 100)))
  } finally {
    await host.close()
    await rm(env.path, { recursive: true, force: true })
  }
})

test('stopping a task with an active shell records unknown effects and refuses to replay it', { timeout: 15_000 }, async () => {
  const env = await fixture()
  const started = Promise.withResolvers<void>()
  const execution = new ScriptExecution(async (_config, _prompt, call, signal) => {
    const result = await call('shell_exec', process.platform === 'win32'
      ? { shell: 'powershell', command: 'Start-Sleep -Seconds 30' }
      : { shell: 'sh', command: 'sleep 30' })
    assert.ok(ok(result))
    started.resolve()
    await delay(30_000, undefined, { signal })
    return 'Unexpected completion'
  })
  const host = new LocalAgentHost({ ...env, execution, approveTool: async () => ({ approved: true }) })
  try {
    const { taskId } = await host.createTask({
      requestId: 'shell-stop', goal: 'Start the process', cwd: env.workspace, workspaceAccess: 'trusted',
    })
    await Promise.race([started.promise, delay(5_000, undefined, { ref: false }).then(() => { throw new Error('Shell did not start') })])
    assert.ok(host.getHistory(taskId).operations.some(({ tool, status }) => tool === 'shell_exec' && status === 'started'))
    assert.equal(host.stop(taskId, 'shell-stop-user').accepted, true)
    await host.idle()
    assert.equal(host.getTask(taskId).status, 'needs_reconciliation')
    assert.ok(host.getHistory(taskId).operations.some(({ tool, status }) => tool === 'shell_exec' && status === 'unknown_effect'))
    assert.equal(host.resume(taskId, 'shell-no-replay').accepted, false)
  } finally {
    await host.close()
    await rm(env.path, { recursive: true, force: true })
  }
})

test('approved Git worktrees isolate two real concurrent write nodes and merge only confirmed local commits', { timeout: 25_000 }, async () => {
  const env = await fixture()
  await writeFile(join(env.workspace, 'src', 'base.txt'), 'baseline')
  const git = (...args: string[]) => execFileSync('git', ['-C', env.workspace, ...args], { windowsHide: true, stdio: 'pipe' })
  git('init', '-q')
  git('config', '--local', 'user.name', 'Zlo Test')
  git('config', '--local', 'user.email', 'zlo@example.test')
  git('add', '--', 'src/base.txt')
  git('commit', '-qm', 'baseline')
  const concurrent = Promise.withResolvers<void>()
  const roots = new Set<string>()
  const execution = new ScriptExecution(async (config, prompt, call) => {
    if (config.role === 'root') {
      const assignments = []
      for (const branch of ['node-one', 'node-two']) {
        const created = await call('git_worktree', { branch }) as { ok: boolean; worktreeId: string }
        assert.ok(created.ok)
        assignments.push({ ref: branch, goal: branch, access: 'write', scopePath: 'src', worktreeId: created.worktreeId,
          check: { path: 'src/' + branch + '.txt', contains: branch } })
      }
      assert.ok(ok(await call('propose_task_plan', { nodes: assignments })))
      for (const assignment of assignments) {
        await assert.rejects(readFile(join(env.workspace, 'src', assignment.ref + '.txt')))
        assert.ok(ok(await call('git_commit', {
          worktreeId: assignment.worktreeId, message: 'Add ' + assignment.ref, paths: ['src/' + assignment.ref + '.txt'],
        })))
        assert.ok(ok(await call('git_merge', { branch: assignment.ref })))
      }
      return 'Both worktrees merged'
    }
    roots.add(config.cwd)
    if (roots.size === 2) concurrent.resolve()
    const ready = await Promise.race([concurrent.promise.then(() => true), delay(2_000, false, { ref: false })])
    assert.ok(ready)
    const branch = prompt.startsWith('node-one') ? 'node-one' : 'node-two'
    assert.ok(ok(await call('create_text_file', { path: 'src/' + branch + '.txt', content: branch })))
    return 'Verified branch'
  })
  const host = new LocalAgentHost({ ...env, execution, approveTool: async () => ({ approved: true }) })
  try {
    const { taskId } = await host.createTask({
      requestId: 'worktree', goal: 'Implement both branches', cwd: env.workspace, workspaceAccess: 'trusted',
    })
    await host.idle()
    assert.equal(host.getTask(taskId).status, 'succeeded')
    assert.equal(roots.size, 2)
    assert.ok(!roots.has(env.workspace))
    assert.equal(await readFile(join(env.workspace, 'src', 'node-one.txt'), 'utf8'), 'node-one')
    assert.equal(await readFile(join(env.workspace, 'src', 'node-two.txt'), 'utf8'), 'node-two')
    assert.equal(new Set(host.getHistory(taskId).operations.filter(({ tool }) => tool === 'create_text_file')
      .map(({ worktreeId }) => worktreeId)).size, 2)
  } finally {
    await host.close()
    await rm(env.path, { recursive: true, force: true })
  }
})

test('Host runs a verified DAG with Team reuse, nested scope, replan and six live decisions', async () => {
  const env = await fixture()
  await writeFile(join(env.workspace, 'private.txt'), 'outside scoped Team')
  let recalled = false
  const requests: { state: Record<string, unknown>; questions: Record<string, { instructions: string }> }[] = []
  const jevFetch: typeof fetch = async (url, init) => {
    assert.equal(url, jevEndpoint)
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-jev-secret')
    const request = JSON.parse(String(init?.body)) as typeof requests[number]
    requests.push(request)
    return Response.json({ model: 'jev-1.14.0', usage: { input_tokens: 50, output_tokens: 3 },
      answers: Object.fromEntries(Object.keys(request.questions).map((id, index) =>
        [id, { type: 'noul', noul: index === 0 ? 0.98 : 0.02 }])) })
  }
  const execution = new ScriptExecution(async (config, prompt, call) => {
    if (config.role === 'root') {
      if (prompt.startsWith('Recall report.txt')) {
        recalled = prompt.includes('Confirmed workspace operation')
        return 'Recalled project evidence'
      }
      const result = await call('propose_task_plan', { nodes: [
        { ref: 'create', teamKey: 'docs', scopePath: 'src', access: 'write',
          goal: 'Create report.txt', check: { path: 'src/report.txt', contains: 'first' } },
        { ref: 'edit', role: 'team', teamKey: 'docs', scopePath: 'src', access: 'write',
          goal: 'Edit report.txt', check: { path: 'src/report.txt', contains: 'second' }, dependencies: ['create'] },
        { ref: 'review', goal: 'Try without evidence', scopePath: 'src', dependencies: ['edit'] },
      ] }) as { nodes?: { nodeId: string; status: string }[] }
      assert.deepEqual(result.nodes?.map(item => item.status), ['succeeded', 'succeeded', 'failed'])
      const retry = await call('replan_task_node', { nodeId: result.nodes![2].nodeId, goal: 'Read verified report.txt' })
      assert.ok(ok(retry))
      return 'Verified the completed plan'
    }
    if (config.role === 'team') {
      assert.equal(ok(await call('read_text_file', { path: 'private.txt' })), false)
      if (prompt.startsWith('Create report.txt')) {
        assert.ok(ok(await call('create_text_file', { path: 'src/report.txt', content: 'first' })))
        assert.ok(ok(await call('delegate_worker', { goal: 'Read nested report.txt' })))
      } else {
        assert.ok(config.session)
        assert.ok(ok(await call('edit_text_file', { path: 'src/report.txt', oldText: 'first', newText: 'second' })))
      }
      return 'Verified Team artifact'
    }
    if (!prompt.startsWith('Try without evidence')) assert.ok(ok(await call('read_text_file', { path: 'src/report.txt' })))
    return 'Worker report'
  })
  let host = new LocalAgentHost({ ...env, execution, jevFetch, jevKey: 'test-jev-secret' })
  try {
    const { settings } = await host.managementCommand({ schemaVersion: 1, type: 'getJevStatus' }) as JevStatus
    assert.equal(settings.enabled, false)
    assert.ok(Object.values(settings.modes).every(mode => mode === 'off'))
    const phaseOne = judgmentPoints.slice(0, 6)
    for (const { id } of phaseOne) settings.modes[id] = 'shadow'
    await host.managementCommand({ schemaVersion: 1, type: 'saveJevSettings', settings: { ...settings, enabled: true } })
    const conversation = host.createConversation({ requestId: 'new-core', workspace: env.workspace })
    assert.equal(conversation.workspaceAccess, 'write')
    const { taskId } = await host.sendMessage({ requestId: 'core-plan', conversationId: conversation.id, text: 'Execute project plan' })
    await host.idle()
    const task = host.getTask(taskId)
    assert.equal(task.status, 'succeeded')
    assert.equal(task.verification?.verdict, 'unverified')
    assert.equal(task.nodes?.length, 4)
    assert.ok(task.nodes?.every(node => node.status === 'succeeded'))
    assert.ok(task.nodes?.every(node => node.verification?.verdict === (node.check ? 'verified' : 'unverified')))
    assert.equal(await readFile(join(env.workspace, 'src', 'report.txt'), 'utf8'), 'second')
    const events = host.events(taskId)
    const phaseOneIds = new Set<string>(phaseOne.map(({ id }) => id))
    const phaseOneDecisions = events.filter(item => item.type === 'judgment.evaluated' && phaseOneIds.has(String(item.payload.id)))
    const decisions = new Set(phaseOneDecisions.map(item => item.payload.id))
    assert.deepEqual([...decisions].sort(), ['collaboration.mode', 'context.relevance', 'delegation.worth',
      'handoff.sufficiency', 'model.task_fit', 'task.replan'])
    for (const decision of phaseOneDecisions) {
      const { baseline, output, candidates, features, resultLink } = decision.payload
      assert.ok(Array.isArray(candidates) && candidates.includes(baseline) && candidates.includes(output))
      assert.ok(features && typeof features === 'object')
      const link = resultLink as Record<string, unknown>
      assert.equal(link.taskRunId, task.taskRunId)
      assert.equal(link.taskAttemptId, decision.taskAttemptId)
      assert.equal(link.taskNodeId, decision.taskNodeId)
      if (decision.payload.id === 'collaboration.mode' || decision.payload.id === 'task.replan') {
        assert.ok(events.some(item => item.type === 'task.plan_changed' && item.correlationId === link.planRequestId))
      }
      if (decision.payload.id === 'handoff.sufficiency') {
        assert.ok(events.some(item => item.type === 'task.node_settled' && item.taskAttemptId === link.taskAttemptId))
      }
    }
    const teams = events.filter(item => item.type === 'agent.started' && item.payload.role === 'team')
    assert.equal(teams.length, 2)
    assert.equal(teams[0].agentId, teams[1].agentId)
    assert.equal(teams[0].sessionId, teams[1].sessionId)
    assert.notEqual(teams[0].agentRunId, teams[1].agentRunId)
    assert.ok(events.some(item => item.type === 'agent.started' && item.parentAgentRunId === teams[0].agentRunId))
    assert.equal(host.getConversationHistory({ conversationId: conversation.id }).turns[0].nodes?.length, 4)
    assert.ok(events.some(item => item.type === 'memory.captured'))
    await host.close()
    host = new LocalAgentHost({ ...env, execution, jevFetch, jevKey: 'test-jev-secret' })
    const next = await host.sendMessage({ requestId: 'recall', conversationId: conversation.id, text: 'Recall report.txt' })
    await host.idle()
    assert.equal(host.getTask(next.taskId).status, 'succeeded')
    assert.ok(recalled)
    assert.ok(host.events(next.taskId).some(item => item.type === 'memory.recalled' && Number(item.payload.count) > 0))
    const realJudgments = [...events, ...host.events(next.taskId)]
      .filter(item => item.type === 'judgment.evaluated' && item.payload.judgeModel === 'jev-1.14.0')
    assert.deepEqual(new Set(realJudgments.map(item => item.payload.id)), phaseOneIds)
    assert.ok(realJudgments.every(({ payload }) => payload.baseline === payload.output))
    assert.ok(realJudgments.some(({ payload }) => payload.disagreement === true))
    assert.ok(requests.some(({ state }) => state.goal === 'Create report.txt' && state.parentGoal === 'Execute project plan'))
    assert.ok(requests.some(({ state }) => Array.isArray(state.options) && state.options.some(option => option.memory?.includes('report.txt'))))
    assert.ok(requests.some(({ state }) => state.summary === 'Verified Team artifact' && Array.isArray(state.successfulTools)))
    assert.ok(requests.some(({ state }) => state.proposedGoal === 'Read verified report.txt'))
    assert.ok(!JSON.stringify(realJudgments).includes('Create report.txt'))
  } finally {
    await host.close()
    await rm(env.path, { recursive: true, force: true })
  }
})

test('Stop quiesces a suspended Team and nested Worker, then resumes without leaking capacity', { timeout: 12000 }, async () => {
  const env = await fixture()
  await writeFile(join(env.workspace, 'src', 'receipt.txt'), 'read evidence')
  const entered = Promise.withResolvers<void>()
  let workerRuns = 0
  const execution = new ScriptExecution(async (config, prompt, call, signal) => {
    if (config.role === 'root') {
      if (!prompt.startsWith('Resume the task')) await call('propose_task_plan', { nodes: [
        { ref: 'team', role: 'team', teamKey: 'verify', goal: 'Verify source', scopePath: 'src' },
      ] })
    } else if (config.role === 'team') {
      assert.ok(ok(await call('delegate_worker', { goal: 'Inspect evidence' })) || signal.aborted)
    } else {
      if (++workerRuns === 1) {
        entered.resolve()
        await delay(10_000, undefined, { signal })
      }
      assert.ok(ok(await call('read_text_file', { path: 'src/receipt.txt' })))
    }
    return 'Read handoff'
  })
  const host = new LocalAgentHost({ ...env, execution })
  try {
    const { taskId } = await host.createTask({ requestId: 'start', goal: 'Read with team', cwd: env.workspace })
    await entered.promise
    assert.equal(host.stop(taskId, 'stop-team').status, 'stop_requested')
    await host.idle()
    assert.equal(host.getTask(taskId).status, 'stopped')
    assert.ok(host.getTask(taskId).nodes?.every(node => node.status === 'ready'))
    assert.deepEqual(await host.command({ type: 'getRouteStatus', schemaVersion: 1 }), { quota: 'unknown', activeReservations: 0 })
    assert.equal(host.resume(taskId, 'resume-team').accepted, true)
    await host.idle()
    assert.equal(host.getTask(taskId).status, 'succeeded')
    assert.equal(workerRuns, 2)
    const teamSessions = host.events(taskId).filter(item => item.type === 'agent.started' && item.payload.role === 'team')
    assert.equal(teamSessions.length, 2)
    assert.equal(teamSessions[0].sessionId, teamSessions[1].sessionId)
  } finally {
    await host.close()
    await rm(env.path, { recursive: true, force: true })
  }
})

test('the official Pi session runs a plan, a writing Team and a nested worker through their real tool schemas', async () => {
  const env = await fixture()
  const defaultRoute = { provider: 'faux', model: 'core-plan' }
  const faux = fauxProvider({ models: [{ id: defaultRoute.model }] })
  const execution = new PiExecution(async () => {
    const runtime = await ModelRuntime.create({
      authPath: join(env.path, 'faux-auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
    })
    runtime.registerNativeProvider(faux.provider)
    return runtime
  })
  const tool = (name: string, input: Parameters<typeof fauxToolCall>[1]) =>
    fauxAssistantMessage(fauxToolCall(name, input), { stopReason: 'toolUse' })
  faux.setResponses([
    tool('propose_task_plan', { nodes: [{ ref: 'implement', goal: 'Create draft.txt', role: 'team',
      teamKey: 'coding', access: 'write', scopePath: 'src', check: { path: 'src/draft.txt', contains: 'acceptance' } }] }),
    tool('create_text_file', { path: 'src/draft.txt', content: 'acceptance' }),
    tool('delegate_worker', { goal: 'Inspect draft.txt' }),
    tool('read_text_file', { path: 'src/draft.txt' }),
    fauxAssistantMessage('Worker verified the draft'),
    fauxAssistantMessage('Team handed off the draft'),
    fauxAssistantMessage('Verified delivery'),
  ])
  const host = new LocalAgentHost({ ...env, execution, defaultRoute })
  try {
    const { taskId } = await host.createTask({
      requestId: 'pi-core', goal: 'Draft the file', cwd: env.workspace, route: defaultRoute, workspaceAccess: 'write',
    })
    await host.idle()
    assert.equal(host.getTask(taskId).status, 'succeeded')
    assert.equal(await readFile(join(env.workspace, 'src', 'draft.txt'), 'utf8'), 'acceptance')
    const events = host.events(taskId)
    assert.deepEqual(events.filter(event => event.type === 'agent.started').map(event => event.payload.role), ['root', 'team', 'worker'])
    assert.equal(events.filter(event => event.type === 'model.reservation_settled').length, 7)
    assert.ok(events.filter(event => event.type === 'model.reservation_settled').every(event => event.payload.status === 'settled'))
  } finally {
    await host.close()
    await rm(env.path, { recursive: true, force: true })
  }
})

test('the budget gate denies a provider request before the execution backend does any work', async () => {
  const env = await fixture()
  let executed = false
  const execution = new ScriptExecution(async () => { executed = true; return 'Unexpected' })
  const host = new LocalAgentHost({ ...env, execution, modelLimits: { tokens: 99 } })
  try {
    const { taskId } = await host.createTask({ requestId: 'budget-limit', goal: 'Run', cwd: env.workspace })
    await host.idle()
    assert.equal(host.getTask(taskId).reason, 'budget_exhausted')
    assert.equal(executed, false)
    assert.ok(!host.events(taskId).some(event => event.type === 'model.request_started'))
    assert.deepEqual(await host.command({ type: 'getRouteStatus', schemaVersion: 1 }), { quota: 'unknown', activeReservations: 0 })
  } finally {
    await host.close()
    await rm(env.path, { recursive: true, force: true })
  }
})

test('a registered profile runs its workflow and capability inside Host authorization', async () => {
  const env = await fixture()
  await writeFile(join(env.workspace, 'receipt.txt'), 'accepted')
  const registry = new ExtensionRegistry()
  let usedWorkflow = false
  registry.registerPlugin({
    id: 'inspect',
    tools: () => [{
      name: 'inspect_project', description: 'Inspect the configured project', effect: 'read',
      parameters: { type: 'object', properties: {} },
      async execute() { return { ok: true } },
    }],
  })
  registry.registerWorkflow({
    id: 'review',
    systemPrompt: () => 'Review the selected workspace.',
    verify(workspace, check, signal, access) {
      usedWorkflow = true
      assert.equal(access, 'read')
      return workspace.verify(check, signal, access)
    },
  })
  registry.registerProfile({ id: 'review', workflow: 'review', plugins: ['workspace', 'inspect'], workspaceWrites: false, delegation: false })
  const execution = new ScriptExecution(async (config, _prompt, call) => {
    assert.equal(config.systemPrompt, 'Review the selected workspace.')
    assert.ok(!config.tools.some(({ name }) => ['create_text_file', 'propose_task_plan'].includes(name)))
    assert.ok(ok(await call('inspect_project', {})))
    return 'Reviewed'
  })
  const host = new LocalAgentHost({ ...env, execution, extensions: registry, profileId: 'review' })
  try {
    const { taskId } = await host.createTask({
      requestId: 'profile', cwd: env.workspace, goal: 'Review', check: { path: 'receipt.txt' }, workspaceAccess: 'write',
    })
    await host.idle()
    assert.equal(host.getTask(taskId).status, 'succeeded')
    assert.ok(usedWorkflow)
    assert.ok(host.getHistory(taskId).operations.some(({ tool, status }) => tool === 'inspect_project' && status === 'succeeded'))
  } finally {
    await host.close()
    await rm(env.path, { recursive: true, force: true })
  }
})
