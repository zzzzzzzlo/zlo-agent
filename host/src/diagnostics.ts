import { writeHostDiagnostic } from '../../shared/diagnostics.ts'
import type { HostDiagnosticCode } from '../../shared/diagnostics.ts'
import type { AgentEvent, LocalStore } from './store.ts'

function codeFor(event: AgentEvent): HostDiagnosticCode | undefined {
  switch (event.type) {
    case 'tool.started': return 'host.tool_started'
    case 'tool.finished':
      switch (event.payload.status) {
        case 'succeeded': return 'host.tool_completed'
        case 'interrupted': return 'host.tool_interrupted'
        case 'unknown_effect': return 'host.tool_unconfirmed'
        default: return 'host.tool_failed'
      }
    case 'operation.reconciliation_required': return 'host.recovery_blocked'
    case 'task.state_changed':
      if (event.payload.reason === 'runtime_error') return 'host.runtime_failed'
  }
}

export function installTaskDiagnostics(store: LocalStore): void {
  store.projectEvents((event) => {
    const code = codeFor(event)
    if (!code) return
    store.onTransactionSettled((committed) => {
      if (committed) writeHostDiagnostic(code, event.agentRunId ?? event.taskRunId ?? event.taskId)
    })
  })
}
