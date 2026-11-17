import type { ExecutionTool } from './execution.ts'
import type { NodeProposal, NodeReplan, WorkerNode } from './task-engine.ts'

const string = { type: 'string' }
const ref = { ...string, maxLength: 100 }
const goal = { ...string, minLength: 1, maxLength: 8000 }
const dependencies = { type: 'array', maxItems: 64, items: ref }
const inspectViews = ['active', 'team_summaries', 'node_detail', 'evidence', 'history_page'] as const
export type DagInspectView = (typeof inspectViews)[number]
export interface DagInspectQuery {
  view: DagInspectView
  teamNodeId?: string
  nodeId?: string
  evidenceRef?: string
  parentNodeId?: string
  afterOrdinal?: number
  limit?: number
}
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
    description: 'Execute a dynamically extensible task DAG (up to 64 nodes per batch, repeatable across waves). Use local refs in dependencies. Parallel write nodes each require a distinct approved git_worktree ID, while multiple read nodes run in parallel automatically. Use a stable teamKey for persistent specialists and explicit write access for coding nodes. Verification check accepts { path, contains? } or { command: { command, path, args? } } for trusted nodes.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['nodes'],
      properties: { nodes: { type: 'array', minItems: 1, maxItems: 64, items: {
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

export function inspectDagTool(execute: (query: DagInspectQuery, signal?: AbortSignal) => Promise<unknown>): ExecutionTool {
  return {
    name: 'inspect_task_dag',
    description: 'On-demand inspection of active DAG nodes, Team stage summaries, full historical node details (including archived nodes), paginated node history, or an execution evidenceRef.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['view'],
      properties: {
        view: { type: 'string', enum: [...inspectViews] },
        teamNodeId: { type: 'string', minLength: 1, maxLength: 100 },
        nodeId: { type: 'string', minLength: 1, maxLength: 100 },
        evidenceRef: { type: 'string', minLength: 1, maxLength: 200 },
        parentNodeId: { type: 'string', minLength: 1, maxLength: 100 },
        afterOrdinal: { type: 'integer', minimum: -1, maximum: 10_000_000 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
    execute(_id, raw, signal) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return Promise.resolve({ ok: false, error: 'Invalid DAG inspection arguments' })
      }
      const input = raw as Record<string, unknown>
      const allowed = new Set(['view', 'teamNodeId', 'nodeId', 'evidenceRef', 'parentNodeId', 'afterOrdinal', 'limit'])
      if (Object.keys(input).some(key => !allowed.has(key))) {
        return Promise.resolve({ ok: false, error: 'Unsupported DAG inspection argument' })
      }
      if (typeof input.view !== 'string' || !(inspectViews as readonly string[]).includes(input.view)) {
        return Promise.resolve({ ok: false, error: 'Invalid DAG inspection view' })
      }
      for (const field of ['teamNodeId', 'nodeId', 'evidenceRef', 'parentNodeId'] as const) {
        const val = input[field]
        if (val !== undefined && (typeof val !== 'string' || !val.trim() || val.length > 200)) {
          return Promise.resolve({ ok: false, error: `Invalid ${field}` })
        }
      }
      if (input.afterOrdinal !== undefined &&
        (typeof input.afterOrdinal !== 'number' || !Number.isSafeInteger(input.afterOrdinal) || input.afterOrdinal < -1 || input.afterOrdinal > 10_000_000)) {
        return Promise.resolve({ ok: false, error: 'Invalid afterOrdinal cursor' })
      }
      if (input.limit !== undefined &&
        (typeof input.limit !== 'number' || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)) {
        return Promise.resolve({ ok: false, error: 'Invalid page limit' })
      }
      return execute({
        view: input.view as DagInspectView,
        ...(typeof input.teamNodeId === 'string' ? { teamNodeId: input.teamNodeId } : {}),
        ...(typeof input.nodeId === 'string' ? { nodeId: input.nodeId } : {}),
        ...(typeof input.evidenceRef === 'string' ? { evidenceRef: input.evidenceRef } : {}),
        ...(typeof input.parentNodeId === 'string' ? { parentNodeId: input.parentNodeId } : {}),
        ...(typeof input.afterOrdinal === 'number' ? { afterOrdinal: input.afterOrdinal } : {}),
        ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      }, signal)
    },
  }
}

export function handoffs(nodes: WorkerNode[]) {
  return nodes.map(({ id, status, result, verification }) => ({ nodeId: id, status, result, verification }))
}
