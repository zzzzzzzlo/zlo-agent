// Optional upstream comparison. Copy this file into an isolated npm prefix that
// contains pi-durable, pi-ai, pi-schema and chord, all pinned to 1.5.0.
// Run with Node 24. This probe never calls a live model provider.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { Harness, createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { obj } from '@earendil-works/pi-schema'

const [, , childDir] = process.argv
const model = { provider: 'faux', modelId: 'faux-1' }

async function openHarness(dir, responses, crash) {
  const faux = fauxProvider()
  faux.setResponses(responses)
  const models = createModels()
  models.setProvider(faux.provider)
  const registry = createRegistry()
  registry.install(defineExtension({
    name: 'probe',
    tools: [defineTool({
      name: 'external_effect',
      description: 'Append an external effect marker once',
      parameters: obj({}),
      async execute() {
        appendFileSync(join(dir, 'effects.txt'), 'effect\n')
        if (crash) process.exit(17)
        return { output: [{ type: 'text', text: 'unexpected replay' }] }
      },
    })],
  }))
  const storage = await openNodeSqliteStorage(join(dir, 'probe.sqlite'))
  const harness = await Harness.open(storage, { models, registry }, context)
  return { harness, root: await harness.root(context, { agent: { model } }) }
}

const request = { type: 'input', content: 'Call external_effect', requestId: 'durable-probe-request' }
if (childDir) {
  const toolCall = fauxToolCall('external_effect', {}, { id: 'tool-probe' })
  const { root } = await openHarness(childDir, [fauxAssistantMessage(toolCall, { stopReason: 'toolUse' })], true)
  const submission = await root.submit(request, context)
  console.log(submission.id)
  await submission.wait(context)
  throw new Error('tool did not crash the child')
}

const timeout = setTimeout(() => {
  console.error('Durable spike timed out')
  process.exit(1)
}, 15_000)
const dir = mkdtempSync(join(tmpdir(), 'zlo-durable-crash-'))
try {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), dir], { encoding: 'utf8', timeout: 10000 })
  assert.equal(child.status, 17, child.error?.message ?? child.stderr)
  const submissionId = Number(child.stdout.trim())
  assert.ok(Number.isSafeInteger(submissionId) && submissionId > 0)
  assert.equal(readFileSync(join(dir, 'effects.txt'), 'utf8'), 'effect\n')
  let recoveryMessage
  const entered = Promise.withResolvers()
  const { harness, root } = await openHarness(dir, [
    transcript => {
      recoveryMessage = JSON.stringify(transcript.messages.find(message => message.role === 'toolResult'))
      return fauxAssistantMessage('Recovered after interrupted tool')
    },
    async (_transcript, options) => {
      entered.resolve()
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
      return fauxAssistantMessage('', { stopReason: 'aborted' })
    },
  ], false)
  try {
    const graph = await harness.watchTaskGraph(context)
    assert.ok(Object.keys(graph.value.tasks).length > 0)
    harness.resume()
    const submission = await harness.submission(submissionId, context)
    assert.ok(submission)
    assert.equal((await submission.wait(context)).status, 'done')
    assert.match(recoveryMessage, /interrupted/i)
    assert.equal(readFileSync(join(dir, 'effects.txt'), 'utf8'), 'effect\n')
    assert.equal((await root.submit(request, context)).id, submissionId)
    const aborted = await root.submit({ type: 'input', content: 'Abort this turn', requestId: 'abort' }, context)
    await entered.promise
    await root.abort(context)
    assert.equal((await aborted.wait(context)).status, 'unanswered')
    console.log('PASS Durable 1.5.0 SQLite, live TaskGraph, crash/resume, non-replay tool effect, requestId deduplication, explicit abort')
  } finally {
    await harness.close(context)
  }
} finally {
  clearTimeout(timeout)
  rmSync(dir, { recursive: true, force: true })
}
