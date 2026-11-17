import { nodeFailureReason } from './agent-mailbox.ts'
import type { ExecutionTool } from './execution.ts'
import type { NodeProposal, NodeReplan, WorkerNode } from './task-engine.ts'

const string = { type: 'string' }
const ref = { ...string, maxLength: 100 }
const goal = { ...string, minLength: 1, maxLength: 8000 }
const dependencies = { type: 'array', maxItems: 16, items: ref }
type CommandName = NonNullable<NonNullable<NodeProposal['check']>['command']>['command']
const commandNames: readonly CommandName[] = ['npm_test', 'npm_build', 'npm_lint', 'npm_typecheck', 'node_script']
const fileCheck = {
  type: 'object', additionalProperties: false, required: ['path'],
  properties: { path: { ...string, minLength: 1, maxLength: 512 }, contains: { ...string, minLength: 1, maxLength: 16000 } },
}
const commandCheck = {
  type: 'object', additionalProperties: false, required: ['command'],
  properties: {
    command: {
      type: 'object', additionalProperties: false, required: ['command', 'path'],
      properties: {
        command: { type: 'string', enum: [...commandNames] },
        path: { ...string, minLength: 1, maxLength: 512 },
        args: { type: 'array', maxItems: 16, items: { ...string, maxLength: 512 } },
      },
    },
  },
}
const verificationCheckSchema = { anyOf: [fileCheck, commandCheck] }

function isValidVerificationCheck(value: unknown): boolean {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if ('command' in value && value.command !== undefined) {
    if (Object.keys(value).length !== 1) return false
    const cmd = value.command
    if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) return false
    if (Object.keys(cmd).some(key => key !== 'command' && key !== 'path' && key !== 'args')) return false
    const command = (cmd as { command?: unknown }).command
    const path = (cmd as { path?: unknown }).path
    const args = (cmd as { args?: unknown }).args
    if (typeof command !== 'string' || !(commandNames as readonly string[]).includes(command)) return false
    if (typeof path !== 'string' || !path.trim() || path.length > 512) return false
    if (args !== undefined && (!Array.isArray(args) || args.length > 16 ||
      args.some(arg => typeof arg !== 'string' || arg.length > 512 || arg.includes('\0')))) return false
    return true
  }
  if (Object.keys(value).some(key => key !== 'path' && key !== 'contains')) return false
  const path = (value as { path?: unknown }).path
  const contains = (value as { contains?: unknown }).contains
  if (typeof path !== 'string' || !path.trim() || path.length > 512) return false
  if (contains !== undefined && (typeof contains !== 'string' || !contains.trim() || contains.length > 16000)) return false
  return true
}

const routeSchema = {
  type: 'object', additionalProperties: false, required: ['provider', 'model'],
  properties: { provider: { ...string, maxLength: 80 }, model: { ...string, maxLength: 200 } },
}

const grant = {
  access: { type: 'string', enum: ['read', 'write', 'trusted'] },
  scopePath: { ...string, maxLength: 512 },
  tools: { type: 'array', maxItems: 128, uniqueItems: true, items: { ...string, maxLength: 64 } },
  disallowedTools: { type: 'array', maxItems: 128, uniqueItems: true, items: { ...string, maxLength: 64 } },
  budget: { type: 'object', additionalProperties: false, properties: {
    requests: { type: 'integer', minimum: 1, maximum: 512 },
    timeMs: { type: 'integer', minimum: 1, maximum: 3_600_000 },
  } },
}
const properties = {
  ref, goal, dependencies, check: verificationCheckSchema, ...grant,
  role: { type: 'string', enum: ['worker', 'team'] },
  teamKey: { ...string, maxLength: 64 },
  worktreeId: { ...string, maxLength: 36 },
  route: routeSchema,
}

export type DelegationInput = Omit<NodeProposal, 'ref'> & { wait?: boolean }
export type PlanWaitMode = 'all' | 'any' | 'none'

export function delegationTool(name: 'delegate_task' | 'delegate_worker', execute: (
  id: string, proposal: DelegationInput, signal?: AbortSignal,
) => Promise<unknown>): ExecutionTool {
  return {
    name,
    description: 'Run a temporary worker and return its delivery evidence (or launch asynchronously with wait: false). Describe the goal and acceptance check. Omitted access inherits write access from a write-authorized parent or read-only from a read-only parent; pass access: "read" to narrow explicitly. Fresh workers can run on any authorized route.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['goal'],
      properties: { goal, check: verificationCheckSchema, ...grant, route: routeSchema, wait: { type: 'boolean' } },
    },
    execute(id, input, signal) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || !('goal' in input) ||
        typeof input.goal !== 'string' || input.goal.length > 8000 || !input.goal.trim() ||
        Object.keys(input).some(key => key !== 'goal' && key !== 'check' && key !== 'route' && key !== 'wait' && !Object.hasOwn(grant, key)) ||
        ('wait' in input && input.wait !== undefined && typeof input.wait !== 'boolean') ||
        !isValidVerificationCheck((input as { check?: unknown }).check)) {
        return Promise.resolve({ ok: false, error: 'Expected a worker goal and an optional narrower grant' })
      }
      return execute(id, input as DelegationInput, signal)
    },
  }
}

export function planTool(execute: (
  id: string, proposals: NodeProposal[], waitMode: PlanWaitMode, signal?: AbortSignal,
) => Promise<unknown>): ExecutionTool {
  return {
    name: 'propose_task_plan',
    description: 'Submit a bounded task DAG and start event-driven scheduling. Parallel write nodes each require a distinct approved git_worktree ID. Use wait: "none" (or false) to continue working and handle completions via wait_task_nodes or mailbox events, wait: "any" to wake on first node completion, or omit wait to await all submitted nodes.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['nodes'],
      properties: {
        nodes: { type: 'array', minItems: 1, maxItems: 8, items: {
          type: 'object', additionalProperties: false, required: ['ref', 'goal'], properties,
        } },
        wait: { oneOf: [{ type: 'string', enum: ['all', 'any', 'none'] }, { type: 'boolean' }] },
      },
    },
    execute(id, input, signal) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || !('nodes' in input) || !Array.isArray(input.nodes) ||
        Object.keys(input).some(key => key !== 'nodes' && key !== 'wait') ||
        input.nodes.some(node => !node || typeof node !== 'object' || Array.isArray(node) ||
          !isValidVerificationCheck((node as { check?: unknown }).check))) {
        return Promise.resolve({ ok: false, error: 'Expected a bounded node plan' })
      }
      const rawWait = (input as { wait?: unknown }).wait
      const waitMode: PlanWaitMode = rawWait === false || rawWait === 'none' ? 'none'
        : rawWait === 'any' ? 'any' : 'all'
      if (rawWait !== undefined && typeof rawWait !== 'boolean' && rawWait !== 'all' && rawWait !== 'any' && rawWait !== 'none') {
        return Promise.resolve({ ok: false, error: 'Invalid wait mode' })
      }
      return execute(id, input.nodes, waitMode, signal)
    },
  }
}

export function waitNodesTool(execute: (
  id: string, input: { nodeIds?: string[]; mode: 'any' | 'all'; timeoutMs?: number }, signal?: AbortSignal,
) => Promise<unknown>): ExecutionTool {
  return {
    name: 'wait_task_nodes',
    description: 'Wait for scheduled child/DAG nodes to complete or fail and return their updated states, artifacts, evidence, and failure details.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        nodeIds: { type: 'array', maxItems: 16, items: ref },
        mode: { type: 'string', enum: ['any', 'all'] },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 300_000 },
      },
    },
    execute(id, input, signal) {
      const obj = (input ?? {}) as Record<string, unknown>
      if (!obj || typeof obj !== 'object' || Array.isArray(obj) ||
        Object.keys(obj).some(key => key !== 'nodeIds' && key !== 'mode' && key !== 'timeoutMs')) {
        return Promise.resolve({ ok: false, error: 'Invalid wait parameters' })
      }
      if (obj.nodeIds !== undefined && (!Array.isArray(obj.nodeIds) || obj.nodeIds.length > 16 ||
        obj.nodeIds.some(item => typeof item !== 'string' || !item.length || item.length > 100))) {
        return Promise.resolve({ ok: false, error: 'Invalid nodeIds' })
      }
      const mode = obj.mode === undefined ? 'any' : obj.mode
      if (mode !== 'any' && mode !== 'all') return Promise.resolve({ ok: false, error: 'Invalid wait mode' })
      if (obj.timeoutMs !== undefined && (typeof obj.timeoutMs !== 'number' || !Number.isSafeInteger(obj.timeoutMs) ||
        obj.timeoutMs < 1 || obj.timeoutMs > 300_000)) {
        return Promise.resolve({ ok: false, error: 'Invalid timeoutMs' })
      }
      return execute(id, {
        nodeIds: obj.nodeIds as string[] | undefined,
        mode,
        timeoutMs: obj.timeoutMs as number | undefined,
      }, signal)
    },
  }
}

export function inspectNodesTool(execute: (
  id: string, input: { nodeIds?: string[] }, signal?: AbortSignal,
) => Promise<unknown>): ExecutionTool {
  return {
    name: 'get_task_nodes',
    description: 'Read the latest persisted DAG node states, dependencies, execution results, failure reasons, and verification evidence in your scope.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        nodeIds: { type: 'array', maxItems: 16, items: ref },
      },
    },
    execute(id, input, signal) {
      const obj = (input ?? {}) as Record<string, unknown>
      if (!obj || typeof obj !== 'object' || Array.isArray(obj) ||
        Object.keys(obj).some(key => key !== 'nodeIds')) {
        return Promise.resolve({ ok: false, error: 'Invalid inspection parameters' })
      }
      if (obj.nodeIds !== undefined && (!Array.isArray(obj.nodeIds) || obj.nodeIds.length > 16 ||
        obj.nodeIds.some(item => typeof item !== 'string' || !item.length || item.length > 100))) {
        return Promise.resolve({ ok: false, error: 'Invalid nodeIds' })
      }
      return execute(id, { nodeIds: obj.nodeIds as string[] | undefined }, signal)
    },
  }
}

export function replanTool(execute: (
  id: string, nodeId: string, update: NodeReplan, signal?: AbortSignal,
) => Promise<unknown>): ExecutionTool {
  return {
    name: 'replan_task_node',
    description: 'Revise or retry one failed DAG node using its persisted node ID. Confirmed writes and unknown operations cannot be automatically replayed. Verification check accepts { path, contains? } or { command: { command, path, args? } } for trusted nodes.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['nodeId'],
      properties: { nodeId: ref, goal, dependencies, check: verificationCheckSchema },
    },
    execute(id, input, signal) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || !('nodeId' in input) || typeof input.nodeId !== 'string' ||
        Object.keys(input).some(key => key !== 'nodeId' && key !== 'goal' && key !== 'dependencies' && key !== 'check') ||
        !isValidVerificationCheck((input as { check?: unknown }).check)) {
        return Promise.resolve({ ok: false, error: 'Expected a persisted node ID' })
      }
      const { nodeId, goal, dependencies, check } = input as {
        nodeId: string; goal?: string; dependencies?: string[]; check?: NodeReplan['check']
      }
      return execute(id, nodeId, {
        ...(goal !== undefined ? { goal } : {}),
        ...(dependencies !== undefined ? { dependencies } : {}),
        ...(check !== undefined ? { check } : {}),
      }, signal)
    },
  }
}

export function handoffs(nodes: WorkerNode[]) {
  return nodes.map(node => {
    const failureReason = nodeFailureReason(node)
    return {
      nodeId: node.id,
      parentNodeId: node.parentNodeId,
      role: node.role ?? 'worker',
      status: node.status,
      dependencies: node.dependencies,
      ...(failureReason ? { failureReason } : {}),
      result: node.result,
      verification: node.verification,
    }
  })
}
