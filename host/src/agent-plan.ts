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
  route: {
    type: 'object', additionalProperties: false, required: ['provider', 'model'],
    properties: { provider: { ...string, maxLength: 80 }, model: { ...string, maxLength: 200 } },
  },
}

export function delegationTool(name: 'delegate_task' | 'delegate_worker', execute: (
  id: string, proposal: Omit<NodeProposal, 'ref'>, signal?: AbortSignal,
) => Promise<unknown>): ExecutionTool {
  return {
    name,
    description: 'Run a temporary worker and return its delivery evidence. Describe the goal and acceptance check. Omitted access is read-only. Workspace read, search, read-only Git, and tier-appropriate tools inherit automatically unless narrowed with tools or disallowedTools. Shell execution, Git mutations, web access, browser interaction, and export require explicit tool listing and trusted/write access as applicable.',
    parameters: { type: 'object', additionalProperties: false, required: ['goal'], properties: { goal, check: verificationCheckSchema, ...grant } },
    execute(id, input, signal) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || !('goal' in input) ||
        typeof input.goal !== 'string' || input.goal.length > 8000 || !input.goal.trim() ||
        Object.keys(input).some(key => key !== 'goal' && key !== 'check' && !Object.hasOwn(grant, key)) ||
        !isValidVerificationCheck((input as { check?: unknown }).check)) {
        return Promise.resolve({ ok: false, error: 'Expected a worker goal and an optional narrower grant' })
      }
      return execute(id, input as Omit<NodeProposal, 'ref'>, signal)
    },
  }
}

export function planTool(execute: (id: string, proposals: NodeProposal[], signal?: AbortSignal) => Promise<unknown>): ExecutionTool {
  return {
    name: 'propose_task_plan',
    description: 'Execute a bounded task DAG. Use local refs in dependencies. Parallel write nodes each require a distinct approved git_worktree ID. Use a stable teamKey for persistent specialists and explicit write access for coding nodes. Verification check accepts { path, contains? } or { command: { command, path, args? } } for trusted nodes.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['nodes'],
      properties: { nodes: { type: 'array', minItems: 1, maxItems: 8, items: {
        type: 'object', additionalProperties: false, required: ['ref', 'goal'], properties,
      } } },
    },
    execute(id, input, signal) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || !('nodes' in input) || !Array.isArray(input.nodes) ||
        input.nodes.some(node => !node || typeof node !== 'object' || Array.isArray(node) ||
          !isValidVerificationCheck((node as { check?: unknown }).check))) {
        return Promise.resolve({ ok: false, error: 'Expected a bounded node plan' })
      }
      return execute(id, input.nodes, signal)
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
  return nodes.map(({ id, status, result, verification }) => ({ nodeId: id, status, result, verification }))
}
