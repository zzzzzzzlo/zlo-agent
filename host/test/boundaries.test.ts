import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const dependencies: Record<string, string[]> = {
  cli: ['contracts/desktop', 'conversation', 'fake', 'faux', 'host', 'pi', 'shared/diagnostics'],
  host: ['contracts/domain', 'contracts/desktop', 'conversation', 'execution', 'orchestrator', 'policies', 'store', 'task-engine', 'workspace', 'diagnostics', 'shared/diagnostics'],
  diagnostics: ['store', 'shared/diagnostics'],
  conversation: ['contracts/domain', 'contracts/desktop', 'store', 'task-engine', 'workspace'],
  orchestrator: ['contracts/domain', 'execution', 'policies', 'store', 'task-engine', 'workspace'],
  'task-engine': ['contracts/domain', 'store'],
  policies: ['contracts/domain', 'execution'],
  workspace: ['contracts/domain', 'execution'],
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
          ? path.endsWith('/desktop.ts') ? 'contracts/desktop' : 'shared/domain'
          : path.split('/src/').at(-1)!.replace(/\.ts$/, '')
        assert.ok(allowed.includes(target), file + ' -> ' + specifier)
      }
      if (specifier.startsWith('@earendil-works/')) assert.ok(file === 'pi' || file === 'faux')
    }
  }
})
