import type { VerificationCheck, VerificationResult, WorkspaceAccess } from './contracts/domain.ts'
import { workspaceTarget } from './workspace.ts'
import type { CodingWorkspace, WorkspaceTool } from './workspace.ts'

export type AgentRole = 'root' | 'team' | 'worker'

export interface SandboxProvider {
  prepare(policy: { cwd: string; network: 'deny' }): Promise<{ supported: false } | { supported: true; dispose(): Promise<void> }>
}

export class UnsupportedSandbox implements SandboxProvider {
  async prepare() { return { supported: false as const } }
}

export interface CodingProfile {
  workspaceWrites: boolean
  delegation: boolean
}

export const defaultCodingProfile: Readonly<CodingProfile> = { workspaceWrites: true, delegation: true }

export interface CapabilityPlugin {
  id: string
  tools(workspace: CodingWorkspace, role: AgentRole, access: WorkspaceAccess): WorkspaceTool[]
}

export interface WorkflowPack {
  id: string
  systemPrompt(role: AgentRole, access: WorkspaceAccess, check?: VerificationCheck): string
  verify(workspace: CodingWorkspace, check: VerificationCheck, signal: AbortSignal, access: WorkspaceAccess): Promise<VerificationResult>
}

export interface AgentProfile extends CodingProfile {
  id: string
  plugins: readonly string[]
  workflow: string
}

const workspacePlugin: CapabilityPlugin = {
  id: 'workspace',
  tools: (workspace, role, access) => workspace.tools(role, access),
}

const codingWorkflow: WorkflowPack = {
  id: 'coding',
  systemPrompt(role, access, check) {
    return [
      role === 'root' ? 'You are the local coding agent and task coordinator.'
        : role === 'team' ? 'You are a persistent team specialist responsible for your assigned node.'
          : 'You are a temporary worker. Complete only your assigned node.',
      access === 'read' ? 'Workspace access is read-only.' : 'Make scoped workspace changes using the listed tools.',
      check ? 'Acceptance requires the configured deterministic workspace check.' : 'Use tool results as evidence and summarize confirmed changes.',
      'Never request credentials or bypass the tool scope.',
    ].join(' ')
  },
  verify: (workspace, check, signal, access) => workspace.verify(check, signal, access),
}

/** Only the trusted Host composition root registers executable plugins and workflows. */
export class ExtensionRegistry {
  readonly #plugins = new Map<string, CapabilityPlugin>()
  readonly #workflows = new Map<string, WorkflowPack>()
  readonly #profiles = new Map<string, AgentProfile>()

  constructor(additional: CapabilityPlugin[] = []) {
    this.registerPlugin(workspacePlugin)
    for (const plugin of additional) this.registerPlugin(plugin)
    this.registerWorkflow(codingWorkflow)
    this.registerProfile({ id: 'coding', plugins: ['workspace', ...additional.map(plugin => plugin.id)], workflow: 'coding', ...defaultCodingProfile })
  }

  #add<T extends { id: string }>(entries: Map<string, T>, item: T): void {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(item.id) || entries.has(item.id)) throw new Error('Invalid or duplicate extension ID')
    entries.set(item.id, item)
  }

  registerPlugin(plugin: CapabilityPlugin): void { this.#add(this.#plugins, plugin) }
  registerWorkflow(workflow: WorkflowPack): void { this.#add(this.#workflows, workflow) }

  registerProfile(profile: AgentProfile): void {
    if (!this.#workflows.has(profile.workflow) || profile.plugins.some(id => !this.#plugins.has(id)) ||
      new Set(profile.plugins).size !== profile.plugins.length) throw new Error('Unknown or repeated profile extension')
    this.#add(this.#profiles, { ...profile, plugins: [...profile.plugins] })
  }

  resolve(profileId: string) {
    const profile = this.#profiles.get(profileId)
    if (!profile) throw new Error('Unknown Agent profile')
    return {
      profile: { ...profile },
      workflow: this.#workflows.get(profile.workflow)!,
      catalog: (workspace: CodingWorkspace, role: AgentRole, access: WorkspaceAccess) =>
        profile.plugins.flatMap(plugin => this.#plugins.get(plugin)!.tools(workspace, role, access).map(tool => ({ plugin, tool }))),
      tools: (workspace: CodingWorkspace, role: AgentRole, access: WorkspaceAccess) => {
        const tools = profile.plugins.flatMap(id => this.#plugins.get(id)!.tools(workspace, role, access))
        if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('Duplicate capability name')
        return tools
      },
    }
  }
}

export interface CapabilityScope {
  access: WorkspaceAccess
  path?: string
  role: AgentRole
}

export const accessRank: Record<WorkspaceAccess, number> = { read: 0, write: 1, trusted: 2 }

export class CodingCapabilities {
  readonly #profile: Readonly<CodingProfile>
  readonly #toolEnabled: (name: string) => boolean

  constructor(profile: Readonly<CodingProfile> = defaultCodingProfile, toolEnabled: (name: string) => boolean = () => true) {
    this.#profile = profile
    this.#toolEnabled = toolEnabled
  }

  root(access: WorkspaceAccess | undefined, legacyCheck: boolean): CapabilityScope {
    return { role: 'root', access: this.#profile.workspaceWrites ? access ?? (legacyCheck ? 'write' : 'read') : 'read' }
  }

  child(parent: CapabilityScope, requested?: 'read' | 'write', path?: string, role: 'team' | 'worker' = 'worker'): CapabilityScope {
    if (requested === 'write' && parent.access === 'read') throw new Error('Parent workspace scope cannot write')
    const target = path === undefined ? parent.path : workspaceTarget({ path })
    if (path !== undefined && (!target || !within(parent.path, target))) throw new Error('Child workspace scope exceeds its parent')
    return { role, access: requested ?? 'read', path: target }
  }

  describe(scope: CapabilityScope, tool: WorkspaceTool): boolean {
    if (!this.enabled(tool.name)) return false
    if (tool.policy?.rootOnly && scope.role !== 'root') return false
    const minimum = tool.policy?.minimumAccess ?? (tool.effect === 'write' ? 'write' : 'read')
    return accessRank[scope.access] >= accessRank[minimum] && (tool.effect === 'read' || scope.access !== 'read')
  }

  enabled(name: string): boolean { return this.#toolEnabled(name) }

  authorize(scope: CapabilityScope, tool: WorkspaceTool, input: unknown): boolean {
    if (!this.describe(scope, tool)) return false
    if (!scope.path) return true
    try {
      const targets = tool.policy?.targets ? tool.policy.targets(input) : [workspaceTarget(input)]
      return targets.length > 0 && targets.every(value => {
        const target = workspaceTarget({ path: value })
        return target !== undefined && within(scope.path, target)
      })
    } catch {
      return false
    }
  }
}

function within(scope: string | undefined, target: string): boolean {
  if (scope === undefined) return true
  if (process.platform === 'win32') {
    scope = scope.toLowerCase()
    target = target.toLowerCase()
  }
  return target === scope || target.startsWith(scope + '/')
}
