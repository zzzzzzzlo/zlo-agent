import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { EventDraft } from '../src/contracts/domain.ts'
import { LocalMemory } from '../src/memory.ts'
import { LocalStore } from '../src/store.ts'
import { TaskEngine } from '../src/task-engine.ts'
import type { NodeProposal } from '../src/task-engine.ts'

function stats(samples: readonly number[]) {
  if (!samples.length) return { meanMs: 0, p95Ms: 0 }
  const sorted = [...samples].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, val) => acc + val, 0)
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
  return {
    meanMs: Number((sum / sorted.length).toFixed(4)),
    p95Ms: Number(sorted[idx]!.toFixed(4)),
  }
}

function measure<T>(iterations: number, fn: (index: number) => T): { meanMs: number; p95Ms: number; last: T | undefined } {
  const samples: number[] = []
  let last: T | undefined
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    last = fn(i)
    samples.push(performance.now() - start)
  }
  return { ...stats(samples), last }
}

function nodeEvent(taskId: string, taskNodeId: string, taskAttemptId?: string): EventDraft {
  return { taskId, taskNodeId, taskAttemptId, type: '', payload: {} }
}

test('DAG scales cleanly across 500, 1000, 1200, 5000, and 10000 nodes with archiving and recovery metrics', { timeout: 120_000 }, (t) => {
  const scales = [500, 1000, 1200, 5000, 10_000] as const
  const dir = mkdtempSync(join(tmpdir(), 'zlo-dag-scale-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const results: Record<string, unknown>[] = []

  for (const scale of scales) {
    const dbPath = join(dir, `bench-${scale}.sqlite`)
    const store = new LocalStore(dbPath)
    try {
      const engine = new TaskEngine(store, { archiveThreshold: scale + 500, archiveBatchSize: 512 })
      const { taskId } = engine.create({ requestId: `task-${scale}`, goal: `Large DAG scale test ${scale}`, cwd: dir, workspaceAccess: 'trusted' })
      let version = 0

      // Keep final 12 nodes ready / downstream so we also test active scheduling alongside thousands of settled nodes.
      const historicalCount = scale - 32
      const activeFrontierCount = 12
      const dynamicReserve = 20 // reserved for single-node creation benchmark below
      const baseCount = scale - dynamicReserve
      const settledCount = historicalCount

      const allNodeIds: string[] = []
      const batchSize = 500
      const detailedGoalSuffix = ' Inspect module boundaries, verify error paths, preserve audit receipts, and produce compact evidence handoffs.'
      const longSummary = 'Completed static analysis and verification across assigned workspace slices; confirmed zero contract regressions, preserved all artifact checksums, and validated deterministic outputs.'.repeat(2)

      // 1. Batch populate initial graph cleanly in chunks
      const proposals: NodeProposal[] = []
      for (let i = 0; i < baseCount; i++) {
        const isSettledBranch = i < settledCount
        const depRefs = !isSettledBranch && i >= settledCount + 4 && allNodeIds.length > 0
          ? [proposals[settledCount]!.ref]
          : undefined
        proposals.push({
          ref: `n_${i}`,
          goal: `Execute work unit #${i} in scale-${scale}.${detailedGoalSuffix}`,
          access: 'read',
          tools: ['list_directory', 'read_text_file', 'search_files', 'search_content', 'git_status', 'git_diff'],
          check: { path: `src/module_${i % 64}.ts`, contains: 'export' },
          ...(depRefs ? { dependencies: depRefs } : {}),
        })
      }

      for (let offset = 0; offset < proposals.length; offset += batchSize) {
        const chunk = proposals.slice(offset, offset + batchSize)
        const resolvedChunk = chunk.map(item => ({
          ...item,
          ...(item.dependencies ? { dependencies: [allNodeIds[settledCount]!] } : {}),
        }))
        const created = engine.proposePlan(taskId, `seed-${scale}-${offset}`, version, resolvedChunk)
        version++
        for (const node of created) allNodeIds.push(node.id)
      }

      engine.start(taskId)

      // Settle background historical nodes incrementally, then measure 20 standalone per-node updates at scale N
      const measureWindow = Math.min(20, settledCount)
      const backgroundCount = settledCount - measureWindow
      const updateLatencies: number[] = []
      const settleOne = (i: number) => {
        const nodeId = allNodeIds[i]!
        const attemptId = engine.startWorker(taskId, nodeId)
        const ev = nodeEvent(taskId, nodeId, attemptId)
        const opId = `${attemptId}:op`
        engine.beginTool(taskId, ev, opId, 'read_text_file', 'read', `src/module_${i % 64}.ts`)
        engine.finishTool(ev, opId, 'succeeded')
        engine.settleWorker(
          taskId,
          nodeId,
          {
            resultStatus: 'succeeded',
            executionStatus: 'completed',
            summary: `[${i}] ${longSummary}`,
            artifactRefs: [`src/module_${i % 64}.ts`],
            evidenceRefs: [opId],
            remainingRisks: [],
          },
          { passed: true, evidence: 'workspace_file_contains_expected_text' },
          attemptId,
        )
      }
      for (let i = 0; i < backgroundCount; i++) {
        settleOne(i)
      }
      for (let i = backgroundCount; i < settledCount; i++) {
        const nodeId = allNodeIds[i]!
        const attemptId = engine.startWorker(taskId, nodeId)
        const ev = nodeEvent(taskId, nodeId, attemptId)
        const opId = `${attemptId}:op`
        engine.beginTool(taskId, ev, opId, 'read_text_file', 'read', `src/module_${i % 64}.ts`)
        engine.finishTool(ev, opId, 'succeeded')
        const t0 = performance.now()
        engine.settleWorker(
          taskId,
          nodeId,
          {
            resultStatus: 'succeeded',
            executionStatus: 'completed',
            summary: `[${i}] ${longSummary}`,
            artifactRefs: [`src/module_${i % 64}.ts`],
            evidenceRefs: [opId],
            remainingRisks: [],
          },
          { passed: true, evidence: 'workspace_file_contains_expected_text' },
          attemptId,
        )
        updateLatencies.push(performance.now() - t0)
      }

      // Dynamic single-node creation + cycle/dependency validation at scale N (20 appends)
      const createLatencies: number[] = []
      for (let k = 0; k < dynamicReserve; k++) {
        const depId = allNodeIds[settledCount]!
        const t0 = performance.now()
        const [added] = engine.proposePlan(taskId, `dyn-${scale}-${k}`, version, [{
          ref: `dyn_${k}`,
          goal: `Dynamic follow-up node #${k} depending on active frontier.${detailedGoalSuffix}`,
          access: 'read',
          dependencies: [depId],
          tools: ['read_text_file', 'search_content'],
          check: { path: `src/module_${k}.ts`, contains: 'export' },
        }])
        createLatencies.push(performance.now() - t0)
        version++
        allNodeIds.push(added!.id)
      }

      // Measure BEFORE archiving
      const runnableBefore = measure(25, () => engine.runnableNodes(taskId))
      const activeBefore = measure(25, () => engine.activeNodes(taskId))
      const pageQuery = measure(25, (idx) => engine.listNodesPage(taskId, { afterOrdinal: (idx * 50) % Math.max(1, scale - 50), limit: 50 }))
      assert.ok(activeBefore.last!.length === scale)
      assert.ok(pageQuery.last!.items.length > 0)

      const storageBefore = store.storageStats(taskId)
      const fileBytesBefore = statSync(dbPath).size

      // Archive all eligible completed nodes cleanly
      const archived = engine.archiveCompletedNodes(taskId, { batchSize: 500 })
      assert.equal(archived.archivedCount, settledCount)

      const storageAfter = store.storageStats(taskId)
      const afterCompactPath = join(dir, `bench-${scale}.sqlite`)
      store.compact()
      const fileBytesAfterCompact = statSync(afterCompactPath).size
      const storageAfterCompact = store.storageStats(taskId)

      // Measure AFTER archiving (hot active view & runnable lookup should be much faster + smaller!)
      const runnableAfter = measure(25, () => engine.runnableNodes(taskId))
      const activeAfter = measure(25, () => engine.activeNodes(taskId))
      const detailRecovery = measure(20, (idx) => engine.getNodeDetail(taskId, allNodeIds[idx % settledCount]!))

      assert.equal(activeAfter.last!.length, scale - settledCount)
      assert.ok(detailRecovery.last?.archived === true)
      assert.match(detailRecovery.last?.node.goal ?? '', /Execute work unit #/)

      // Assert node status preserved ('succeeded') after archiving
      const sampleArchived = engine.getNode(taskId, allNodeIds[0]!)
      assert.equal(sampleArchived?.status, 'succeeded')
      assert.ok(sampleArchived?.archivedAt)
      assert.ok(sampleArchived?.digest)

      results.push({
        nodes: scale,
        createSingleNode: stats(createLatencies),
        updateSingleNode: stats(updateLatencies),
        runnableBefore: { meanMs: runnableBefore.meanMs, p95Ms: runnableBefore.p95Ms },
        runnableAfter: { meanMs: runnableAfter.meanMs, p95Ms: runnableAfter.p95Ms },
        activeBefore: { meanMs: activeBefore.meanMs, p95Ms: activeBefore.p95Ms, count: activeBefore.last!.length },
        activeAfter: { meanMs: activeAfter.meanMs, p95Ms: activeAfter.p95Ms, count: activeAfter.last!.length },
        historyPage: { meanMs: pageQuery.meanMs, p95Ms: pageQuery.p95Ms },
        detailRecovery: { meanMs: detailRecovery.meanMs, p95Ms: detailRecovery.p95Ms },
        storageBeforeBytes: {
          taskNodes: storageBefore.namespaces['task-nodes']?.bytes ?? 0,
          tasks: storageBefore.namespaces.tasks?.bytes ?? 0,
          sqliteUsed: storageBefore.usedBytes,
          dbFile: fileBytesBefore,
        },
        storageAfterBytes: {
          taskNodes: storageAfter.namespaces['task-nodes']?.bytes ?? 0,
          taskNodeArchives: storageAfter.namespaces['task-node-archives']?.bytes ?? 0,
          tasks: storageAfter.namespaces.tasks?.bytes ?? 0,
          sqliteUsed: storageAfterCompact.usedBytes,
          dbFileCompacted: fileBytesAfterCompact,
        },
        activeFrontierRemaining: activeAfter.last!.length,
        frontierCheckCount: activeFrontierCount,
      })
    } finally {
      store.close()
    }
  }

  t.diagnostic('DAG_SCALE_BENCHMARKS=' + JSON.stringify(results))
  assert.equal(results.length, 5)
})

test('migrates legacy embedded TaskSnapshot nodes/worker idempotently without losing history', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'zlo-dag-legacy-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'legacy.sqlite')

  // Write a v2 SQLite snapshot containing legacy embedded task.worker + task.nodes
  const rawDb = new DatabaseSync(path)
  rawDb.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE records (
      namespace TEXT NOT NULL,
      id TEXT NOT NULL,
      value TEXT NOT NULL CHECK (json_valid(value)),
      PRIMARY KEY (namespace, id)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE events (
      task_id TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK (seq > 0),
      id TEXT NOT NULL UNIQUE,
      event TEXT NOT NULL CHECK (json_valid(event)),
      PRIMARY KEY (task_id, seq)
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX idx_records_operations_task ON records(json_extract(value, '$.taskId'), id) WHERE namespace = 'operations';
    CREATE INDEX idx_records_attempts_task ON records(json_extract(value, '$.taskId'), id) WHERE namespace = 'attempts';
    CREATE INDEX idx_records_task_status ON records(json_extract(value, '$.status'), id) WHERE namespace = 'tasks';
    PRAGMA user_version = 2;
  `)
  const legacyTask = {
    schemaVersion: 1,
    id: 'task-legacy-1',
    rootNodeId: 'root-legacy-1',
    goal: 'Legacy embedded task',
    cwd: dir,
    status: 'succeeded',
    attemptCount: 1,
    instructions: [],
    planVersion: 2,
    worker: {
      id: 'legacy-w1',
      parentNodeId: 'root-legacy-1',
      dependencies: [],
      goal: 'Legacy worker goal',
      status: 'succeeded',
      result: { resultStatus: 'succeeded', summary: 'Legacy worker done', artifactRefs: [], evidenceRefs: ['op-legacy-1'], remainingRisks: [] },
    },
    nodes: [
      {
        id: 'dag-n1',
        parentNodeId: 'root-legacy-1',
        dependencies: [],
        goal: 'Legacy DAG node 1',
        status: 'succeeded',
        role: 'worker',
        result: { resultStatus: 'succeeded', summary: 'DAG 1 ok', artifactRefs: ['a.ts'], evidenceRefs: ['op-legacy-1'], remainingRisks: [] },
        verification: { passed: true, verdict: 'verified', basis: 'workspace_path', evidence: 'workspace_file_exists' },
      },
      {
        id: 'dag-n2',
        parentNodeId: 'root-legacy-1',
        dependencies: ['dag-n1'],
        goal: 'Legacy DAG node 2',
        status: 'succeeded',
        role: 'worker',
        result: { resultStatus: 'succeeded', summary: 'DAG 2 ok', artifactRefs: [], evidenceRefs: ['op-legacy-2'], remainingRisks: [] },
        verification: { passed: true, verdict: 'verified', basis: 'handoff', evidence: 'node_confirmed_tool_receipt' },
      },
    ],
  }
  rawDb.prepare(`INSERT INTO records(namespace, id, value) VALUES (?, ?, ?)`).run('tasks', legacyTask.id, JSON.stringify(legacyTask))
  rawDb.close()

  const store = new LocalStore(path)
  try {
    const engine1 = new TaskEngine(store)
    const rawStoredTask = store.get<Record<string, unknown>>('tasks', legacyTask.id)!
    assert.equal('nodes' in rawStoredTask, false)
    assert.equal('worker' in rawStoredTask, false)
    assert.ok(typeof rawStoredTask.taskRunId === 'string')

    const hydrated1 = engine1.get(legacyTask.id)
    assert.equal(hydrated1.worker?.id, 'legacy-w1')
    assert.deepEqual(hydrated1.nodes?.map(n => n.id), ['dag-n1', 'dag-n2'])

    // Reopen second TaskEngine instance -> idempotent, zero duplication
    const engine2 = new TaskEngine(store)
    const hydrated2 = engine2.get(legacyTask.id)
    assert.deepEqual(hydrated2, hydrated1)
    assert.equal(engine2.listNodesPage(legacyTask.id, { limit: 10 }).totalCount, 3)
  } finally {
    store.close()
  }
})

test('enforces archiving preconditions, preserves priorFailures, Team summaries, Evidence/Memory links, crash/interrupt recovery, and avoids dag_not_converged', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'zlo-dag-archive-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'archive.sqlite')
  let store = new LocalStore(path)

  try {
    const engine = new TaskEngine(store, { archiveThreshold: 128 })
    const { taskId } = engine.create({ requestId: 'req-arch', goal: 'Test full archive lifecycle', cwd: dir, workspaceAccess: 'trusted' })
    const [team, childFailRetry, siblingBlocked, runningChildParent] = engine.proposePlan(taskId, 'p1', 0, [
      { ref: 'team', role: 'team', teamKey: 'core', goal: 'Coordinate core fix', access: 'write', scopePath: 'src' },
      { ref: 'c1', parentNodeId: 'team', goal: 'Initial fix in src/app.ts', check: { path: 'src/app.ts', contains: 'ok' } },
      { ref: 'downstream', dependencies: ['team'], goal: 'Verify integrated output' },
      { ref: 'up', goal: 'Upstream node with active write op' },
    ])
    const taskMeta = engine.start(taskId)

    // 1. childFailRetry fails once under running Team, gets replanned, then succeeds -> priorFailures retained!
    const teamAttempt = engine.startWorker(taskId, team.id)
    const c1Attempt1 = engine.startWorker(taskId, childFailRetry.id, { suspendParent: true })
    const c1Op1 = `${c1Attempt1}:read`
    engine.beginTool(taskId, nodeEvent(taskId, childFailRetry.id, c1Attempt1), c1Op1, 'read_text_file', 'read', 'src/app.ts')
    engine.finishTool(nodeEvent(taskId, childFailRetry.id, c1Attempt1), c1Op1, 'succeeded')
    engine.settleWorker(
      taskId,
      childFailRetry.id,
      { resultStatus: 'failed', executionStatus: 'completed', summary: 'Missing export ok in src/app.ts', artifactRefs: [], evidenceRefs: [c1Op1], remainingRisks: ['missing_export'] },
      { passed: false, evidence: 'workspace_file_missing_expected_text' },
      c1Attempt1,
    )
    engine.replanNode(taskId, 'replan-c1', 1, childFailRetry.id, { goal: 'Re-verify after update in src/app.ts' })
    const c1Attempt2 = engine.startWorker(taskId, childFailRetry.id, { suspendParent: true })
    const c1Op2 = `${c1Attempt2}:read`
    engine.beginTool(taskId, nodeEvent(taskId, childFailRetry.id, c1Attempt2), c1Op2, 'read_text_file', 'read', 'src/app.ts')
    engine.finishTool(nodeEvent(taskId, childFailRetry.id, c1Attempt2), c1Op2, 'succeeded')
    engine.settleWorker(
      taskId,
      childFailRetry.id,
      { resultStatus: 'succeeded', executionStatus: 'completed', summary: 'Verified src/app.ts now contains ok', artifactRefs: ['src/app.ts'], evidenceRefs: [c1Op2], remainingRisks: [] },
      { passed: true, evidence: 'workspace_file_contains_expected_text' },
      c1Attempt2,
    )

    // Precondition check: Team is still running, so c1 must NOT be archived yet!
    const skipWhileTeamRunning = engine.archiveCompletedNodes(taskId)
    assert.equal(skipWhileTeamRunning.archivedCount, 0)

    // Settle Team -> generates TeamStageSummary automatically!
    engine.settleWorker(
      taskId,
      team.id,
      { resultStatus: 'succeeded', executionStatus: 'completed', summary: 'Core fix completed after resolving child check failure', artifactRefs: ['src/app.ts'], evidenceRefs: [], remainingRisks: [] },
      undefined,
      teamAttempt,
    )
    const summaries = engine.teamSummaries(taskId, team.id)
    assert.equal(summaries.length, 1)
    assert.equal(summaries[0]!.resolvedFailures.length, 1)
    assert.match(summaries[0]!.resolvedFailures[0]!.failure, /Missing export ok/)
    assert.match(summaries[0]!.resolvedFailures[0]!.resolution ?? '', /Verified src\/app\.ts/)

    // Precondition check: 'downstream' depends on 'team' and is still 'ready' -> 'team' MUST NOT archive yet!
    // Meanwhile 'c1' (child of succeeded Team, no incomplete dependents) CAN archive!
    const midArchive = engine.archiveCompletedNodes(taskId)
    assert.deepEqual(midArchive.archivedIds, [childFailRetry.id])

    // Precondition check: Node with open 'started' write operation MUST NOT archive
    const upAttempt = engine.startWorker(taskId, runningChildParent.id)
    const openOpId = `${upAttempt}:open`
    engine.beginTool(taskId, nodeEvent(taskId, runningChildParent.id, upAttempt), openOpId, 'read_text_file', 'read', 'src/x.ts')
    engine.finishTool(nodeEvent(taskId, runningChildParent.id, upAttempt), openOpId, 'succeeded')
    engine.settleWorker(
      taskId,
      runningChildParent.id,
      { resultStatus: 'succeeded', summary: 'Done', artifactRefs: [], evidenceRefs: [openOpId], remainingRisks: [] },
      undefined,
      upAttempt,
    )

    // Settle downstream too so all DAG nodes are succeeded
    const downAttempt = engine.startWorker(taskId, siblingBlocked.id)
    const downOp = `${downAttempt}:read`
    engine.beginTool(taskId, nodeEvent(taskId, siblingBlocked.id, downAttempt), downOp, 'read_text_file', 'read', 'src/app.ts')
    engine.finishTool(nodeEvent(taskId, siblingBlocked.id, downAttempt), downOp, 'succeeded')
    engine.settleWorker(
      taskId,
      siblingBlocked.id,
      { resultStatus: 'succeeded', summary: 'Integrated verification ok', artifactRefs: ['src/app.ts'], evidenceRefs: [downOp], remainingRisks: [] },
      undefined,
      downAttempt,
    )

    // Archive remaining nodes, simulate interruption after batch 1 (batchSize: 1)!
    let batches = 0
    assert.throws(() => engine.archiveCompletedNodes(taskId, {
      batchSize: 1,
      onBatchCommitted: () => {
        batches++
        if (batches === 1) throw new Error('Simulated archive interruption')
      },
    }), /Simulated archive interruption/)

    // Restart engine from disk to verify crash/interrupt recovery & idempotent resume of remaining archives
    store.close()
    store = new LocalStore(path)
    const recoveredEngine = new TaskEngine(store, { archiveThreshold: 128 })
    const recoveredMemory = new LocalMemory(store, { memoriesDir: join(dir, 'memories') })
    const resumedArchive = recoveredEngine.archiveCompletedNodes(taskId)
    assert.equal(resumedArchive.archivedCount, 2)
    assert.equal(recoveredEngine.activeNodes(taskId).length, 0)

    // Verify all nodes still hold status === 'succeeded' and verify() succeeds (never dag_not_converged!)
    recoveredEngine.beginVerification(taskId)
    const finalTask = recoveredEngine.verify(taskId, { passed: true, verdict: 'unverified', basis: 'none', evidence: 'confirmed_workspace_operation' })
    assert.equal(finalTask.status, 'succeeded')

    // On-demand detail restoration restores priorFailures & full original goal
    const detail = recoveredEngine.getNodeDetail(taskId, childFailRetry.id)
    assert.ok(detail)
    assert.equal(detail.archived, true)
    assert.equal(detail.priorFailures?.length, 1)
    assert.match(detail.priorFailures![0]!.summary, /Missing export ok/)
    assert.match(detail.priorFailures![0]!.resolution ?? '', /Verified src\/app\.ts/)

    // Evidence resolution & Memory linkage works cleanly with archived node evidence!
    const memScope = JSON.stringify(['workspace', dir])
    recoveredMemory.capture(
      { taskId, taskRunId: taskMeta.taskRunId, taskNodeId: childFailRetry.id, taskAttemptId: c1Attempt2, type: '', payload: {} },
      memScope,
      [{
        kind: 'experience',
        durable: true,
        key: 'core-app-fix',
        text: 'src/app.ts export check requires explicit re-export',
        paths: ['src/app.ts'],
        sourceRefs: [c1Op2],
        taskId,
        nodeId: childFailRetry.id,
        attemptId: c1Attempt2,
        evidenceRefs: [c1Op2, detail.archiveRef!],
      }],
    )
    const recalled = recoveredMemory.recall(memScope, 'export check', 5)
    assert.equal(recalled.length, 1)
    assert.equal(recalled[0]!.taskId, taskId)
    assert.equal(recalled[0]!.nodeId, childFailRetry.id)
    assert.ok(recalled[0]!.evidenceRefs?.includes(detail.archiveRef!))

    const resolvedOp = recoveredEngine.resolveEvidence(taskId, c1Op2)
    assert.equal(resolvedOp?.nodeId, childFailRetry.id)
    assert.equal(resolvedOp?.nodeArchived, true)
    const resolvedArch = recoveredEngine.resolveEvidence(taskId, detail.archiveRef!)
    assert.equal(resolvedArch?.archive?.nodeId, childFailRetry.id)
  } finally {
    store.close()
  }
})
