import { memoryKinds } from './contracts/domain.ts'
import type { EventDraft, MemoryKind } from './contracts/domain.ts'
import type { LocalJudgment } from './judgment.ts'
import { memoryEntryInScope } from './memory.ts'
import type { LocalMemory, MemoryCandidate, MemoryEntry } from './memory.ts'
import { withinScopePath, workspaceTarget } from './workspace-path.ts'
import type { CodingWorkspace, WorkspaceTool } from './workspace.ts'

export interface MemoryToolRuntime {
  memory: LocalMemory
  judgment: LocalJudgment
  scopesFor(taskId: string | undefined, workspaceRoot: string, agentRunId?: string): {
    primary: string
    all: string[]
    goal?: string
    event?: EventDraft
    teamKey?: string
    sourceRole?: 'root' | 'team' | 'worker'
    onSaved?: (entry: MemoryEntry) => void
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (memoryKinds as readonly string[]).includes(value)
}

function formatMemoryRow(entry: MemoryEntry) {
  return {
    id: entry.id,
    kind: entry.kind,
    ...(entry.title ? { title: entry.title } : {}),
    text: entry.text,
    ...(entry.paths?.length ? { paths: entry.paths } : {}),
    ...(entry.durable ? { durable: true } : {}),
    ...(entry.taskId ? { taskId: entry.taskId } : {}),
    ...(entry.nodeId ? { nodeId: entry.nodeId } : {}),
    ...(entry.attemptId ? { attemptId: entry.attemptId } : {}),
    ...(entry.evidenceRefs?.length ? { evidenceRefs: entry.evidenceRefs } : {}),
    ...(entry.confidence ? { confidence: entry.confidence } : {}),
    ...(entry.teamKey ? { teamKey: entry.teamKey } : {}),
    ...(entry.sourceRole ? { sourceRole: entry.sourceRole } : {}),
    version: entry.version,
    updatedAt: entry.updatedAt,
  }
}

export function createMemoryTools(workspace: CodingWorkspace, runtime: () => MemoryToolRuntime): WorkspaceTool[] {
  return [
    {
      name: 'memory_search',
      effect: 'read',
      policy: { targets: () => [] },
      description: 'Search accumulated workspace long-term memories (facts, experiences, decisions, contracts, failure patterns, risks, assumptions) using BM25 + subtoken/CJK matching.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 512 },
          limit: { type: 'integer', minimum: 1, maximum: 32 },
          kind: { type: 'string', enum: [...memoryKinds] },
        },
      },
      execute: async (_callId, raw, signal, context) => {
        signal?.throwIfAborted()
        const input = record(raw)
        if (!input || typeof input.query !== 'string' || !input.query.trim() || input.query.length > 512) {
          return { ok: false, error: 'A non-empty search query is required' }
        }
        if (Object.keys(input).some(key => key !== 'query' && key !== 'limit' && key !== 'kind')) {
          return { ok: false, error: 'Unsupported memory search arguments' }
        }
        const limit = input.limit === undefined ? 12 : input.limit
        if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 32) {
          return { ok: false, error: 'Invalid memory search limit' }
        }
        if (input.kind !== undefined && !isMemoryKind(input.kind)) {
          return { ok: false, error: 'Invalid memory kind filter' }
        }
        const { memory, scopesFor } = runtime()
        const { all } = scopesFor(context?.taskId, workspace.root, context?.agentRunId)
        const pool = memory.recallScopes(all, input.query, limit,
          entry => (!input.kind || entry.kind === input.kind) && memoryEntryInScope(entry, context?.scopePath))
        return {
          ok: true,
          count: pool.length,
          entries: pool.map(formatMemoryRow),
        }
      },
    },
    {
      name: 'memory_list',
      effect: 'read',
      policy: { targets: () => [] },
      description: 'List recent workspace long-term memories sorted by recency.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          kind: { type: 'string', enum: [...memoryKinds] },
        },
      },
      execute: async (_callId, raw, signal, context) => {
        signal?.throwIfAborted()
        const input = raw === undefined ? {} : record(raw)
        if (!input || Object.keys(input).some(key => key !== 'limit' && key !== 'kind')) {
          return { ok: false, error: 'Unsupported memory list arguments' }
        }
        const limit = input.limit === undefined ? 20 : input.limit
        if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
          return { ok: false, error: 'Invalid memory list limit' }
        }
        if (input.kind !== undefined && !isMemoryKind(input.kind)) {
          return { ok: false, error: 'Invalid memory kind filter' }
        }
        const { memory, scopesFor } = runtime()
        const { all } = scopesFor(context?.taskId, workspace.root, context?.agentRunId)
        const entries = memory.listScopes(all,
          entry => (!input.kind || entry.kind === input.kind) && memoryEntryInScope(entry, context?.scopePath))
          .slice(0, limit)
        return {
          ok: true,
          count: entries.length,
          entries: entries.map(formatMemoryRow),
        }
      },
    },
    {
      name: 'memory_save',
      effect: 'read',
      policy: {
        minimumAccess: 'write',
        delegation: 'explicit',
        targets: (raw) => {
          const input = record(raw)
          if (!input || !Array.isArray(input.paths)) return []
          return input.paths.filter((item): item is string => typeof item === 'string')
        },
      },
      description: 'Persist a durable non-secret workspace fact or reusable engineering experience into shared workspace memory.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'text'],
        properties: {
          kind: { type: 'string', enum: ['fact', 'experience'] },
          text: { type: 'string', minLength: 1, maxLength: 16384 },
          key: { type: 'string', minLength: 1, maxLength: 128 },
          title: { type: 'string', minLength: 1, maxLength: 160 },
          paths: { type: 'array', maxItems: 24, items: { type: 'string', minLength: 1, maxLength: 256 } },
          durable: { type: 'boolean' },
        },
      },
      execute: async (callId, raw, signal, context) => {
        signal?.throwIfAborted()
        const input = record(raw)
        if (!input || Object.keys(input).some(key => !['kind', 'text', 'key', 'title', 'paths', 'durable'].includes(key))) {
          return { ok: false, error: 'Invalid memory save arguments' }
        }
        if ((input.kind !== 'fact' && input.kind !== 'experience') || typeof input.text !== 'string' || !input.text.trim()) {
          return { ok: false, error: 'Memory kind and non-empty text are required' }
        }
        if (input.key !== undefined && typeof input.key !== 'string') return { ok: false, error: 'Invalid memory key' }
        if (input.title !== undefined && typeof input.title !== 'string') return { ok: false, error: 'Invalid memory title' }
        if (input.durable !== undefined && typeof input.durable !== 'boolean') return { ok: false, error: 'Invalid durable flag' }
        let normalizedPaths: string[] | undefined
        if (input.paths !== undefined) {
          if (!Array.isArray(input.paths) || input.paths.length > 24) return { ok: false, error: 'Invalid memory paths' }
          normalizedPaths = []
          for (const item of input.paths) {
            if (typeof item !== 'string') return { ok: false, error: 'Invalid memory path item' }
            const resolved = workspaceTarget({ path: item }, 'read')
            if (!resolved || !withinScopePath(context?.scopePath, resolved)) {
              return { ok: false, error: 'Memory path is invalid or outside the assigned scope' }
            }
            normalizedPaths.push(resolved)
          }
        }
        if (context?.scopePath && !normalizedPaths?.length) {
          normalizedPaths = [context.scopePath]
        }
        if (!context?.taskId || !context?.agentRunId) {
          return { ok: false, error: 'Memory write requires an active task context' }
        }
        const operationId = `${context.agentRunId}:${callId}`
        const sourceRef = /^[a-zA-Z0-9_.:-]{1,128}$/.test(operationId)
          ? operationId
          : context.agentRunId
        const { memory, judgment, scopesFor } = runtime()
        const scoped = scopesFor(context.taskId, workspace.root, context.agentRunId)
        const baseEvent: EventDraft = scoped.event ?? {
          taskId: context.taskId,
          agentRunId: context.agentRunId,
          type: '',
          payload: {},
        }
        const eventDraft: EventDraft = {
          ...baseEvent,
          correlationId: operationId,
        }
        const candidate: MemoryCandidate = {
          kind: input.kind,
          text: input.text,
          sourceRefs: [sourceRef],
          ...(input.key ? { key: input.key } : {}),
          ...(input.title ? { title: input.title } : {}),
          ...(normalizedPaths?.length ? { paths: normalizedPaths } : {}),
          durable: input.durable ?? true,
          taskId: context.taskId,
          ...(eventDraft.taskNodeId ? { nodeId: eventDraft.taskNodeId } : {}),
          ...(eventDraft.taskAttemptId ? { attemptId: eventDraft.taskAttemptId } : {}),
          ...(scoped.teamKey ? { teamKey: scoped.teamKey } : {}),
          ...(scoped.sourceRole ? { sourceRole: scoped.sourceRole } : {}),
          evidenceRefs: [sourceRef],
        }
        const controller = new AbortController()
        const activeSignal = signal ?? controller.signal
        if (judgment.mode('memory.capture', context.taskId) === 'off') {
          memory.capture(eventDraft, scoped.primary, [candidate], context.scopePath)
        } else {
          await memory.captureReviewed(eventDraft, scoped.primary, [candidate], scoped.goal ?? input.text, judgment, activeSignal, context.scopePath)
        }
        const savedEntry = memory.list(scoped.primary).find(entry =>
          entry.sourceRefs.includes(sourceRef) && memoryEntryInScope(entry, context.scopePath))
        if (savedEntry) scoped.onSaved?.(savedEntry)
        return {
          ok: true,
          saved: Boolean(savedEntry),
          kind: input.kind,
          ...(savedEntry ? { id: savedEntry.id, version: savedEntry.version } : { reason: 'rejected_by_policy_or_duplicate' }),
        }
      },
    },
  ]
}
