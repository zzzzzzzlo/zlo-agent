import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const dependencies: Record<string, string[]> = {
  cli: ['contracts/desktop', 'conversation', 'fake', 'faux', 'host', 'pi', 'shared/diagnostics'],
  host: ['contracts/domain', 'contracts/desktop', 'conversation', 'execution', 'orchestrator', 'policies', 'store', 'task-engine', 'workspace', 'diagnostics', 'shared/diagnostics', 'judgment', 'memory', 'model-scheduler', 'verification', 'tool-approval', 'shared/tool-approval', 'artifact-tools', 'browser-tools', 'file-tools', 'git-tools', 'process-tools', 'web-tools'],
  diagnostics: ['store', 'shared/diagnostics'],
  conversation: ['contracts/domain', 'contracts/desktop', 'store', 'task-engine', 'workspace'],
  orchestrator: ['contracts/domain', 'execution', 'policies', 'store', 'task-engine', 'workspace', 'agent-plan', 'judgment', 'memory', 'model-scheduler', 'verification', 'tool-approval', 'tool-run'],
  'tool-run': ['contracts/domain', 'execution', 'task-engine', 'tool-approval', 'workspace', 'workspace-process'],
  'tool-approval': ['shared/tool-approval'],
  'artifact-tools': ['workspace', 'workspace-process'],
  'browser-tools': ['workspace', 'web-tools'],
  'file-tools': ['workspace', 'workspace-process'],
  'git-tools': ['workspace', 'workspace-process'],
  'process-tools': ['workspace', 'workspace-process'],
  'web-tools': ['workspace', 'workspace-process'],
  'agent-plan': ['execution', 'task-engine'],
  judgment: ['contracts/domain', 'store'],
  memory: ['contracts/domain', 'store', 'judgment'],
  'model-scheduler': ['contracts/domain', 'execution', 'store', 'judgment'],
  verification: ['contracts/domain', 'policies', 'task-engine', 'workspace'],
  'task-engine': ['contracts/domain', 'store'],
  policies: ['contracts/domain', 'workspace'],
  workspace: ['contracts/domain', 'execution', 'workspace-process', 'shared/tool-approval'],
  'workspace-process': ['contracts/domain'],
  store: ['contracts/domain'],
  execution: ['contracts/domain'],
  pi: ['execution', 'shared/diagnostics'],
  fake: ['execution'],
  faux: ['pi'],
  'contracts/desktop': ['shared/domain'],
  'contracts/domain': ['shared/domain'],
}

test('Host modules respect the dependency direction and keep Pi behind its adapter', async () => {
  for (const [file, allowed] of Object.entries(dependencies)) {
    const source = new URL(file === 'contracts/desktop'
      ? '../../shared/contracts/desktop.ts'
      : '../src/' + file + '.ts', import.meta.url)
    const content = await readFile(source, 'utf8')
    for (const match of content.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
      const specifier = match[1]
      if (specifier.startsWith('.')) {
        const path = new URL(specifier, source).pathname
        const target = path.endsWith('/shared/diagnostics.ts') ? 'shared/diagnostics' : path.includes('/shared/contracts/')
          ? path.endsWith('/desktop.ts') ? 'contracts/desktop' : path.endsWith('/tool-approval.ts') ? 'shared/tool-approval' : 'shared/domain'
          : path.split('/src/').at(-1)!.replace(/\.ts$/, '')
        assert.ok(allowed.includes(target), file + ' -> ' + specifier)
      }
      if (specifier.startsWith('@earendil-works/')) assert.ok(file === 'pi' || file === 'faux')
    }
  }
})
