import { randomUUID } from 'node:crypto'

type DiagnosticLevel = 'info' | 'warn' | 'error'
type DiagnosticModule = 'host' | 'desktop'
type DiagnosticCategory = 'process' | 'protocol' | 'model' | 'tool' | 'recovery' | 'runtime'
type Definition = readonly [DiagnosticLevel, DiagnosticModule, DiagnosticCategory, string]

const definitions = {
  'desktop.host_starting': ['info', 'desktop', 'process', 'Starting the local Agent Host.'],
  'desktop.host_ready': ['info', 'desktop', 'process', 'The local Agent Host is ready.'],
  'desktop.host_exited': ['info', 'desktop', 'process', 'The local Agent Host exited.'],
  'desktop.host_crashed': ['error', 'desktop', 'process', 'The local Agent Host exited unexpectedly.'],
  'desktop.host_spawn_failed': ['error', 'desktop', 'process', 'The local Agent Host could not be started.'],
  'desktop.host_startup_timeout': ['error', 'desktop', 'process', 'The local Agent Host exceeded its startup deadline.'],
  'desktop.host_shutdown_timeout': ['warn', 'desktop', 'process', 'The local Agent Host exceeded its shutdown deadline.'],
  'desktop.host_channel_failed': ['error', 'desktop', 'protocol', 'An Agent Host transport channel failed.'],
  'desktop.host_protocol_invalid': ['error', 'desktop', 'protocol', 'An Agent Host protocol frame was rejected.'],
  'desktop.host_request_timeout': ['warn', 'desktop', 'protocol', 'An Agent Host request exceeded its deadline.'],
  'desktop.host_stderr_ignored': ['warn', 'desktop', 'protocol', 'Non-diagnostic Agent Host stderr was discarded.'],
  'host.startup_failed': ['error', 'host', 'process', 'The Agent Host failed to initialize.'],
  'host.startup_config_invalid': ['error', 'host', 'process', 'The Agent Host startup configuration was invalid.'],
  'host.startup_runtime_failed': ['error', 'host', 'process', 'The configured Agent execution runtime could not load.'],
  'host.startup_storage_failed': ['error', 'host', 'process', 'The Agent Host could not open or recover its local store.'],
  'host.shutdown_failed': ['error', 'host', 'process', 'The Agent Host failed to shut down cleanly.'],
  'host.protocol_rejected': ['warn', 'host', 'protocol', 'The Agent Host rejected a protocol command.'],
  'host.model_unavailable': ['warn', 'host', 'model', 'A model route was unavailable.'],
  'host.model_started': ['info', 'host', 'model', 'A model request started.'],
  'host.model_completed': ['info', 'host', 'model', 'A model request completed.'],
  'host.model_failed': ['error', 'host', 'model', 'A model request failed.'],
  'host.model_interrupted': ['warn', 'host', 'model', 'A model request was interrupted.'],
  'host.tool_started': ['info', 'host', 'tool', 'A tool invocation started.'],
  'host.tool_completed': ['info', 'host', 'tool', 'A tool invocation completed.'],
  'host.tool_failed': ['error', 'host', 'tool', 'A tool invocation failed.'],
  'host.tool_interrupted': ['warn', 'host', 'tool', 'A tool invocation was interrupted.'],
  'host.tool_unconfirmed': ['error', 'host', 'tool', 'A tool invocation has an unconfirmed side effect.'],
  'host.runtime_failed': ['error', 'host', 'runtime', 'An Agent Host runtime operation failed.'],
  'host.recovery_blocked': ['warn', 'host', 'recovery', 'A task requires reconciliation before it can be resumed.'],
} as const satisfies Record<string, Definition>

export type DiagnosticCode = keyof typeof definitions
export type HostDiagnosticCode = Extract<DiagnosticCode, `host.${string}`>

export interface DiagnosticEntry {
  schemaVersion: 1
  kind: 'diagnostic'
  time: string
  level: DiagnosticLevel
  module: DiagnosticModule
  category: DiagnosticCategory
  correlationId: string
  code: DiagnosticCode
  summary: string
}

export const maxDiagnosticLineBytes = 1_024
const maxStderrQueueBytes = 16_384
const uuid = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const fields = ['schemaVersion', 'kind', 'time', 'level', 'module', 'category', 'correlationId', 'code', 'summary']

function isCode(code: unknown): code is DiagnosticCode {
  return typeof code === 'string' && Object.hasOwn(definitions, code)
}

function entry(code: DiagnosticCode, time: string, correlationId: string): DiagnosticEntry {
  const [level, module, category, summary] = definitions[code]
  return { schemaVersion: 1, kind: 'diagnostic', time, level, module, category, correlationId, code, summary }
}

export function diagnostic(code: DiagnosticCode, correlationId?: string): DiagnosticEntry {
  if (!isCode(code)) throw new Error('Unknown diagnostic code')
  return entry(code, new Date().toISOString(), correlationId && uuid.test(correlationId) ? correlationId : randomUUID())
}

export function validateDiagnostic(value: unknown): DiagnosticEntry | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return
  if (Object.keys(value).length !== fields.length || !fields.every((field) => Object.hasOwn(value, field))) return
  const item = value as Record<string, unknown>
  if (item.schemaVersion !== 1 || item.kind !== 'diagnostic' || !isCode(item.code)
    || typeof item.time !== 'string' || !isoTime.test(item.time)
    || typeof item.correlationId !== 'string' || !uuid.test(item.correlationId)) return
  const time = new Date(item.time)
  if (!Number.isFinite(time.getTime()) || time.toISOString() !== item.time) return
  const expected = entry(item.code, item.time, item.correlationId)
  if (item.level !== expected.level || item.module !== expected.module
    || item.category !== expected.category || item.summary !== expected.summary) return
  return expected
}

export function parseHostDiagnostic(line: string): DiagnosticEntry | undefined {
  if (Buffer.byteLength(line) > maxDiagnosticLineBytes) return
  try {
    const result = validateDiagnostic(JSON.parse(line))
    return result?.module === 'host' ? result : undefined
  } catch {
    return undefined
  }
}

let stderrObserved = false
let stderrFailed = false

export function writeHostDiagnostic(code: HostDiagnosticCode, correlationId?: string): void {
  try {
    const output = process.stderr
    if (!stderrObserved) {
      stderrObserved = true
      output.on('error', () => { stderrFailed = true })
    }
    if (stderrFailed || !output.writable || output.writableLength >= maxStderrQueueBytes) return
    const item = diagnostic(code, correlationId)
    if (item.module === 'host') output.write(JSON.stringify(item) + '\n')
  } catch {
    // Diagnostics cannot change the outcome of a Host operation.
  }
}
