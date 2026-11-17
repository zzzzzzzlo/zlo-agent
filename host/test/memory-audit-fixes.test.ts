import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { memoryKinds } from '../src/contracts/domain.ts'
import type { EventDraft, ModelRoute } from '../src/contracts/domain.ts'
import type { AgentExecution, ExecutionConfig, ExecutionResult, ModelCandidate } from '../src/execution.ts'
import { LocalAgentHost } from '../src/host.ts'
import { LocalJudgment } from '../src/judgment.ts'
import { distillTaskMemories, LocalMemory, memoryEntryInScope, ScopedContext, workspaceMemoryScope } from '../src/memory.ts'
import { createMemoryTools } from '../src/memory-tools.ts'
import { teamMemoryScope } from '../src/orchestrator.ts'
import { LocalStore } from '../src/store.ts'
import { telemetryEvent } from '../src/telemetry-projection.ts'
import { CodingWorkspace } from '../src/workspace.ts'

const routePrimary: ModelRoute = { provider: 'openai', model: 'gpt-planner' }
const routeAlt: ModelRoute = { provider: 'anthropic', model: 'claude-coder' }

interface ToolReply {
  ok: boolean
  error?: string
  [key: string]: unknown
}
type ToolCallFn = (name: string, input: unknown, callId?: string) => Promise<ToolReply>
type ScriptFn = (config: ExecutionConfig, call: ToolCallFn, prompt: string) => Promise<string>

class ScriptedExecution implements AgentExecution {
  readonly #models: ModelCandidate[]
  readonly #script: ScriptFn
  readonly errors: unknown[] = []

  constructor(script: ScriptFn) {
    this.#script = script
    this.#models = [
      { route: routePrimary, estimatedCost: 2, contextWindow: 128_000, input: ['text'], reasoning: true },
      { route: routeAlt, estimatedCost: 3, contextWindow: 200_000, input: ['text'], reasoning: true },
    ]
  }

  async validateRoute(route: ModelRoute): Promise<void> {
    if (!this.#models.some(item => item.route.provider === route.provider && item.route.model === route.model)) {
      throw new Error(`Unknown model ${route.provider}/${route.model}`)
    }
  }

  async discoverModels(provider?: string): Promise<ModelCandidate[]> {
    return this.#models.filter(item => !provider || item.route.provider === provider)
  }

  async open(config: ExecutionConfig) {
    const route = config.route ?? routePrimary
    const ref = config.session ?? { id: randomUUID(), path: join(config.sessionDirectory ?? config.cwd, `${randomUUID()}.jsonl`) }
    return {
      ref,
      route,
      run: async (prompt: string): Promise<ExecutionResult> => {
        try {
          config.reserveRequest?.({ route, estimatedInputTokens: 20, maxOutputTokens: 80, kind: 'prompt' })
          config.onEvent({ type: 'prompt.accepted' })
          config.onEvent({ type: 'model.request_started' })
          config.onEvent({ type: 'model.usage', input: 16, output: 8, cacheRead: 0, cacheWrite: 0 })
          const call: ToolCallFn = async (name, input, callId = randomUUID()) => {
            const tool = config.tools.find(item => item.name === name)
            assert.ok(tool, `${config.role} is missing tool ${name}`)
            return await tool.execute(callId, input) as ToolReply
          }
          return { status: 'completed', text: await this.#script(config, call, prompt) }
        } catch (error) {
          this.errors.push(error)
          return { status: 'runtime_error' }
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

async function createFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'zlo-mem-audit-'))
  const cwd = join(root, 'workspace')
  await mkdir(join(cwd, 'src'), { recursive: true })
  await mkdir(join(cwd, 'ui'), { recursive: true })
  await writeFile(join(cwd, 'src', 'app.ts'), 'export const v = 1\n')
  await writeFile(join(cwd, 'src', 'mod.ts'), 'export const mod = "ok"\n')
  await writeFile(join(cwd, 'ui', 'view.tsx'), 'export const view = true\n')
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, cwd, directory: join(root, 'state') }
}

test('Problem 1: distillTaskMemories rejects false sibling replacement attribution on failed tasks or unrelated siblings', () => {
  // 1a. Root task failed: failed child A must NEVER be marked resolved because sibling B succeeded (even in same scopePath).
  const rootFailed = distillTaskMemories({
    taskId: 'task-root-fail',
    rootNodeId: 'root-1',
    goal: 'Update src modules',
    status: 'failed',
    reason: 'verification_failed',
    verification: { passed: false, verdict: 'failed', evidence: 'dag_not_converged' },
    nodes: [
      {
        id: 'node-a-fail',
        parentNodeId: 'root-1',
        role: 'worker',
        goal: 'Patch auth handler',
        status: 'failed',
        dependencies: [],
        scopePath: 'src',
        result: { resultStatus: 'failed', summary: 'Failed', artifactRefs: [], evidenceRefs: [], remainingRisks: ['auth_broken'] },
        verification: { passed: false, verdict: 'failed', evidence: 'nonzero_exit' },
      },
      {
        id: 'node-b-ok',
        parentNodeId: 'root-1',
        role: 'worker',
        goal: 'Patch logger helper',
        status: 'succeeded',
        dependencies: [],
        scopePath: 'src',
        replans: 1,
        result: { resultStatus: 'succeeded', summary: 'Updated logger', artifactRefs: ['src/logger.ts'], evidenceRefs: ['op-b'], remainingRisks: [] },
        verification: { passed: false, verdict: 'unverified', evidence: 'node_confirmed_tool_receipt' },
      },
    ],
    operations: [
      { id: 'op-b', tool: 'edit_text_file', effect: 'write', status: 'succeeded', target: 'src/logger.ts', taskNodeId: 'node-b-ok' },
    ],
  })
  assert.equal(rootFailed.some(c => c.kind === 'experience' && c.text.includes('Resolved')), false)
  assert.equal(rootFailed.some(c => c.kind === 'experience' && c.key?.startsWith('replan:')), false)
  assert.equal(rootFailed.some(c => c.kind === 'failure_pattern' && c.nodeId === 'node-a-fail'), true)
  assert.equal(rootFailed.some(c => c.kind === 'risk' && c.text.includes('auth_broken')), true)

  // 1b. Succeeded Team with unrelated parallel scopes (src/auth failed vs src/billing succeeded) -> NOT resolved!
  const unrelatedScopes = distillTaskMemories({
    taskId: 'task-unrelated-scopes',
    rootNodeId: 'root-2',
    goal: 'Inspect and update modules',
    status: 'succeeded',
    verification: { passed: true, verdict: 'verified', evidence: 'workspace_command_passed' },
    nodes: [
      {
        id: 'team-main',
        parentNodeId: 'root-2',
        role: 'team',
        teamKey: 'core',
        goal: 'Coordinate core work',
        status: 'succeeded',
        dependencies: [],
        verification: { passed: false, verdict: 'unverified', evidence: 'node_completed_children' },
      },
      {
        id: 'worker-auth-fail',
        parentNodeId: 'team-main',
        role: 'worker',
        goal: 'Update auth',
        status: 'failed',
        dependencies: [],
        scopePath: 'src/auth',
        result: { resultStatus: 'failed', summary: 'Auth failed', artifactRefs: [], evidenceRefs: [], remainingRisks: ['token_parse_bug'] },
        verification: { passed: false, verdict: 'failed', evidence: 'tool_result_failed' },
      },
      {
        id: 'worker-billing-ok',
        parentNodeId: 'team-main',
        role: 'worker',
        goal: 'Update billing',
        status: 'succeeded',
        dependencies: [],
        scopePath: 'src/billing',
        result: { resultStatus: 'succeeded', summary: 'Billing ok', artifactRefs: ['src/billing/inv.ts'], evidenceRefs: ['op-bill'], remainingRisks: [] },
        verification: { passed: true, verdict: 'verified', evidence: 'workspace_text_file_exists' },
      },
    ],
    operations: [
      { id: 'op-bill', tool: 'edit_text_file', effect: 'write', status: 'succeeded', target: 'src/billing/inv.ts', taskNodeId: 'worker-billing-ok' },
    ],
  })
  assert.equal(unrelatedScopes.some(c => c.kind === 'experience' && c.text.includes('Resolved')), false)
  assert.equal(unrelatedScopes.some(c => c.kind === 'failure_pattern' && c.nodeId === 'worker-auth-fail'), true)
  assert.equal(unrelatedScopes.some(c => c.kind === 'risk' && c.text.includes('token_parse_bug')), true)

  // 1c. Earlier succeeded sibling (index 0) cannot be attributed as replacement for later failed sibling (index 1).
  //     Also tests parallel read-only siblings on disjoint files within same scopePath, and unscoped unrelated siblings.
  const earlierAndReadDisjoint = distillTaskMemories({
    taskId: 'task-order-and-reads',
    rootNodeId: 'root-3',
    goal: 'Check src files',
    status: 'succeeded',
    nodes: [
      {
        id: 'team-r',
        parentNodeId: 'root-3',
        role: 'team',
        teamKey: 'readers',
        goal: 'Read files',
        status: 'succeeded',
        dependencies: [],
        scopePath: 'src',
        verification: { passed: false, verdict: 'unverified', evidence: 'node_completed_children' },
      },
      {
        id: 'early-ok',
        parentNodeId: 'team-r',
        role: 'worker',
        goal: 'Early edit',
        status: 'succeeded',
        dependencies: [],
        scopePath: 'src',
        result: { resultStatus: 'succeeded', summary: 'Early', artifactRefs: ['src/early.ts'], evidenceRefs: ['op-early'], remainingRisks: [] },
      },
      {
        id: 'late-fail',
        parentNodeId: 'team-r',
        role: 'worker',
        goal: 'Late read failure',
        status: 'failed',
        dependencies: [],
        scopePath: 'src',
        result: { resultStatus: 'failed', summary: 'Missing target', artifactRefs: [], evidenceRefs: [], remainingRisks: ['missing_late_target'] },
      },
      {
        id: 'parallel-read-ok',
        parentNodeId: 'team-r',
        role: 'worker',
        goal: 'Read unrelated file',
        status: 'succeeded',
        dependencies: [],
        scopePath: 'src',
        result: { resultStatus: 'succeeded', summary: 'Read bar', artifactRefs: ['src/bar.ts'], evidenceRefs: ['op-read-bar'], remainingRisks: [] },
      },
    ],
    operations: [
      { id: 'op-early', tool: 'edit_text_file', effect: 'write', status: 'succeeded', target: 'src/early.ts', taskNodeId: 'early-ok' },
      { id: 'op-fail-foo', tool: 'read_text_file', effect: 'read', status: 'failed', target: 'src/foo.ts', taskNodeId: 'late-fail' },
      { id: 'op-read-bar', tool: 'read_text_file', effect: 'read', status: 'succeeded', target: 'src/bar.ts', taskNodeId: 'parallel-read-ok' },
    ],
  })
  assert.equal(earlierAndReadDisjoint.some(c => c.kind === 'experience' && c.text.includes('Resolved')), false)
  assert.equal(earlierAndReadDisjoint.some(c => c.kind === 'risk' && c.text.includes('missing_late_target')), true)

  // 1d. Legitimate resolutions: (i) same node replanned to succeeded, and (ii) explicit later same-scope replacement under accepted Team.
  const validResolutions = distillTaskMemories({
    taskId: 'task-valid-res',
    rootNodeId: 'root-4',
    goal: 'Deliver verified src fix',
    status: 'succeeded',
    check: { path: 'src/app.ts', contains: 'v = 2' },
    verification: { passed: true, verdict: 'verified', evidence: 'workspace_file_contains_expected_text' },
    nodes: [
      {
        id: 'replanned-node',
        parentNodeId: 'root-4',
        role: 'worker',
        goal: 'Verify config schema',
        status: 'succeeded',
        dependencies: [],
        scopePath: 'src',
        replans: 1,
        verification: { passed: true, verdict: 'verified', evidence: 'workspace_text_file_exists' },
      },
      {
        id: 'team-fix',
        parentNodeId: 'root-4',
        role: 'team',
        teamKey: 'fixer',
        goal: 'Fix app.ts',
        status: 'succeeded',
        dependencies: [],
        scopePath: 'src',
        check: { path: 'src/app.ts', contains: 'v = 2' },
        verification: { passed: true, verdict: 'verified', evidence: 'workspace_file_contains_expected_text' },
      },
      {
        id: 'attempt-1-fail',
        parentNodeId: 'team-fix',
        role: 'worker',
        goal: 'Initial patch',
        status: 'failed',
        dependencies: [],
        scopePath: 'src',
        result: { resultStatus: 'failed', summary: 'Bad syntax', artifactRefs: [], evidenceRefs: [], remainingRisks: ['bad_syntax'] },
        verification: { passed: false, verdict: 'failed', evidence: 'syntax_error' },
      },
      {
        id: 'attempt-2-ok',
        parentNodeId: 'team-fix',
        role: 'worker',
        goal: 'Replacement patch',
        status: 'succeeded',
        dependencies: [],
        scopePath: 'src',
        result: { resultStatus: 'succeeded', summary: 'Clean patch', artifactRefs: ['src/app.ts'], evidenceRefs: ['op-fix'], remainingRisks: [] },
      },
    ],
    operations: [
      { id: 'op-fix', tool: 'edit_text_file', effect: 'write', status: 'succeeded', target: 'src/app.ts', taskNodeId: 'attempt-2-ok' },
    ],
  })
  const replanExp = validResolutions.find(c => c.kind === 'experience' && c.key?.startsWith('replan:'))
  const resolvedExp = validResolutions.find(c => c.kind === 'experience' && c.key?.startsWith('resolved:'))
  assert.ok(replanExp)
  assert.deepEqual(replanExp.paths, ['src'])
  assert.ok(resolvedExp)
  assert.match(resolvedExp.text, /via replacement worker/)
  assert.deepEqual(resolvedExp.sourceRefs, ['attempt-1-fail', 'attempt-2-ok'])
  assert.deepEqual(resolvedExp.paths, ['src'])
  assert.equal(validResolutions.some(c => c.kind === 'risk' && c.text.includes('bad_syntax')), false)
})

test('Problem 2: all 7 MemoryKinds populate normalized paths, pass scoped recall/tools, and render in playbookSummary & MEMORY.md', async (t) => {
  const { root, cwd } = await createFixture(t)
  const memoriesDir = join(root, 'memories')
  const store = new LocalStore(':memory:')
  t.after(() => store.close())

  // Use Windows-style backslash in scopePath ('src\\core') + check.path ('src/core/api.ts') to verify path normalization.
  const candidates = distillTaskMemories({
    taskId: 'task-7kinds',
    rootNodeId: 'root-7',
    goal: 'Build src/core API contract',
    project: 'audit-pkg',
    status: 'succeeded',
    route: routePrimary,
    check: { path: 'src/core/api.ts', contains: 'export' },
    verification: { passed: true, verdict: 'verified', evidence: 'workspace_file_contains_expected_text' },
    nodes: [
      {
        id: 'team-core',
        parentNodeId: 'root-7',
        role: 'team',
        teamKey: 'core-api',
        goal: 'Own src/core',
        status: 'succeeded',
        dependencies: [],
        scopePath: 'src\\core',
        check: { path: 'src/core/api.ts', contains: 'export' },
        verification: { passed: true, verdict: 'verified', evidence: 'workspace_file_contains_expected_text' },
        result: { resultStatus: 'succeeded', summary: 'Delivered API', artifactRefs: ['src/core/api.ts'], evidenceRefs: ['op-api'], remainingRisks: ['rate_limit_tuning'] },
      },
      {
        id: 'w-fail',
        parentNodeId: 'team-core',
        role: 'worker',
        goal: 'First draft',
        status: 'failed',
        dependencies: [],
        scopePath: 'src\\core',
        result: { resultStatus: 'failed', summary: 'Failed draft', artifactRefs: [], evidenceRefs: [], remainingRisks: ['draft_err'] },
        verification: { passed: false, verdict: 'failed', evidence: 'draft_failed' },
      },
      {
        id: 'w-ok',
        parentNodeId: 'team-core',
        role: 'worker',
        goal: 'Second draft',
        status: 'succeeded',
        dependencies: [],
        scopePath: 'src\\core',
        route: routeAlt,
        result: { resultStatus: 'succeeded', summary: 'Implemented api.ts', artifactRefs: ['src/core/api.ts'], evidenceRefs: ['op-api'], remainingRisks: [] },
        verification: { passed: false, verdict: 'unverified', evidence: 'node_confirmed_tool_receipt' },
      },
    ],
    operations: [
      { id: 'op-api', tool: 'create_text_file', effect: 'write', status: 'succeeded', target: 'src/core/api.ts', taskNodeId: 'w-ok' },
    ],
  })

  const distilledKinds = new Set(candidates.map(c => c.kind))
  assert.deepEqual([...distilledKinds].sort(), [...memoryKinds].sort())
  for (const candidate of candidates) {
    assert.ok(candidate.paths && candidate.paths.length > 0, `Expected paths on ${candidate.kind} (${candidate.key})`)
    assert.equal(memoryEntryInScope(candidate, 'src/core'), true, `${candidate.kind} (${candidate.key}) should be in scope 'src/core'`)
    assert.equal(memoryEntryInScope(candidate, 'ui'), false, `${candidate.kind} (${candidate.key}) must NOT leak to 'ui'`)
  }

  const memory = new LocalMemory(store, { memoriesDir })
  const judgment = new LocalJudgment(store)
  const scope = workspaceMemoryScope(cwd)
  const ev: EventDraft = { taskId: 'task-7kinds', taskRunId: 'run-7', agentRunId: 'agent-7', type: '', payload: {} }
  memory.capture(ev, scope, candidates)

  const stored = memory.list(scope)
  assert.deepEqual(new Set(stored.map(e => e.kind)), new Set(memoryKinds))

  // Verify MEMORY.md and memory_summary.md materialize all structured kinds
  const [scopeDir] = await readdir(memoriesDir)
  assert.ok(scopeDir)
  const fullMd = await readFile(join(memoriesDir, scopeDir, 'MEMORY.md'), 'utf8')
  const summaryMd = await readFile(join(memoriesDir, scopeDir, 'memory_summary.md'), 'utf8')
  assert.match(fullMd, /## Durable Experiences & Key Notes/)
  assert.match(fullMd, /## Decisions & Contracts/)
  assert.match(fullMd, /## Failure Patterns, Risks & Assumptions/)
  assert.match(fullMd, /## Workspace Facts/)
  for (const kind of memoryKinds) {
    assert.ok(fullMd.includes(`[${kind}`), `MEMORY.md missing kind ${kind}`)
    assert.ok(summaryMd.includes(`[${kind}`), `memory_summary.md missing kind ${kind}`)
  }

  // Verify playbookSummary includes non-fact/experience structured kinds when filtered or queried
  const structuredOnlySummary = memory.playbookSummary(
    [scope],
    2000,
    entry => entry.kind !== 'fact' && entry.kind !== 'experience',
  )
  for (const kind of ['decision', 'contract', 'failure_pattern', 'risk', 'assumption'] as const) {
    assert.ok(structuredOnlySummary.includes(`[${kind}]`), `playbookSummary missing [${kind}]`)
  }

  // Verify ScopedContext recalls scoped structured memories for a Worker in 'src/core'
  const context = new ScopedContext(memory, judgment)
  const workerPrompt = await context.build(ev, {
    scope,
    includePlaybook: true,
    goal: 'Check core-api contract decision failure risk assumption in api.ts',
    filter: entry => memoryEntryInScope(entry, 'src/core'),
  })
  assert.match(workerPrompt, /Workspace memory summary/)
  assert.match(workerPrompt, /team:core-api/)

  // Verify memory_search & memory_list support all 7 kinds and return confidence, teamKey, sourceRole
  const ws = new CodingWorkspace(cwd)
  const tools = createMemoryTools(ws, () => ({
    memory,
    judgment,
    scopesFor: () => ({ primary: scope, all: [scope], goal: 'inspect', event: ev }),
  }))
  const searchTool = tools.find(tool => tool.name === 'memory_search')!
  const listTool = tools.find(tool => tool.name === 'memory_list')!

  for (const kind of memoryKinds) {
    const listed = await listTool.execute(`list-${kind}`, { kind, limit: 20 }, undefined, {
      taskId: 'task-7kinds', agentRunId: 'agent-7', scopePath: 'src/core', defer() {}, onCleanup() {},
    }) as { ok: boolean; count: number; entries: Array<Record<string, unknown>> }
    assert.equal(listed.ok, true)
    assert.ok(listed.count >= 1, `memory_list should return scoped entries for kind=${kind}`)
    assert.ok(listed.entries.every(row => row.kind === kind))
  }

  const contractRow = ((await searchTool.execute('search-contract', {
    query: 'Deliverable contract api.ts',
    kind: 'contract',
  }, undefined, {
    taskId: 'task-7kinds', agentRunId: 'agent-7', scopePath: 'src/core', defer() {}, onCleanup() {},
  })) as { ok: boolean; entries: Array<Record<string, unknown>> }).entries[0]
  assert.ok(contractRow)
  assert.equal(contractRow.kind, 'contract')
  assert.equal(contractRow.confidence, 'verified')
  assert.equal(contractRow.teamKey, 'core-api')
  assert.equal(contractRow.sourceRole, 'team')

  const invalidKind = await searchTool.execute('bad-kind', { query: 'api', kind: 'unknown_kind' }) as { ok: boolean }
  assert.equal(invalidKind.ok, false)
})

test('Problem 2 (Host): teamMemoryScope read/write/delete consistency, nodesByParent teamKey lookup, and archived node route/check recovery', { timeout: 25_000 }, async (t) => {
  const { cwd, directory } = await createFixture(t)
  let phase: 'team_write' | 'team_recall' | 'archive_64' = 'team_write'
  let backendListedInTurn2: Array<Record<string, unknown>> = []
  let nestedWorkerListedInTurn2: Array<Record<string, unknown>> = []
  let frontendLeakedBackend = false
  let backendTurn2Prompt = ''

  const execution = new ScriptedExecution(async (config, call, prompt) => {
    if (phase === 'team_write') {
      if (config.role === 'root') {
        const res = await call('propose_task_plan', {
          nodes: [
            {
              ref: 'be',
              role: 'team',
              teamKey: 'backend',
              goal: 'Update src/app.ts and record team note',
              access: 'write',
              scopePath: 'src',
              tools: ['edit_text_file', 'memory_save', 'memory_list'],
              check: { path: 'src/app.ts', contains: 'v = 2' },
            },
            {
              ref: 'fe',
              role: 'team',
              teamKey: 'frontend',
              goal: 'Inspect ui/view.tsx and check memory isolation',
              access: 'read',
              scopePath: 'ui',
              tools: ['read_text_file', 'memory_list'],
              dependencies: ['be'],
            },
          ],
        })
        assert.equal(res.ok, true)
        return 'Completed two-team turn 1'
      }
      if (config.role === 'team' && prompt.includes('src/app.ts')) {
        const edited = await call('edit_text_file', { path: 'src/app.ts', oldText: 'v = 1', newText: 'v = 2' })
        assert.equal(edited.ok, true)
        const saved = await call('memory_save', {
          kind: 'experience',
          key: 'be-team-note',
          text: 'Backend team keeps schema validators in src/app.ts',
          paths: ['src/app.ts'],
        })
        assert.equal(saved.ok, true)
        assert.equal(saved.saved, true)
        return 'Backend team updated src/app.ts'
      }
      if (config.role === 'team' && prompt.includes('ui/view.tsx')) {
        await call('read_text_file', { path: 'ui/view.tsx' })
        const feList = await call('memory_list', { limit: 20 })
        assert.equal(feList.ok, true)
        const entries = (feList.entries as Array<{ teamKey?: string }>) ?? []
        frontendLeakedBackend = entries.some(item => item.teamKey === 'backend')
        return 'Frontend team checked isolation'
      }
    }

    if (phase === 'team_recall') {
      if (config.role === 'root') {
        const res = await call('propose_task_plan', {
          nodes: [{
            ref: 'be2',
            role: 'team',
            teamKey: 'backend',
            goal: 'Check src/app.ts contract and validator experience',
            access: 'read',
            scopePath: 'src',
            tools: ['read_text_file', 'memory_list'],
          }],
        })
        assert.equal(res.ok, true)
        return 'Completed team recall turn 2'
      }
      if (config.role === 'team') {
        backendTurn2Prompt = prompt
        const listed = await call('memory_list', { limit: 30 })
        assert.equal(listed.ok, true)
        backendListedInTurn2 = (listed.entries as Array<Record<string, unknown>>) ?? []
        const child = await call('delegate_worker', {
          goal: 'Nested worker inspect backend team memory',
          access: 'read',
          scopePath: 'src',
          tools: ['read_text_file', 'memory_list'],
        })
        assert.equal(child.ok, true)
        return 'Backend recalled team memories'
      }
      // Nested worker under backend team
      await call('read_text_file', { path: 'src/app.ts' })
      const childList = await call('memory_list', { limit: 30 })
      assert.equal(childList.ok, true)
      nestedWorkerListedInTurn2 = (childList.entries as Array<Record<string, unknown>>) ?? []
      return 'Nested worker verified team memory access'
    }

    // phase === 'archive_64': 64 nodes trigger mid-run archiving (threshold = 64) before #captureMemory runs!
    if (config.role === 'root') {
      const nodes = Array.from({ length: 64 }, (_, idx) => idx === 0
        ? {
          ref: 'n_0',
          goal: 'Cross-provider checked node 0',
          scopePath: 'src',
          tools: ['read_text_file'],
          route: routeAlt,
          check: { path: 'src/mod.ts', contains: 'ok' },
        }
        : {
          ref: `n_${idx}`,
          goal: `Fast reader node ${idx}`,
          scopePath: 'src',
          tools: ['read_text_file'],
        })
      const planned = await call('propose_task_plan', { nodes })
      assert.equal(planned.ok, true)
      return 'Completed 64-node archived run'
    }
    await call('read_text_file', { path: 'src/mod.ts' })
    return 'Read src/mod.ts'
  })

  const host = new LocalAgentHost({ directory, execution, defaultRoute: routePrimary })
  try {
    const conv = host.createConversation({ requestId: 'conv-team-mem', workspace: cwd, workspaceAccess: 'write' })
    const t1 = await host.sendMessage({ conversationId: conv.id, requestId: 'msg-t1', text: 'Run two teams' })
    await host.idle()
    assert.deepEqual(execution.errors, [])
    assert.equal(host.getTask(t1.taskId).status, 'succeeded')
    assert.equal(frontendLeakedBackend, false)

    // Recall in Turn 2: both Team ScopedContext and nested Worker memory_list read teamMemoryScope('backend')
    phase = 'team_recall'
    const t2 = await host.sendMessage({ conversationId: conv.id, requestId: 'msg-t2', text: 'Recall backend team memories' })
    await host.idle()
    assert.deepEqual(execution.errors, [])
    assert.equal(host.getTask(t2.taskId).status, 'succeeded')
    assert.ok(backendTurn2Prompt.includes('team:backend') || backendTurn2Prompt.includes('src/app.ts'))
    assert.ok(backendListedInTurn2.some(item => item.kind === 'decision' && item.teamKey === 'backend'))
    assert.ok(backendListedInTurn2.some(item => item.kind === 'contract' && item.teamKey === 'backend'))
    assert.ok(backendListedInTurn2.some(item => item.kind === 'experience' && item.teamKey === 'backend' && item.sourceRole === 'team'))
    assert.ok(nestedWorkerListedInTurn2.some(item => item.kind === 'decision' && item.teamKey === 'backend'))

    // Simulate pre-existing SQLite v3 state where 'conversation-memory-teams' & 'workspace-memory-teams' caches are absent,
    // proving #conversationMemoryScopes discovers teamKey via TaskEngine.nodesByParent(taskId, rootNodeId)!
    await host.close()
    const rawDb = new DatabaseSync(join(directory, 'tasks.sqlite'))
    rawDb.prepare(`DELETE FROM records WHERE namespace IN ('conversation-memory-teams', 'workspace-memory-teams')`).run()
    rawDb.close()
  } finally {
    await host.close()
  }

  const reopened = new LocalAgentHost({ directory, execution, defaultRoute: routePrimary })
  try {
    const [conv] = reopened.listConversations()
    assert.ok(conv)
    const snap = await reopened.managementSnapshot(conv.id)
    const entries = snap.memory?.entries ?? []
    assert.ok(entries.some(e => e.kind === 'decision' && e.teamKey === 'backend'))
    assert.ok(entries.some(e => e.kind === 'contract' && e.teamKey === 'backend'))
    assert.ok(entries.some(e => e.kind === 'experience' && e.teamKey === 'backend'))

    // Delete all listed memories -> teamMemoryScope + workspaceMemoryScope are 100% consistent!
    const removed = await reopened.managementCommand({
      schemaVersion: 1,
      type: 'deleteConversationMemory',
      conversationId: conv.id,
      ids: entries.map(e => e.id),
    }) as number
    assert.equal(removed, entries.length)
    assert.equal((await reopened.managementSnapshot(conv.id)).memory?.entries.length, 0)

    // Verify #captureMemory restores stripped route & check on archived nodes via getNodeDetail(task.id, node.id)
    phase = 'archive_64'
    const t3 = await reopened.sendMessage({ conversationId: conv.id, requestId: 'msg-archive-64', text: 'Run 64 nodes to archive' })
    await reopened.idle()
    assert.deepEqual(execution.errors, [])
    const archivedTask = reopened.getTask(t3.taskId)
    assert.equal(archivedTask.status, 'succeeded')
    const slimNode0 = archivedTask.nodes?.[0]
    assert.ok(slimNode0?.archivedAt, 'Expected node 0 to be archived before task completion')
    assert.equal(slimNode0?.route, undefined, 'Archived slim node strips route in task-nodes')
    assert.equal(slimNode0?.check, undefined, 'Archived slim node strips check in task-nodes')

    const postArchiveSnap = await reopened.managementSnapshot(conv.id)
    const capturedAfterArchive = postArchiveSnap.memory?.entries ?? []
    assert.ok(
      capturedAfterArchive.some(e => e.kind === 'decision' && e.text.includes('anthropic/claude-coder')),
      'Expected cross-provider route decision recovered from archived node detail',
    )
    assert.ok(
      capturedAfterArchive.some(e => e.kind === 'contract' && e.text.includes('src/mod.ts')),
      'Expected check contract recovered from archived node detail',
    )
    // Also verify teamMemoryScope helper matches Conversation scope shape
    assert.equal(
      teamMemoryScope(archivedTask, 'backend'),
      JSON.stringify([conv.id, 'team', 'backend']),
    )
  } finally {
    await reopened.close()
  }
})

test('Problem 3: memory_save links correlationId to memory.captured, marks catalog effect as memory, and never pollutes workspace writes', { timeout: 15_000 }, async (t) => {
  const { cwd, directory } = await createFixture(t)
  const explicitCallId = 'save-call-42'
  let childAttempts = 0

  const execution = new ScriptedExecution(async (config, call) => {
    if (config.role === 'root') {
      // 1. Propose a child node that calls memory_save and then fails, then replan_task_node it!
      //    If memory_save had WorkspaceTool.effect === 'write', replan_task_node would be blocked by task-engine.ts:1436!
      const plan = await call('propose_task_plan', {
        nodes: [{
          ref: 'mem_worker',
          goal: 'Save scoped observation then revise',
          access: 'write',
          scopePath: 'src',
          tools: ['read_text_file', 'memory_save'],
        }],
      })
      const firstNode = (plan.nodes as Array<{ nodeId: string; status: string }>)[0]!
      assert.equal(firstNode.status, 'failed')
      const replanned = await call('replan_task_node', {
        nodeId: firstNode.nodeId,
        goal: 'Finish read check cleanly after memory_save',
      })
      assert.equal(replanned.ok, true, 'memory_save must NOT lock out replan_task_node as a workspace file write')

      // 2. Root calls memory_save with a known callId without touching any workspace files.
      const saved = await call('memory_save', {
        kind: 'experience',
        key: 'root-audit-exp',
        title: 'Audit correlation test',
        text: 'Always correlate memory_save receipt with memory.captured event',
      }, explicitCallId)
      assert.equal(saved.ok, true)
      assert.equal(saved.saved, true)
      return 'Saved durable note without modifying workspace files'
    }

    childAttempts++
    if (childAttempts === 1) {
      const childSave = await call('memory_save', {
        kind: 'fact',
        key: 'worker-obs',
        text: 'src/app.ts exports constant v',
        paths: ['src/app.ts'],
      }, 'worker-save-1')
      assert.equal(childSave.ok, true)
      return '' // Empty summary forces Worker failure on attempt 1 so Root can test replan_task_node!
    }
    await call('read_text_file', { path: 'src/app.ts' })
    return 'Read src/app.ts on replanned attempt'
  })

  const host = new LocalAgentHost({
    directory,
    execution,
    defaultRoute: routePrimary,
    judgment: { modes: { 'memory.capture': 'shadow' } },
  })
  try {
    // Check Management tool catalog effect classification
    const conv = host.createConversation({ requestId: 'conv-audit', workspace: cwd, workspaceAccess: 'write' })
    const initialSnap = await host.managementSnapshot(conv.id)
    const saveCatalog = initialSnap.tools.find(tool => tool.name === 'memory_save')
    const searchCatalog = initialSnap.tools.find(tool => tool.name === 'memory_search')
    const listCatalog = initialSnap.tools.find(tool => tool.name === 'memory_list')
    const writeCatalog = initialSnap.tools.find(tool => tool.name === 'create_text_file')
    assert.equal(saveCatalog?.effect, 'memory')
    assert.equal(searchCatalog?.effect, 'read')
    assert.equal(listCatalog?.effect, 'read')
    assert.equal(writeCatalog?.effect, 'write')

    // Concurrent workspace read lease must NOT block memory_save's underlying WorkspaceTool effect ('read')
    const ws = new CodingWorkspace(cwd)
    const readLease = await ws.acquireLease('read', { ownerId: 'reader-1' })
    try {
      const secondReadLease = await ws.acquireLease('read', { ownerId: 'memory-save-holder', signal: AbortSignal.timeout(200) })
      secondReadLease.release()
    } finally {
      readLease.release()
    }

    const { taskId } = await host.sendMessage({ conversationId: conv.id, requestId: 'msg-audit', text: 'Run memory_save audit check' })
    await host.idle()
    assert.deepEqual(execution.errors, [])

    const task = host.getTask(taskId)
    assert.equal(task.status, 'succeeded')
    // Must NOT forge 'confirmed_workspace_operation' when no file/shell write occurred!
    assert.notEqual(task.verification?.evidence, 'confirmed_workspace_operation')
    assert.equal(task.verification?.evidence, 'assistant_response_present')

    const history = host.getHistory(taskId)
    const rootSaveOp = history.operations.find(op => op.tool === 'memory_save' && op.id.endsWith(`:${explicitCallId}`))
    assert.ok(rootSaveOp, 'Expected Operation receipt for Root memory_save')
    assert.equal(rootSaveOp.effect, 'read')
    assert.equal(rootSaveOp.status, 'succeeded')

    // Causal correlationId check: Operation.id === memory.captured.correlationId === judgment.evaluated.correlationId
    const events = host.events(taskId)
    const capturedEvent = events.find(ev => ev.type === 'memory.captured' && ev.correlationId === rootSaveOp.id)
    assert.ok(capturedEvent, 'Expected memory.captured event correlated with memory_save Operation.id')
    const judgedEvent = events.find(ev =>
      ev.type === 'judgment.evaluated' && ev.payload.id === 'memory.capture' && ev.correlationId === rootSaveOp.id)
    assert.ok(judgedEvent, 'Expected memory.capture judgment event correlated with memory_save Operation.id')

    // Telemetry digest projection preserves exact correlation match with tool.started / tool.finished payload.id
    const projectedStarted = events
      .filter(ev => ev.type === 'tool.started' && ev.payload.id === rootSaveOp.id)
      .map(telemetryEvent)[0]
    const projectedCaptured = telemetryEvent(capturedEvent)
    assert.ok(projectedStarted)
    assert.equal(projectedCaptured.correlationId, projectedStarted.payload.id)

    // distillTaskMemories must NOT re-distill memory_save as a 'Confirmed workspace operation memory_save ...' fact
    const afterSnap = await host.managementSnapshot(conv.id)
    const entries = afterSnap.memory?.entries ?? []
    assert.equal(entries.some(e => e.text.includes('Confirmed workspace operation memory_save')), false)
    assert.equal(entries.some(e => e.text.includes('Always correlate memory_save receipt')), true)
  } finally {
    await host.close()
  }
})
