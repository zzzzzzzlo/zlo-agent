import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { writeHostDiagnostic } from '../../shared/diagnostics.ts'
import type { HostDiagnosticCode } from '../../shared/diagnostics.ts'
import type { DesktopCommand, DesktopErrorCode, HostMode } from '../../shared/contracts/desktop.ts'
import type { ManagementCommand, PrivateCredentialCommand } from '../../shared/contracts/management.ts'
import { localPort } from '../../shared/loopback-http.ts'
import { ConversationError, parseRoute } from './conversation.ts'
import { FakeExecution } from './fake.ts'
import { ModelUnavailableError } from './execution.ts'
import { LocalAgentHost } from './host.ts'
import type { HostCommand } from './host.ts'
import { inputRecord, providerId } from './management.ts'
import { validProviderKey } from './model-management.ts'
import { startTelemetryHttp } from './telemetry-http.ts'

const args = process.argv.slice(2)
if (args.includes('--help')) {
  process.stdout.write('Usage: npm run agent -- (--fake | --faux | --pi) [--data <directory>]\nVersioned JSON commands on stdin, responses and events on stdout. See README.md.\n')
  process.exit(0)
}
const desktop = args.at(-1) === '--desktop'
if (desktop) args.pop()
const lines = createInterface({ input: process.stdin, terminal: false })
const iterator = lines[Symbol.asyncIterator]()
const started = await startHost(args, desktop ? iterator : undefined)
if (started) await serveHost(started.host, started.runtimeId, desktop)
else {
  lines.close()
  process.stdin.pause()
  process.exitCode = 1
}

function configuredLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new Error('Invalid task budget')
  return Number(value)
}

async function startHost(args: string[], bootstrap?: AsyncIterator<string>): Promise<{ host: LocalAgentHost; runtimeId: HostMode } | undefined> {
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
    const harnessMode = process.env.ZLO_AGENT_HARNESS_MODE ?? 'quality'
    if (harnessMode !== 'quality' && harnessMode !== 'fast') throw new Error('Invalid harness mode')
    const tokens = configuredLimit(process.env.ZLO_AGENT_TASK_TOKEN_LIMIT)
    const requests = configuredLimit(process.env.ZLO_AGENT_TASK_REQUEST_LIMIT)
    const defaultRoute = mode === '--faux' ? { provider: 'faux', model: 'desktop-test' }
      : modelProvider || modelId ? parseRoute({ provider: modelProvider, model: modelId }) : undefined
    failure = 'host.startup_runtime_failed'
    const providerRuntime = mode === '--pi' ? new (await import('./pi.ts')).PiExecution() : undefined
    const execution = providerRuntime ?? (mode === '--faux' ? new (await import('./faux.ts')).FauxExecution() : new FakeExecution())
    if (bootstrap) {
      const first = await bootstrap.next()
      if (first.done || typeof first.value !== 'string' || first.value.length > 256 * 1024) throw new Error('Invalid desktop bootstrap')
      const command = JSON.parse(first.value)
      if (command?.schemaVersion !== 1 || command.type !== 'initializeProviderKeys') throw new Error('Invalid desktop bootstrap')
      for (const [name, key] of Object.entries(inputRecord(command.credentials))) {
        const provider = providerId(name)
        if (!providerRuntime || (key !== null && !validProviderKey(key))) throw new Error('Invalid desktop credential')
        await providerRuntime.setProviderKey(provider, key)
      }
      if (command.chatGpt != null) {
        if (!providerRuntime) throw new Error('Invalid desktop account')
        await providerRuntime.setChatGptSession(command.chatGpt)
      }
    }
    failure = 'host.startup_storage_failed'
    const host = new LocalAgentHost({
      directory, execution, runtimeId, providerRuntime, defaultRoute, defaultWorkspace: process.env.ZLO_AGENT_DEFAULT_WORKSPACE,
      harnessMode, modelLimits: { ...(tokens === undefined ? {} : { tokens }), ...(requests === undefined ? {} : { requests }) },
    })
    return { host, runtimeId }
  } catch {
    writeHostDiagnostic(failure)
    return undefined
  }
}

async function serveHost(host: LocalAgentHost, runtimeId: HostMode, desktop: boolean): Promise<void> {
  const token = process.env.ZLO_TELEMETRY_TOKEN
  const telemetry = token ? Promise.resolve().then(() => startTelemetryHttp(host, {
    port: localPort(process.env.ZLO_TELEMETRY_PORT, 4557), token,
  })).catch(() => { writeHostDiagnostic('host.telemetry_unavailable') }) : undefined
  const subscriptions = new Map<string, () => void>()
  const conversationSubscriptions = new Map<string, () => void>()
  const send = (message: object): void => { process.stdout.write(JSON.stringify(message) + '\n') }
  const desktopTypes = new Set([
    'createConversation', 'listConversations', 'getConversation', 'getConversationHistory', 'sendMessage',
    'steerConversation', 'stopConversation', 'resumeConversation', 'renameConversation', 'archiveConversation',
    'setConversationModel', 'subscribeConversation', 'unsubscribeConversation',
  ])
  const managementTypes = new Set([
    'managementSnapshot', 'conversationObservatory', 'saveAgentPreferences', 'setWorkspaceAccess', 'deleteConversationMemory', 'reconcileOperation',
    'testProviderAccount', 'validateProviderKey', 'applyProviderKey', 'applyChatGptSession', 'initializeProviderKeys',
  ])
  const stopOutput = host.subscribeOutput((event) => {
    if (subscriptions.has(event.taskId)) send({ schemaVersion: 1, kind: 'output', event })
  })
  const stopApprovals = host.subscribeToolApprovals(notice => send({ schemaVersion: 1, ...notice }))
  let shuttingDown = false
  let pendingProbes = 0
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
    for await (const line of { [Symbol.asyncIterator]: () => iterator }) {
      if (shuttingDown) break
      if (!line.trim()) continue
      let command: (HostCommand | DesktopCommand | ManagementCommand | PrivateCredentialCommand | {
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
        } else if (managementTypes.has(type)) {
          if (!desktop) throw new ConversationError('INVALID_INPUT', 'Desktop management requires the private desktop transport')
          if (type === 'testProviderAccount' || type === 'validateProviderKey') {
            if (pendingProbes >= 4) throw new ConversationError('CONFLICT', 'Too many provider tests in progress')
            pendingProbes++
            void host.managementCommand(command as ManagementCommand | PrivateCredentialCommand).then(value => {
              if (!shuttingDown) send({ schemaVersion: 1, kind: 'result', commandId, type, result: value })
            }, error => {
              if (shuttingDown) return
              const code: DesktopErrorCode = error instanceof ConversationError ? error.code
                : error instanceof ModelUnavailableError ? 'MODEL_UNAVAILABLE' : 'INTERNAL'
              send({ schemaVersion: 1, kind: 'error', commandId, error: { code, message: 'Provider test failed' } })
            }).finally(() => { pendingProbes-- })
            continue
          }
          result = await host.managementCommand(command as ManagementCommand | PrivateCredentialCommand)
        } else {
          result = await host.command(command as HostCommand | DesktopCommand)
        }
        send({ schemaVersion: 1, kind: 'result', commandId, type, result })
      } catch (error) {
        const managementRequest = command && managementTypes.has(command.type)
        const code: DesktopErrorCode = error instanceof ConversationError ? error.code
          : managementRequest && error instanceof ModelUnavailableError ? 'MODEL_UNAVAILABLE' : 'INTERNAL'
        if (code === 'INVALID_INPUT') writeHostDiagnostic('host.protocol_rejected')
        else if (code === 'INTERNAL') writeHostDiagnostic('host.runtime_failed')
        const message = error instanceof ConversationError ? error.message
          : managementRequest ? 'Management request failed'
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
      const listener = await telemetry
      await listener?.close()
      await host.close()
    } catch {
      writeHostDiagnostic('host.shutdown_failed')
      const message = 'Host shutdown failed'
      send({ schemaVersion: 1, kind: 'error', error: { code: 'INTERNAL', message }, message })
      process.exitCode = 1
    } finally {
      stopOutput()
      stopApprovals()
      for (const unsubscribe of subscriptions.values()) unsubscribe()
      for (const unsubscribe of conversationSubscriptions.values()) unsubscribe()
      process.off('SIGINT', shutdown)
      process.off('SIGTERM', shutdown)
    }
  }
}
