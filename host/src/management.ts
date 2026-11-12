import type { AgentPreferences, ManagedOperation, ManagedTask, ManagedTool, ProviderId } from '../../shared/contracts/management.ts'
import type { ConversationSummary } from '../../shared/contracts/desktop.ts'
import { verificationVerdict } from '../../shared/contracts/domain.ts'
import type { WorkspaceAccess } from '../../shared/contracts/domain.ts'
import { ConversationError, parseRoute } from './conversation.ts'
import type { AgentEvent } from './contracts/domain.ts'
import type { CodingCapabilities, ExtensionRegistry } from './policies.ts'
import type { Operation, TaskSnapshot } from './task-engine.ts'
import type { CodingWorkspace } from './workspace.ts'
import { redactProcessOutput } from './workspace-process.ts'

export const providers: readonly ProviderId[] = ['openai', 'anthropic', 'google', 'deepseek']
export const managementEventTypes = [
  'agent.started', 'agent.finished', 'model.route_changed', 'tool.approval_resolved', 'tool.started', 'model.usage', 'memory.recalled',
] as const
export function providerId(value: unknown): ProviderId {
  if (typeof value !== 'string' || !providers.includes(value as ProviderId)) invalid('Unknown provider')
  return value as ProviderId
}

function invalid(message: string): never {
  throw new ConversationError('INVALID_INPUT', message)
}

export function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(value)) invalid('Invalid record identifier')
  return value
}

export function access(value: unknown): WorkspaceAccess {
  if (value !== 'read' && value !== 'write' && value !== 'trusted') invalid('Unknown workspace permission')
  return value
}

export function inputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Invalid management request')
  return value as Record<string, unknown>
}

export function preferences(value: unknown): AgentPreferences {
  const input = inputRecord(value)
  const { disabledTools, modelSelection, searchProvider } = input
  if (modelSelection !== 'automatic' && modelSelection !== 'fixed') invalid('Invalid model selection policy')
  if (searchProvider !== 'hacker_news' && searchProvider !== 'brave' && searchProvider !== 'disabled') invalid('Unknown search provider')
  if (!Array.isArray(disabledTools) || disabledTools.length > 128 ||
    disabledTools.some(name => typeof name !== 'string' || !/^[a-z][a-z_0-9]{0,63}$/u.test(name))) invalid('Invalid tool preferences')
  const defaultRoute = input.defaultRoute === null ? null : parseRoute(input.defaultRoute)
  if (modelSelection === 'fixed' && !defaultRoute) invalid('Choose a default model for fixed selection')
  return { workspaceAccess: access(input.workspaceAccess), defaultRoute, modelSelection,
    disabledTools: [...new Set<string>(disabledTools)].sort(), searchProvider }
}

export function memoryIds(value: unknown): Set<string> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 96 ||
    value.some(id => typeof id !== 'string' || !/^[a-f\d]{64}$/u.test(id))) invalid('Invalid memory record identifiers')
  return new Set<string>(value)
}

export function operationId(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024 || /[\p{Cc}\p{Cf}]/u.test(value)) invalid('Invalid operation identifier')
  return value
}

export function toolCatalog(extensions: ReturnType<ExtensionRegistry['resolve']>, capabilities: CodingCapabilities,
  workspace: CodingWorkspace, rootAccess: WorkspaceAccess, enabled: (name: string) => boolean): ManagedTool[] {
  const rootScope = capabilities.root(rootAccess, false)
  const roles = ['root', 'team', 'worker'] as const
  const catalog = new Map<string, ManagedTool>()
  for (const role of roles) {
    for (const { plugin, tool } of extensions.catalog(workspace, role, 'trusted')) {
      const entry = catalog.get(tool.name) ?? {
        name: tool.name, plugin, effect: tool.effect, approval: Boolean(tool.policy?.approval || tool.policy?.approvalFor), enabled: enabled(tool.name),
        root: false, team: false, worker: false,
      }
      if (entry.enabled && capabilities.enabled(tool.name)) {
        const scope = role === 'root' ? rootScope : capabilities.child(rootScope, rootScope.access, undefined, role, [tool.name])
        entry[role] = capabilities.describe(scope, tool)
      }
      catalog.set(tool.name, entry)
    }
  }
  if (extensions.profile.delegation) {
    for (const name of ['delegate_task', 'delegate_worker', 'propose_task_plan', 'replan_task_node']) {
      const enabledHere = enabled(name)
      catalog.set(name, { name, plugin: 'collaboration', effect: 'read', approval: false, enabled: enabledHere,
        root: enabledHere && name !== 'delegate_worker', team: enabledHere && name === 'delegate_worker', worker: false })
    }
  }
  return [...catalog.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export function managedOperation(operation: Operation, approval?: string): ManagedOperation {
  return {
    id: operation.id, tool: operation.tool, status: operation.status, nodeId: operation.taskNodeId, approval,
    ...(operation.target ? { target: redactProcessOutput(operation.target) } : {}),
    ...(operation.reconciliation ? { reconciliation: operation.reconciliation } : {}),
  }
}

export function taskView(task: TaskSnapshot, events: AgentEvent[], operations: Operation[],
  rootAccess: WorkspaceAccess, budget: ManagedTask['budget']): ManagedTask {
  const agents = new Map<string, ManagedTask['agents'][number]>()
  const approvals = new Map<string, ManagedOperation>()
  const operationOrder = new Map<string, number>()
  const toolsByNode = new Map<string, Set<string>>()
  const usage: ManagedTask['usage'] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const event of events) {
    const { payload, agentRunId, taskNodeId, parentAgentRunId } = event
    if (event.type === 'agent.started' && agentRunId && taskNodeId &&
      (payload.role === 'root' || payload.role === 'team' || payload.role === 'worker')) {
      agents.set(agentRunId, { id: agentRunId, nodeId: taskNodeId, parentId: parentAgentRunId,
        role: payload.role, status: 'active', route: payload.route as ManagedTask['agents'][number]['route'] })
    } else if (event.type === 'agent.finished' && agentRunId) {
      const agent = agents.get(agentRunId)
      if (agent && typeof payload.status === 'string') agent.status = payload.status
    } else if (event.type === 'model.route_changed' && agentRunId && agents.has(agentRunId)) {
      agents.get(agentRunId)!.route = payload.route as ManagedTask['agents'][number]['route']
    } else if (event.type === 'tool.approval_resolved' && typeof payload.id === 'string' && typeof payload.tool === 'string') {
      operationOrder.set(payload.id, event.seq)
      approvals.set(payload.id, { id: payload.id, tool: payload.tool, status: 'approval_only',
        approval: payload.approved === true ? 'approved' : 'denied', nodeId: taskNodeId })
    } else if (event.type === 'tool.started' && typeof payload.id === 'string') {
      operationOrder.set(payload.id, event.seq)
    } else if (event.type === 'model.usage') {
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
        if (typeof payload[key] === 'number') usage[key] += payload[key]
      }
      if (typeof payload.estimatedCostUsd === 'number' && Number.isFinite(payload.estimatedCostUsd)) {
        usage.estimatedCostUsd = (usage.estimatedCostUsd ?? 0) + payload.estimatedCostUsd
      }
    }
  }
  const receipts = operations.map(operation => {
    const approval = approvals.get(operation.id)?.approval
    approvals.delete(operation.id)
    const node = operation.taskNodeId ?? task.rootNodeId
    if (!toolsByNode.has(node)) toolsByNode.set(node, new Set())
    toolsByNode.get(node)!.add(operation.tool)
    return managedOperation(operation, approval)
  })
  const verification = task.verification && { ...task.verification, verdict: verificationVerdict(task.verification) }
  const routeFor = (node: string) => [...agents.values()].reverse().find(run => run.nodeId === node)?.route
  const allReceipts = [...receipts, ...approvals.values()].sort((a, b) => (operationOrder.get(b.id) ?? 0) - (operationOrder.get(a.id) ?? 0))
  const unknown = allReceipts.filter(item => item.status === 'unknown_effect')
  return {
    taskId: task.id, rootNodeId: task.rootNodeId, status: task.status, reason: task.reconciliationBlock ?? task.reason, verification, usage, budget,
    nodes: [
      { id: task.rootNodeId, role: 'root', goal: task.goal, status: task.status, dependencies: [], access: rootAccess,
        route: routeFor(task.rootNodeId) ?? task.route, verification, tools: [...(toolsByNode.get(task.rootNodeId) ?? [])] },
      ...[...(task.worker ? [task.worker] : []), ...(task.nodes ?? [])].map(node => ({
        id: node.id, role: node.role ?? 'worker' as const, goal: node.goal, status: node.status,
        parentNodeId: node.parentNodeId, dependencies: node.dependencies,
        access: rootAccess === 'read' ? 'read' : node.access === 'trusted' && rootAccess === 'write' ? 'write' : (node.access ?? 'read'),
        scopePath: node.scopePath, route: routeFor(node.id) ?? node.route, verification: node.verification,
        result: node.result && redactProcessOutput(node.result.summary), tools: [...(toolsByNode.get(node.id) ?? [])],
      })),
    ],
    agents: [...agents.values()], operations: [...unknown,
      ...allReceipts.filter(item => item.status !== 'unknown_effect').slice(0, Math.max(0, 150 - unknown.length))],
  }
}

export function conversationScope(conversation: ConversationSummary, provider: string): string {
  return JSON.stringify([conversation.id, provider])
}
