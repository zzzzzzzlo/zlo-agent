import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const dependencies: Record<string, string[]> = {
  cli: ['fake', 'host', 'pi'],
  host: ['execution', 'orchestrator', 'policies', 'store', 'task-engine', 'workspace'],
  orchestrator: ['execution', 'policies', 'store', 'task-engine', 'workspace'],
  'task-engine': ['execution', 'store', 'workspace'],
  policies: ['execution'],
  workspace: ['execution'],
  store: [],
  execution: [],
  pi: ['execution'],
  fake: ['execution'],
}

test('Host modules respect the dependency direction and keep Pi behind its adapter', async () => {
  for (const [file, allowed] of Object.entries(dependencies)) {
    const content = await readFile(new URL('../src/' + file + '.ts', import.meta.url), 'utf8')
    for (const match of content.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
      const specifier = match[1]
      if (specifier.startsWith('.')) {
        assert.ok(allowed.includes(specifier.replace(/^\.\//, '').replace(/\.ts$/, '')), file + ' -> ' + specifier)
      }
      if (specifier.startsWith('@earendil-works/')) assert.equal(file, 'pi')
    }
  }
})
