import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { FakeExecution } from './fake.ts'
import { LocalAgentHost } from './host.ts'
import type { HostCommand } from './host.ts'

const args = process.argv.slice(2)
if (args.includes('--help')) {
  process.stdout.write('Usage: npm run agent -- (--fake | --pi) [--data <directory>]\nVersioned JSON commands on stdin, responses and events on stdout. See README.md.\n')
  process.exit(0)
}
const mode = args[0]
if (mode !== '--fake' && mode !== '--pi') throw new Error('Select --fake for offline or --pi for a configured provider')
if (args.length !== 1 && (args.length !== 3 || args[1] !== '--data' || !args[2])) throw new Error('Invalid CLI options')
const defaultDirectory = join(process.env.LOCALAPPDATA ?? homedir(), 'ZloAgent', mode.slice(2))
const directory = args[2] ? resolve(args[2]) : defaultDirectory
const execution = mode === '--pi' ? new (await import('./pi.ts')).PiExecution() : new FakeExecution()
const host = new LocalAgentHost({ directory, execution, runtimeId: mode.slice(2) })
const lines = createInterface({ input: process.stdin, terminal: false })
const subscriptions = new Map<string, () => void>()
const send = (message: object): void => { process.stdout.write(JSON.stringify(message) + '\n') }
const stopOutput = host.subscribeOutput((event) => {
  if (subscriptions.has(event.taskId)) send({ schemaVersion: 1, kind: 'output', event })
})
let shuttingDown = false
const shutdown = () => {
  if (shuttingDown) return
  shuttingDown = true
  lines.close()
  process.stdin.pause()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
send({ schemaVersion: 1, kind: 'ready', mode: mode.slice(2) })
try {
  for await (const line of lines) {
    if (shuttingDown) break
    if (!line.trim()) continue
    let command: (HostCommand | {
      schemaVersion: 1; type: 'subscribe' | 'unsubscribe' | 'events'; taskId: string; after?: number;
    } | { schemaVersion: 1; type: 'exit' }) & { commandId?: string } | undefined
    try {
      if (line.length > 65536) throw new Error('Command exceeds size limit')
      command = JSON.parse(line)
      if (command?.schemaVersion !== 1) throw new Error('Unsupported command version')
      const { commandId, type } = command
      if (type === 'exit') {
        send({ schemaVersion: 1, kind: 'result', commandId, type, result: true })
        shutdown()
        break
      }
      let result: unknown
      if (type === 'subscribe') {
        const { taskId, after = 0 } = command
        const unsubscribe = host.subscribe(taskId, after, (event) => send({ schemaVersion: 1, kind: 'event', event }))
        subscriptions.get(taskId)?.()
        subscriptions.set(taskId, unsubscribe)
        result = true
      } else if (type === 'unsubscribe') {
        subscriptions.get(command.taskId)?.()
        result = subscriptions.delete(command.taskId)
      } else if (type === 'events') {
        result = host.events(command.taskId, command.after)
      } else {
        result = await host.command(command as HostCommand)
      }
      send({ schemaVersion: 1, kind: 'result', commandId, type, result })
    } catch (error) {
      send({
        schemaVersion: 1, kind: 'error', commandId: command?.commandId,
        message: error instanceof Error ? error.message : 'Command failed',
      })
    }
  }
} finally {
  try {
    await host.close()
  } catch (error) {
    send({ schemaVersion: 1, kind: 'error', message: error instanceof Error ? error.message : 'Host shutdown failed' })
    process.exitCode = 1
  } finally {
    stopOutput()
    for (const unsubscribe of subscriptions.values()) unsubscribe()
    process.off('SIGINT', shutdown)
    process.off('SIGTERM', shutdown)
  }
}
