import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { writeHostDiagnostic } from '../../shared/diagnostics.ts'
import type { HostDiagnosticCode } from '../../shared/diagnostics.ts'
import type { DesktopCommand, DesktopErrorCode, HostMode } from '../../shared/contracts/desktop.ts'
import { ConversationError, parseRoute } from './conversation.ts'
import { FakeExecution } from './fake.ts'
import { LocalAgentHost } from './host.ts'
import type { HostCommand } from './host.ts'

const args = process.argv.slice(2)
if (args.includes('--help')) {
  process.stdout.write('Usage: npm run agent -- (--fake | --faux | --pi) [--data <directory>]\nVersioned JSON commands on stdin, responses and events on stdout. See README.md.\n')
  process.exit(0)
}
const started = await startHost(args)
if (started) await serveHost(started.host, started.runtimeId)
else process.exitCode = 1

async function startHost(args: string[]): Promise<{ host: LocalAgentHost; runtimeId: HostMode } | undefined> {
  let failure: HostDiagnosticCode = 'host.startup_config_invalid'
  try {
    const mode = args[0]
    if (mode !== '--fake' && mode !== '--faux' && mode !== '--pi') throw new Error('Invalid Host mode')
    if (args.length !== 1 && (args.length !== 3 || args[1] !== '--data' || !args[2])) throw new Error('Invalid CLI options')
    const runtimeId = mode.slice(2) as HostMode
    const defaultDirectory = join(process.env.LOCALAPPDATA ?? homedir(), 'ZloAgent', runtimeId)
    const directory = args[2] ? resolve(args[2]) : defaultDirectory
    const modelProvider = process.env.ZLO_AGENT_MODEL_PROVIDER
    const modelId = process.env.ZLO_AGENT_MODEL_ID
    const defaultRoute = mode === '--faux' ? { provider: 'faux', model: 'desktop-test' }
      : modelProvider || modelId ? parseRoute({ provider: modelProvider, model: modelId }) : undefined
    failure = 'host.startup_runtime_failed'
    const execution = mode === '--pi' ? new (await import('./pi.ts')).PiExecution()
      : mode === '--faux' ? new (await import('./faux.ts')).FauxExecution() : new FakeExecution()
    failure = 'host.startup_storage_failed'
    const host = new LocalAgentHost({
      directory, execution, runtimeId, defaultRoute, defaultWorkspace: process.env.ZLO_AGENT_DEFAULT_WORKSPACE,
    })
    return { host, runtimeId }
  } catch {
    writeHostDiagnostic(failure)
    return undefined
  }
}

async function serveHost(host: LocalAgentHost, runtimeId: HostMode): Promise<void> {
  const lines = createInterface({ input: process.stdin, terminal: false })
  const subscriptions = new Map<string, () => void>()
  const conversationSubscriptions = new Map<string, () => void>()
  const send = (message: object): void => { process.stdout.write(JSON.stringify(message) + '\n') }
  const desktopTypes = new Set([
    'createConversation', 'listConversations', 'getConversation', 'getConversationHistory', 'sendMessage',
    'steerConversation', 'stopConversation', 'resumeConversation', 'renameConversation', 'archiveConversation',
    'setConversationModel', 'subscribeConversation', 'unsubscribeConversation',
  ])
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
  send({ schemaVersion: 1, kind: 'ready', mode: runtimeId })
  try {
    for await (const line of lines) {
      if (shuttingDown) break
      if (!line.trim()) continue
      let command: (HostCommand | DesktopCommand | {
        schemaVersion: 1; type: 'subscribe' | 'unsubscribe' | 'events'; taskId: string; after?: number;
      } | { schemaVersion: 1; type: 'exit' }) & { commandId?: string } | undefined
      try {
        if (line.length > 65536) throw new ConversationError('INVALID_INPUT', 'Command exceeds size limit')
        try {
          command = JSON.parse(line)
        } catch {
          throw new ConversationError('INVALID_INPUT', 'Invalid command JSON')
        }
        if (command?.schemaVersion !== 1 || typeof command.type !== 'string') {
          throw new ConversationError('INVALID_INPUT', 'Invalid command or protocol version')
        }
        if (command.commandId !== undefined && (typeof command.commandId !== 'string' || command.commandId.length > 128)) {
          throw new ConversationError('INVALID_INPUT', 'Invalid command ID')
        }
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
        } else if (type === 'subscribeConversation') {
          const unsubscribe = host.subscribeConversation(command, (event) => send({ schemaVersion: 1, kind: 'conversation.event', event }))
          conversationSubscriptions.get(command.conversationId)?.()
          conversationSubscriptions.set(command.conversationId, unsubscribe)
          result = true
        } else if (type === 'unsubscribeConversation') {
          host.getConversation(command.conversationId)
          conversationSubscriptions.get(command.conversationId)?.()
          conversationSubscriptions.delete(command.conversationId)
          result = true
        } else {
          result = await host.command(command as HostCommand | DesktopCommand)
        }
        send({ schemaVersion: 1, kind: 'result', commandId, type, result })
      } catch (error) {
        const code: DesktopErrorCode = error instanceof ConversationError ? error.code : 'INTERNAL'
        if (code === 'INVALID_INPUT') writeHostDiagnostic('host.protocol_rejected')
        else if (code === 'INTERNAL') writeHostDiagnostic('host.runtime_failed')
        const message = error instanceof ConversationError ? error.message
          : command && desktopTypes.has(command.type) ? 'Host command failed'
            : error instanceof Error ? error.message : 'Command failed'
        send({
          schemaVersion: 1, kind: 'error', commandId: typeof command?.commandId === 'string' ? command.commandId.slice(0, 128) : undefined,
          error: { code, message }, message,
        })
      }
    }
  } finally {
    try {
      await host.close()
    } catch {
      writeHostDiagnostic('host.shutdown_failed')
      const message = 'Host shutdown failed'
      send({ schemaVersion: 1, kind: 'error', error: { code: 'INTERNAL', message }, message })
      process.exitCode = 1
    } finally {
      stopOutput()
      for (const unsubscribe of subscriptions.values()) unsubscribe()
      for (const unsubscribe of conversationSubscriptions.values()) unsubscribe()
      process.off('SIGINT', shutdown)
      process.off('SIGTERM', shutdown)
    }
  }
}
