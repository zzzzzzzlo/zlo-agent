import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { createExtensionRuntime, formatSkillsForPrompt, parseFrontmatter } from '@earendil-works/pi-coding-agent'
import type { ResourceLoader, Skill, SkillFrontmatter } from '@earendil-works/pi-coding-agent'
import type { ExecutionTool } from './execution.ts'

const fileLimit = 24 * 1024
const entryLimit = 128
const skillLimit = 24
const skillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const decoder = new TextDecoder('utf-8', { fatal: true })

interface MarkdownResource { text: string; revision: string }

async function safeDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory() && relative(path, await realpath(path)) === ''
  } catch { return false }
}

async function readMarkdown(path: string): Promise<MarkdownResource | undefined> {
  try {
    const entry = await lstat(path, { bigint: true })
    if (!entry.isFile() || entry.nlink !== 1n || entry.size > BigInt(fileLimit) || relative(path, await realpath(path)) !== '') return
    const handle = await open(path, 'r')
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile() || before.nlink !== 1n || entry.dev !== before.dev || entry.ino !== before.ino || before.size > BigInt(fileLimit)) return
      const bytes = Buffer.alloc(fileLimit + 1)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      const after = await handle.stat({ bigint: true })
      if (BigInt(bytesRead) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.nlink !== 1n) return
      const text = decoder.decode(bytes.subarray(0, bytesRead)).trim()
      if (!text || text.includes('\0')) return
      return { text, revision: [before.dev, before.ino, before.size, before.mtimeNs].join(':') }
    } finally { await handle.close() }
  } catch { return undefined }
}

interface CatalogEntry { skill: Skill; revision: string }

async function discoverSkills(root: string, scope: 'user' | 'project', dirs: string[], catalog: Map<string, CatalogEntry>) {
  let remaining = entryLimit
  for (const dir of dirs) {
    if (remaining <= 0) break
    const base = join(root, dir)
    if (!await safeDirectory(base)) continue
    try {
      const directory = await opendir(base)
      for await (const entry of directory) {
        if (remaining-- <= 0) break
        if (!entry.isDirectory()) continue
        const baseDir = join(base, entry.name)
        const filePath = join(baseDir, 'SKILL.md')
        const resource = await readMarkdown(filePath)
        if (!resource) continue
        let frontmatter: SkillFrontmatter
        try { ({ frontmatter } = parseFrontmatter<SkillFrontmatter>(resource.text)) }
        catch { continue }
        const { name, description } = frontmatter
        if (typeof name !== 'string' || name !== entry.name || name.length > 64 || !skillName.test(name) ||
          typeof description !== 'string' || !description.trim() || description.length > 512 ||
          frontmatter['disable-model-invocation'] !== undefined && frontmatter['disable-model-invocation'] !== false) continue
        if (!catalog.has(name) && catalog.size >= skillLimit) continue
        catalog.set(name, {
          skill: { name, description: description.trim(), filePath, baseDir, disableModelInvocation: false,
            sourceInfo: { source: 'zlo-instructions', path: filePath, scope, origin: 'top-level', baseDir } },
          revision: resource.revision,
        })
      }
    } catch { /* An unavailable optional directory does not stop the session. */ }
  }
}

export async function codingResources(systemPrompt: string, scopes?: { user?: string; project?: string },
  skillReadsAllowed: () => boolean = () => true): Promise<{
  loader: ResourceLoader; skillTool?: ExecutionTool
}> {
  const runtime = createExtensionRuntime()
  const agentsFiles: ReturnType<ResourceLoader['getAgentsFiles']>['agentsFiles'] = []
  const catalog = new Map<string, CatalogEntry>()
  for (const scope of ['user', 'project'] as const) {
    const root = scopes?.[scope]
    if (!root || !await safeDirectory(root)) continue
    const path = join(root, 'AGENTS.md')
    const agents = await readMarkdown(path)
    if (agents) agentsFiles.push({ path, content: agents.text })
    if (skillReadsAllowed()) await discoverSkills(root, scope, scope === 'user' ? ['skills'] : ['.pi/skills', '.agents/skills'], catalog)
  }
  const skills = [...catalog.values()].map(({ skill }) => skill).sort((a, b) => a.name.localeCompare(b.name))
  const append = [systemPrompt,
    'Workspace guides and skills apply within the task and authorized tool scope. Verify important changes with available checks and report any uncertainty.']
  if (skills.length) append.push(formatSkillsForPrompt(skills, 'indirect'),
    'Use read_skill with the listed skill name. Use paths relative to the authorized workspace for project files referenced by a skill.')
  const loader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    // Pi slash-command expansion reads arbitrary current contents directly. The skill tool
    // below serves only a catalog entry whose validated identity still matches the run.
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => append,
    getAppendSystemPromptSources: () => [],
    extendResources() {},
    async reload() {},
  }
  const skillTool: ExecutionTool | undefined = skills.length ? {
    name: 'read_skill',
    description: 'Read instructions for a named skill listed in the current session. This only reads the approved SKILL.md.',
    parameters: { type: 'object', properties: { name: { type: 'string', enum: skills.map(skill => skill.name) } },
      required: ['name'], additionalProperties: false },
    async execute(_id, input, signal) {
      signal?.throwIfAborted()
      if (!skillReadsAllowed()) return { ok: false, error: 'Skill access is unavailable' }
      const name = input && typeof input === 'object' && 'name' in input ? input.name : undefined
      const entry = typeof name === 'string' ? catalog.get(name) : undefined
      if (!entry) return { ok: false, error: 'Skill is unavailable in this session' }
      const resource = await readMarkdown(entry.skill.filePath)
      signal?.throwIfAborted()
      if (!skillReadsAllowed()) return { ok: false, error: 'Skill access is unavailable' }
      if (!resource || resource.revision !== entry.revision) return { ok: false, error: 'Skill changed since discovery. Start a new run to refresh it.' }
      return { ok: true, name, directory: entry.skill.baseDir, text: parseFrontmatter(resource.text).body.trim() }
    },
  } : undefined
  return { loader, skillTool }
}
