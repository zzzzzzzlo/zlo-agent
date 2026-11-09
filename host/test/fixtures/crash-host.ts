import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentExecution } from '../../src/execution.ts'
import { LocalAgentHost } from '../../src/host.ts'
import { TaskEngine } from '../../src/task-engine.ts'

const [directory, cwd, mode] = process.argv.slice(2)
const sessionId = 'crash-fixture-session'
const route = { provider: 'test', model: 'deterministic' }
const artifact = 'artifact.txt'
const content = 'written once\n'

function stopAtCrashBoundary(id: string): never {
  assert.equal(readFileSync(join(cwd, artifact), 'utf8'), content)
  assert.deepEqual(host.stop(id, 'stop-before-crash'), { accepted: true, status: 'stop_requested' })
  assert.equal(host.getTask(id).status, 'stopping')
  writeSync(1, JSON.stringify({ taskId: id, sessionId }) + '\n')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000)
  throw new Error('Crash test parent did not terminate child')
}

if (mode === 'unknown-effect') {
  // Fault-inject at the actual successful workspace write's receipt boundary.
  const finishTool = TaskEngine.prototype.finishTool
  TaskEngine.prototype.finishTool = function (event, id, status) {
    const operation = this.operations(event.taskId).find((operation) => operation.id === id)
    if (operation?.effect === 'write' && status === 'succeeded') {
      assert.equal(operation.status, 'started')
      stopAtCrashBoundary(event.taskId)
    }
    finishTool.call(this, event, id, status)
  }
}

const execution: AgentExecution = {
  async validateRoute() {},
  async open(config) {
    mkdirSync(config.sessionDirectory, { recursive: true })
    const path = join(config.sessionDirectory, sessionId + '.jsonl')
    writeFileSync(path, JSON.stringify({ id: sessionId }) + '\n', { flush: true })
    return {
      ref: { id: sessionId, path },
      route,
      async run() {
        const write = config.tools.find((tool) => tool.name === 'create_text_file')
        assert.ok(write)
        assert.deepEqual(await write.execute('initial-write', { path: artifact, content }), { ok: true })
        assert.equal(host.getHistory(taskId).operations[0]?.status, 'succeeded')
        if (mode === 'missing-session') unlinkSync(path)
        stopAtCrashBoundary(taskId)
      },
      async steer() {},
      async requestStop() {},
      async checkpoint() {},
      async dispose() {},
    }
  },
}

const host = new LocalAgentHost({ directory, execution })
const { taskId } = await host.createTask({
  requestId: 'create-before-crash', goal: 'Create the verified artifact once.', cwd,
  check: { path: artifact, contains: 'written once' },
})
await host.idle()
throw new Error('Task settled before crash injection')
