import type { ExecutionTool } from './execution.ts'
import type { NodeProposal, WorkerNode } from './task-engine.ts'

const string = { type: 'string' }
const ref = { ...string, maxLength: 100 }
const goal = { ...string, minLength: 1, maxLength: 8000 }
const dependencies = { type: 'array', maxItems: 16, items: ref }
const fileCheck = {
  type: 'object', additionalProperties: false, required: ['path'],
  properties: { path: { ...string, maxLength: 512 }, contains: { ...string, maxLength: 16000 } },
}
const grant = {
  access: { type: 'string', enum: ['read', 'write', 'trusted'] },
  scopePath: { ...string, maxLength: 512 },
  tools: { type: 'array', maxItems: 128, uniqueItems: true, items: { ...string, maxLength: 64 } },
  budget: { type: 'object', additionalProperties: false, properties: {
    tokens: { type: 'integer', minimum: 1, maximum: 10_000_000 },
    requests: { type: 'integer', minimum: 1, maximum: 512 },
    timeMs: { type: 'integer', minimum: 1, maximum: 3_600_000 },
  } },
}
const properties = {
  ref, goal, dependencies, check: fileCheck, ...grant,
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
    description: 'Run a temporary worker and return its delivery evidence. Describe the goal and acceptance check. Omitted access is read-only. To delegate Shell, Browser, Network, Git or other privileged work, name the exact tools and request the necessary workspace access. Shell and Git require a trusted whole workspace. Optional budgets can narrow the parent budget.',
    parameters: { type: 'object', additionalProperties: false, required: ['goal'], properties: { goal, check: fileCheck, ...grant } },
    execute(id, input, signal) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || !('goal' in input) ||
        typeof input.goal !== 'string' || input.goal.length > 8000 || !input.goal.trim() ||
        Object.keys(input).some(key => key !== 'goal' && key !== 'check' && !Object.hasOwn(grant, key))) {
        return Promise.resolve({ ok: false, error: 'Expected a worker goal and an optional narrower grant' })
      }
      return execute(id, input as Omit<NodeProposal, 'ref'>, signal)
    },
  }
}

export function planTool(execute: (id: string, proposals: NodeProposal[], signal?: AbortSignal) => Promise<unknown>): ExecutionTool {
  return {
    name: 'propose_task_plan',
    description: 'Execute a bounded task DAG. Use local refs in dependencies. Parallel write nodes each require a distinct approved git_worktree ID. Use a stable teamKey for persistent specialists and explicit write access for coding nodes.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['nodes'],
      properties: { nodes: { type: 'array', minItems: 1, maxItems: 8, items: {
        type: 'object', additionalProperties: false, required: ['ref', 'goal'], properties,
      } } },
    },
    execute(id, input, signal) {
      if (!input || typeof input !== 'object' || !('nodes' in input) || !Array.isArray(input.nodes)) {
        return Promise.resolve({ ok: false, error: 'Expected a bounded node plan' })
      }
      return execute(id, input.nodes, signal)
    },
  }
}

export function replanTool(execute: (
  id: string, nodeId: string, update: { goal?: string; dependencies?: string[] }, signal?: AbortSignal,
) => Promise<unknown>): ExecutionTool {
  return {
    name: 'replan_task_node',
    description: 'Revise or retry one failed DAG node using its persisted node ID. Confirmed writes and unknown operations cannot be automatically replayed.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['nodeId'],
      properties: { nodeId: ref, goal, dependencies },
    },
    execute(id, input, signal) {
      if (!input || typeof input !== 'object' || !('nodeId' in input) || typeof input.nodeId !== 'string') {
        return Promise.resolve({ ok: false, error: 'Expected a persisted node ID' })
      }
      const { nodeId, goal, dependencies } = input as { nodeId: string; goal?: string; dependencies?: string[] }
      return execute(id, nodeId, { goal, dependencies }, signal)
    },
  }
}

export function handoffs(nodes: WorkerNode[]) {
  return nodes.map(({ id, status, result, verification }) => ({ nodeId: id, status, result, verification }))
}
