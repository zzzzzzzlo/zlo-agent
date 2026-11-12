import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { InMemoryCredentialStore, getCurrentTools } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { LocalAgentHost } from '../src/host.ts'
import { PiExecution } from '../src/pi.ts'

const runFile = promisify(execFile)
const pricing = `final class Pricing {
    static int deliveryFee(int subtotalCents, boolean member) {
        if (subtotalCents < 0) throw new IllegalArgumentException("negative subtotal");
        return member || subtotalCents >= 5000 ? 0 : 399;
    }
}
`
const checks = `final class PricingTest {
    public static void main(String[] args) {
        if (Pricing.deliveryFee(4999, false) != 399 || Pricing.deliveryFee(5000, false) != 0
                || Pricing.deliveryFee(4999, true) != 0) throw new AssertionError("delivery threshold or member exemption");
        try {
            Pricing.deliveryFee(-1, false);
            throw new AssertionError("negative subtotal was accepted");
        } catch (IllegalArgumentException expected) { }
        System.out.println("PRICING_CHECKS_PASSED");
    }
}
`

test('the Pi Faux provider implements a Java feature and verifies it with the installed JDK', { timeout: 30_000 }, async t => {
  const tools = await Promise.allSettled(['javac', 'java'].map(name => runFile(name, ['-version'], { timeout: 4_000 })))
  if (tools.some(result => result.status === 'rejected')) {
    t.skip('Both javac and java must be executable on PATH')
    return
  }
  const root = await mkdtemp(join(await realpath(tmpdir()), 'zlo-harness-java-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  await writeFile(join(cwd, 'PricingTest.java'), checks)
  const shell = process.platform === 'win32' ? 'cmd' : 'sh'
  const command = 'javac Pricing.java PricingTest.java && java PricingTest'
  const model = 'java-fixture'
  const provider = fauxProvider({ models: [{ id: model }] })
  const failures: unknown[] = []
  let verified = false
  let approvalCount = 0
  let polls = 0
  let processId: string | undefined
  const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
    fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' })
  const reply: FauxResponseFactory = async context => {
    provider.appendResponses([reply])
    try {
      const last = context.messages.findLast(message => message.role === 'toolResult')
      if (last?.role !== 'toolResult') {
        const visible = getCurrentTools(context.messages).map(({ name }) => name)
        for (const name of ['create_text_file', 'shell_exec', 'process_status', 'process_output']) assert.ok(visible.includes(name))
        return tool('create_text_file', { path: 'Pricing.java', content: pricing })
      }
      const part = last.content.find(item => item.type === 'text')
      assert.ok(part?.type === 'text')
      const result = JSON.parse(part.text)
      assert.equal(result.ok, true, part.text)
      if (last.toolName === 'create_text_file') return tool('shell_exec', { shell, command, timeoutMs: 9_000 })
      if (last.toolName === 'shell_exec') {
        assert.equal(typeof result.processId, 'string')
        processId = result.processId
      }
      if (last.toolName === 'process_status' && result.state === 'exited') {
        assert.equal(result.exitCode, 0)
        assert.ok(processId)
        return tool('process_output', { processId })
      }
      if (last.toolName === 'process_output') {
        assert.match(part.text, /PRICING_CHECKS_PASSED/u)
        verified = true
        return fauxAssistantMessage('The delivery fee passes all four Java checks.')
      }
      assert.ok(++polls <= 70, 'The JDK test did not exit')
      assert.ok(processId)
      await delay(100)
      return tool('process_status', { processId })
    } catch (error) {
      failures.push(error)
      return fauxAssistantMessage('The fixture did not obtain test evidence.')
    }
  }
  provider.setResponses([reply])
  const execution = new PiExecution(async () => {
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false })
    runtime.registerNativeProvider(provider.provider)
    return runtime
  })
  const host = new LocalAgentHost({ directory: join(root, 'state'), execution, approveTool: async request => {
    approvalCount++
    assert.equal(request.kind, 'shell')
    assert.equal(request.tool, 'shell_exec')
    assert.deepEqual(JSON.parse(request.detail), { shell, command, timeoutMs: 9_000 })
    return { approved: true }
  } })
  try {
    const { taskId } = await host.createTask({ requestId: 'java-delivery', goal: 'Implement the delivery fee and run PricingTest.',
      cwd, workspaceAccess: 'trusted', route: { provider: 'faux', model }, check: { path: 'Pricing.java', contains: 'class Pricing' } })
    await host.idle()
    assert.deepEqual(failures, [])
    assert.equal(verified, true)
    assert.equal(approvalCount, 1)
    assert.equal(host.getTask(taskId).status, 'succeeded')
    assert.equal(await readFile(join(cwd, 'Pricing.java'), 'utf8'), pricing)
    const receipt = host.getHistory(taskId).operations.find(operation => operation.tool === 'shell_exec')
    assert.equal(receipt?.managed, true)
    assert.equal(receipt?.status, 'succeeded')
  } finally { await host.close() }
})
