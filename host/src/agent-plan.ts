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
const properties = {
  ref, goal, dependencies, check: fileCheck,
  role: { type: 'string', enum: ['worker', 'team'] },
  teamKey: { ...string, maxLength: 64 },
  access: { type: 'string', enum: ['read', 'write'] },
  scopePath: { ...string, maxLength: 512 },
  worktreeId: { ...string, maxLength: 36 },
  route: {
    type: 'object', additionalProperties: false, required: ['provider', 'model'],
    properties: { provider: { ...string, maxLength: 80 }, model: { ...string, maxLength: 200 } },
  },
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
