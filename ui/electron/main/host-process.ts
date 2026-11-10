import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { diagnostic } from '../../../shared/diagnostics.ts'
import type { DiagnosticCode, DiagnosticEntry } from '../../../shared/diagnostics.ts'
import { collectHostDiagnostics } from './diagnostic-log.ts'
import type { ConversationEvent, DesktopCommand, DesktopErrorCode, DesktopHostStatus, HostMode } from '../../../shared/contracts/desktop.ts'

const startupTimeoutMs = 15_000
const requestTimeoutMs = 20_000
const shutdownTimeoutMs = 12_000
const maxLineLength = 32 * 1024 * 1024
const maxPendingRequests = 128
const errorCodes = new Set<DesktopErrorCode>([
  'INVALID_INPUT', 'NOT_FOUND', 'CONFLICT', 'MODEL_UNAVAILABLE', 'INTERNAL', 'HOST_UNAVAILABLE',
])

export class HostTransportError extends Error {
  readonly code: DesktopErrorCode

  constructor(code: DesktopErrorCode, message: string) {
    super(message)
    this.name = 'HostTransportError'
    this.code = code
  }
}

function unavailable(message = 'Agent Host 尚未就绪。') {
  return new HostTransportError('HOST_UNAVAILABLE', message)
}

interface PendingRequest {
  type: DesktopCommand['type']
  resolve(value: unknown): void
  reject(error: HostTransportError): void
  timer: NodeJS.Timeout
}

interface Connection {
  child: ChildProcessWithoutNullStreams
  correlationId: string
  state: 'starting' | 'ready' | 'stopping'
  ready: Promise<DesktopHostStatus>
  resolveReady(status: DesktopHostStatus): void
  closed: Promise<void>
  resolveClosed(): void
  pending: Map<string, PendingRequest>
  startupTimer?: NodeJS.Timeout
  incompleteLine: string
  failure?: string
}

interface ManagerOptions {
  mode: HostMode
  spawnChild: () => ChildProcessWithoutNullStreams
  diagnostic?: (entry: DiagnosticEntry) => void
  startupTimeoutMs?: number
  requestTimeoutMs?: number
  shutdownTimeoutMs?: number
}

type Listener<T> = (value: T) => void

function emit<T>(listeners: Set<Listener<T>>, value: T): void {
  for (const listener of listeners) {
    try { listener(value) } catch { /* A display subscriber cannot break the transport. */ }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEvent(value: unknown): value is ConversationEvent {
  if (!isObject(value)) return false
  return value.schemaVersion === 1 && typeof value.eventId === 'string'
    && Number.isSafeInteger(value.seq) && Number(value.seq) > 0 && Number.isFinite(value.timestamp)
    && typeof value.conversationId === 'string' && typeof value.type === 'string' && isObject(value.payload)
}

function waitForClose(connection: Connection, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    void connection.closed.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

export class HostProcessManager {
  readonly #options: ManagerOptions
  readonly #statuses = new Set<Listener<DesktopHostStatus>>()
  readonly #events = new Set<Listener<ConversationEvent>>()
  #status: DesktopHostStatus
  #connection?: Connection
  #stopInFlight?: Promise<void>
  #restartInFlight?: Promise<DesktopHostStatus>
  #shutdown = false

  constructor(options: ManagerOptions) {
    this.#options = options
    this.#status = { state: 'starting', mode: options.mode }
  }

  get status(): DesktopHostStatus { return this.#status }

  onStatus(listener: Listener<DesktopHostStatus>): () => void {
    this.#statuses.add(listener)
    return () => { this.#statuses.delete(listener) }
  }

  onEvent(listener: Listener<ConversationEvent>): () => void {
    this.#events.add(listener)
    return () => { this.#events.delete(listener) }
  }

  start(): Promise<DesktopHostStatus> {
    if (this.#shutdown) return Promise.resolve(this.#status)
    if (this.#connection) {
      return this.#connection.state === 'starting' ? this.#connection.ready : Promise.resolve(this.#status)
    }

    const ready = Promise.withResolvers<DesktopHostStatus>()
    const closed = Promise.withResolvers<void>()
    const correlationId = randomUUID()
    this.#log('desktop.host_starting', correlationId)
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.#options.spawnChild()
    } catch {
      this.#log('desktop.host_spawn_failed', correlationId)
      this.#setStatus('offline', '无法启动 Agent Host。')
      return Promise.resolve(this.#status)
    }
    const connection: Connection = {
      child, correlationId, state: 'starting', ready: ready.promise, resolveReady: ready.resolve,
      closed: closed.promise, resolveClosed: closed.resolve, pending: new Map(), incompleteLine: '',
    }
    this.#connection = connection
    child.once('error', () => { this.#fail(connection, 'desktop.host_spawn_failed', 'Agent Host 进程无法运行。') })
    child.once('close', (code) => { this.#closed(connection, code) })
    child.stdin.on('error', () => { this.#fail(connection, 'desktop.host_channel_failed', 'Agent Host 的输入通道已中断。') })
    child.stdout.on('error', () => { this.#fail(connection, 'desktop.host_channel_failed', 'Agent Host 的输出通道已中断。') })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { this.#read(connection, chunk) })
    collectHostDiagnostics(child.stderr,
      (item) => this.#log(item.code, correlationId),
      () => this.#log('desktop.host_stderr_ignored', correlationId))
    connection.startupTimer = setTimeout(() => {
      this.#fail(connection, 'desktop.host_startup_timeout', 'Agent Host 启动超时。')
    }, this.#options.startupTimeoutMs ?? startupTimeoutMs)
    this.#setStatus('starting')
    return connection.ready
  }

  async request<T>(command: DesktopCommand): Promise<T> {
    const connection = this.#connection
    if (!connection || connection.state !== 'ready' || this.#shutdown) throw unavailable(this.#status.message)
    if (connection.pending.size >= maxPendingRequests) {
      throw new HostTransportError('CONFLICT', 'Agent Host 的待处理请求过多。')
    }
    const commandId = randomUUID()
    const line = JSON.stringify({ ...command, commandId }) + '\n'
    if (line.length > 65_536) throw new HostTransportError('INVALID_INPUT', '请求超过长度上限。')
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#settle(connection, commandId)
        if (!pending) return
        this.#log('desktop.host_request_timeout', connection.correlationId)
        pending.reject(unavailable('等待 Agent Host 响应超时。'))
      }, this.#options.requestTimeoutMs ?? requestTimeoutMs)
      connection.pending.set(commandId, { type: command.type, resolve: (result) => resolve(result as T), reject, timer })
      try {
        connection.child.stdin.write(line, 'utf8', (error) => {
          if (error) this.#fail(connection, 'desktop.host_channel_failed', 'Agent Host 的输入通道已中断。')
        })
      } catch {
        this.#fail(connection, 'desktop.host_channel_failed', 'Agent Host 的输入通道已中断。')
      }
    })
  }

  restart(): Promise<DesktopHostStatus> {
    if (this.#shutdown) return Promise.resolve(this.#status)
    this.#restartInFlight ??= this.#stop().then(() => this.start()).finally(() => { this.#restartInFlight = undefined })
    return this.#restartInFlight
  }

  shutdown(): Promise<void> {
    this.#shutdown = true
    return this.#stop()
  }

  #stop(): Promise<void> {
    const connection = this.#connection
    if (!connection) return Promise.resolve()
    this.#stopInFlight ??= this.#stopConnection(connection).finally(() => { this.#stopInFlight = undefined })
    return this.#stopInFlight
  }

  async #stopConnection(connection: Connection): Promise<void> {
    if (connection.state !== 'stopping') {
      connection.state = 'stopping'
      clearTimeout(connection.startupTimer)
      this.#rejectPending(connection, unavailable('Agent Host 正在关闭。'))
      this.#setStatus('offline')
      connection.resolveReady(this.#status)
      connection.child.stdin.end(JSON.stringify({ schemaVersion: 1, type: 'exit' }) + '\n')
    }
    if (await waitForClose(connection, this.#options.shutdownTimeoutMs ?? shutdownTimeoutMs)) return
    this.#log('desktop.host_shutdown_timeout', connection.correlationId)
    connection.child.kill()
    if (!await waitForClose(connection, 2_000)) {
      throw unavailable('Agent Host 未能在关闭期限内退出。')
    }
  }

  #read(connection: Connection, chunk: string): void {
    if (this.#connection !== connection || connection.state === 'stopping') return
    const lines = (connection.incompleteLine + chunk).split('\n')
    connection.incompleteLine = lines.pop() ?? ''
    if (connection.incompleteLine.length > maxLineLength || lines.some((line) => line.length > maxLineLength)) {
      this.#fail(connection, 'desktop.host_protocol_invalid', 'Agent Host 的协议数据超出长度上限。')
      return
    }
    for (const line of lines) {
      if (this.#status.state === 'offline') return
      if (line.trim()) this.#receive(connection, line)
    }
  }

  #receive(connection: Connection, line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.#fail(connection, 'desktop.host_protocol_invalid', 'Agent Host 返回了无效的协议数据。')
      return
    }
    if (!isObject(message) || message.schemaVersion !== 1) {
      this.#fail(connection, 'desktop.host_protocol_invalid', 'Agent Host 协议版本不匹配。')
      return
    }
    if (message.kind === 'ready') {
      if (connection.state !== 'starting' || message.mode !== this.#options.mode) {
        this.#fail(connection, 'desktop.host_protocol_invalid', 'Agent Host 启动模式不匹配。')
        return
      }
      connection.state = 'ready'
      clearTimeout(connection.startupTimer)
      this.#log('desktop.host_ready', connection.correlationId)
      this.#setStatus('ready')
      connection.resolveReady(this.#status)
    } else if (message.kind === 'conversation.event' && connection.state === 'ready') {
      if (!isEvent(message.event)) {
        this.#fail(connection, 'desktop.host_protocol_invalid', 'Agent Host 返回了无效的会话事件。')
        return
      }
      emit(this.#events, message.event)
    } else if (message.kind === 'result' || message.kind === 'error') {
      if (typeof message.commandId !== 'string') return
      const pending = this.#settle(connection, message.commandId)
      if (!pending) return
      if (message.kind === 'result' && message.type === pending.type && 'result' in message) {
        pending.resolve(message.result)
      } else if (message.kind === 'error' && isObject(message.error)
        && typeof message.error.code === 'string' && errorCodes.has(message.error.code as DesktopErrorCode)
        && typeof message.error.message === 'string' && message.error.message.length <= 1_000) {
        pending.reject(new HostTransportError(message.error.code as DesktopErrorCode, message.error.message))
      } else {
        this.#log('desktop.host_protocol_invalid', connection.correlationId)
        pending.reject(new HostTransportError('INTERNAL', 'Agent Host 返回了无效的命令响应。'))
      }
    }
  }

  #settle(connection: Connection, id: string): PendingRequest | undefined {
    const pending = connection.pending.get(id)
    if (pending) {
      connection.pending.delete(id)
      clearTimeout(pending.timer)
    }
    return pending
  }

  #rejectPending(connection: Connection, error: HostTransportError): void {
    for (const id of connection.pending.keys()) this.#settle(connection, id)?.reject(error)
  }

  #fail(connection: Connection, code: DiagnosticCode, reason: string): void {
    if (this.#connection !== connection || connection.state === 'stopping') return
    connection.state = 'stopping'
    connection.failure = reason
    this.#log(code, connection.correlationId)
    clearTimeout(connection.startupTimer)
    this.#rejectPending(connection, unavailable(reason))
    connection.child.kill()
    this.#setStatus('offline', reason)
    connection.resolveReady(this.#status)
  }

  #closed(connection: Connection, code: number | null): void {
    connection.resolveClosed()
    if (this.#connection !== connection) return
    this.#connection = undefined
    clearTimeout(connection.startupTimer)
    this.#log(connection.failure || connection.state !== 'stopping' || code !== 0
      ? 'desktop.host_crashed' : 'desktop.host_exited', connection.correlationId)
    const message = connection.failure ?? (connection.state === 'stopping' ? undefined
      : code === null ? 'Agent Host 意外退出。' : 'Agent Host 已退出（代码 ' + code + '）。')
    this.#rejectPending(connection, unavailable(message))
    this.#setStatus('offline', message)
    connection.resolveReady(this.#status)
  }

  #setStatus(state: DesktopHostStatus['state'], message?: string): void {
    if (state === this.#status.state && message === this.#status.message) return
    this.#status = { state, mode: this.#options.mode, ...(message ? { message } : {}) }
    emit(this.#statuses, this.#status)
  }

  #log(code: DiagnosticCode, correlationId: string): void {
    try {
      this.#options.diagnostic?.(diagnostic(code, correlationId))
    } catch {
      // Diagnostics cannot break the Host transport.
    }
  }
}

export function spawnAgentHost(options: {
  executable: string
  root: string
  data: string
  defaultWorkspace: string
  mode: 'pi' | 'faux'
}): ChildProcessWithoutNullStreams {
  const env: NodeJS.ProcessEnv = {
    ...process.env, ELECTRON_RUN_AS_NODE: '1', ZLO_AGENT_DEFAULT_WORKSPACE: options.defaultWorkspace,
  }
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RENDERER_URL', 'ELECTRON_ENABLE_LOGGING']) {
    delete env[name]
  }
  if (options.mode === 'faux') {
    for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GEMINI_API_KEY',
      'DEEPSEEK_API_KEY', 'ZLO_AGENT_MODEL_PROVIDER', 'ZLO_AGENT_MODEL_ID']) delete env[name]
  }
  return spawn(options.executable, [
    '--disable-warning=ExperimentalWarning', join(options.root, 'src', 'cli.ts'),
    '--' + options.mode, '--data', options.data,
  ], { cwd: options.root, windowsHide: true, stdio: 'pipe', env })
}
