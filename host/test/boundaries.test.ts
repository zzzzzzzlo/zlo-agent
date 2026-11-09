import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const dependencies: Record<string, string[]> = {
  cli: ['contracts/desktop', 'conversation', 'fake', 'faux', 'host', 'pi'],
  host: ['contracts/domain', 'contracts/desktop', 'conversation', 'execution', 'orchestrator', 'policies', 'store', 'task-engine', 'workspace'],
  conversation: ['contracts/domain', 'contracts/desktop', 'store', 'task-engine', 'workspace'],
  orchestrator: ['contracts/domain', 'execution', 'policies', 'store', 'task-engine', 'workspace'],
  'task-engine': ['contracts/domain', 'store'],
  policies: ['contracts/domain', 'execution'],
  workspace: ['contracts/domain', 'execution'],
  store: ['contracts/domain'],
  execution: ['contracts/domain'],
  pi: ['execution'],
  fake: ['execution'],
  faux: ['pi'],
  'contracts/desktop': ['contracts/domain'],
  'contracts/domain': [],
}

test('Host modules respect the dependency direction and keep Pi behind its adapter', async () => {
  for (const [file, allowed] of Object.entries(dependencies)) {
    const content = await readFile(new URL('../src/' + file + '.ts', import.meta.url), 'utf8')
    for (const match of content.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
      const specifier = match[1]
      if (specifier.startsWith('.')) {
        const target = new URL(specifier, new URL('../src/' + file + '.ts', import.meta.url)).pathname.split('/src/').at(-1)!
        assert.ok(allowed.includes(target.replace(/\.ts$/, '')), file + ' -> ' + specifier)
      }
      if (specifier.startsWith('@earendil-works/')) assert.ok(file === 'pi' || file === 'faux')
    }
  }
})
