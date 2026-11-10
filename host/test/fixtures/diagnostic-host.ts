import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { LocalAgentHost } from '../../src/host.ts'
import { PiExecution } from '../../src/pi.ts'

const root = process.argv[2]
const cwd = join(root, 'workspace')
await mkdir(cwd)
const execution = new PiExecution(async () => {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  })
  const provider = fauxProvider({ models: [{ id: 'diagnostic-test' }] })
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall('read_text_file', { path: '../tool-secret-marker.txt' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Authorization: Bearer fake-credential-marker. private-prompt-marker' }),
  ])
  runtime.registerNativeProvider(provider.provider)
  return runtime
})
const host = new LocalAgentHost({ directory: join(root, 'state'), execution })
try {
  const { taskId } = await host.createTask({
    requestId: 'diagnostic-test', cwd, goal: 'private-prompt-marker', route: { provider: 'faux', model: 'diagnostic-test' },
  })
  await host.idle()
  process.stdout.write(JSON.stringify({ status: host.getTask(taskId).status }) + '\n')
} finally {
  await host.close()
}
