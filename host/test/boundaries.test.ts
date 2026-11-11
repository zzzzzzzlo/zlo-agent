import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const dependencies: Record<string, string[]> = {
  cli: ['contracts/desktop', 'conversation', 'execution', 'fake', 'faux', 'host', 'pi', 'shared/diagnostics', 'shared/loopback-http', 'shared/management', 'management', 'model-management', 'telemetry-http'],
  host: ['contracts/domain', 'contracts/desktop', 'conversation', 'execution', 'orchestrator', 'policies', 'store', 'task-engine', 'workspace', 'diagnostics', 'shared/diagnostics', 'judgment', 'memory', 'model-scheduler', 'verification', 'tool-approval', 'shared/tool-approval', 'artifact-tools', 'browser-tools', 'preview-tools', 'file-tools', 'git-tools', 'process-tools', 'web-tools', 'management', 'reconciliation', 'shared/chatgpt', 'shared/management', 'telemetry-projection'],
  'telemetry-http': ['host', 'contracts/domain', 'shared/loopback-http', 'telemetry-evidence', 'telemetry-projection'],
  'telemetry-evidence': ['shared/observatory', 'task-engine', 'telemetry-projection', 'workspace', 'workspace-process'],
  'telemetry-projection': ['shared/domain', 'shared/observatory', 'shared/tool-approval', 'contracts/domain', 'task-engine', 'workspace-process'],
  diagnostics: ['store', 'shared/diagnostics'],
  conversation: ['contracts/domain', 'contracts/desktop', 'store', 'task-engine', 'workspace'],
  orchestrator: ['contracts/domain', 'execution', 'policies', 'store', 'task-engine', 'workspace', 'agent-plan', 'judgment', 'memory', 'model-scheduler', 'verification', 'tool-approval', 'tool-run', 'visual-workflow'],
  'tool-run': ['contracts/domain', 'execution', 'task-engine', 'tool-approval', 'workspace', 'workspace-process', 'reconciliation'],
  'tool-approval': ['shared/tool-approval'],
  'artifact-tools': ['workspace', 'workspace-process'],
  'browser-runtime': [],
  'browser-tools': ['workspace', 'web-tools', 'browser-runtime'],
  'preview-tools': ['workspace', 'browser-runtime', 'execution'],
  'visual-workflow': ['contracts/domain', 'execution', 'workspace'],
  'file-tools': ['workspace', 'workspace-process'],
  'git-tools': ['workspace', 'workspace-process'],
  'process-tools': ['workspace', 'workspace-process'],
  'web-tools': ['workspace', 'workspace-process'],
  'agent-plan': ['execution', 'task-engine'],
  judgment: ['contracts/domain', 'store'],
  memory: ['contracts/domain', 'store', 'judgment'],
  'model-scheduler': ['contracts/domain', 'execution', 'store', 'judgment'],
  management: ['contracts/domain', 'contracts/desktop', 'shared/domain', 'shared/management', 'conversation', 'policies', 'task-engine', 'workspace', 'workspace-process'],
  'model-management': ['shared/management'],
  'chatgpt-responses': [],
  reconciliation: ['task-engine', 'workspace'],
  verification: ['contracts/domain', 'policies', 'task-engine', 'workspace'],
  'task-engine': ['contracts/domain', 'store', 'shared/tool-approval'],
  policies: ['contracts/domain', 'workspace'],
  workspace: ['contracts/domain', 'execution', 'workspace-process', 'shared/tool-approval'],
  'workspace-process': ['contracts/domain'],
  store: ['contracts/domain'],
  execution: ['contracts/domain'],
  pi: ['execution', 'shared/diagnostics', 'shared/management', 'shared/chatgpt', 'model-management', 'chatgpt-responses'],
  fake: ['execution'],
  faux: ['pi'],
  'contracts/desktop': ['shared/domain'],
  'contracts/domain': ['shared/domain'],
  'shared/management': ['shared/domain', 'contracts/desktop', 'shared/chatgpt'],
  'shared/chatgpt': ['shared/domain'],
  'shared/observatory': ['shared/domain'],
}

test('Host modules respect the dependency direction and keep Pi behind its adapter', async () => {
  for (const [file, allowed] of Object.entries(dependencies)) {
    const source = new URL(file.startsWith('shared/') || file === 'contracts/desktop'
      ? '../../shared/contracts/' + file.split('/').at(-1) + '.ts' : '../src/' + file + '.ts', import.meta.url)
    const content = await readFile(source, 'utf8')
    for (const match of content.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
      const specifier = match[1]
      if (specifier.startsWith('.')) {
        const path = new URL(specifier, source).pathname
        const target = path.includes('/shared/')
          ? path.endsWith('/desktop.ts') ? 'contracts/desktop' : 'shared/' + path.split('/').at(-1)!.replace(/\.ts$/, '')
          : path.split('/src/').at(-1)!.replace(/\.ts$/, '')
        assert.ok(allowed.includes(target), file + ' -> ' + specifier)
      }
      if (specifier.startsWith('@earendil-works/')) assert.ok(file === 'pi' || file === 'faux')
    }
  }
})
