import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ui = fileURLToPath(new URL('../', import.meta.url))
const host = resolve(ui, '../host') + sep

test('desktop TypeScript has no direct dependency on Host private files', async () => {
  for (const directory of ['src', 'electron', 'test']) {
    const root = resolve(ui, directory)
    for (const file of await readdir(root, { recursive: true })) {
      if (!/\.(tsx?|mjs)$/.test(file)) continue
      const path = resolve(root, file)
      const source = await readFile(path, 'utf8')
      for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
        const specifier = imported.fileName
        if (!specifier.startsWith('.')) continue
        const target = resolve(path, '..', specifier)
        assert.ok(!target.startsWith(host), file + ' imports Host internals via ' + specifier)
      }
    }
  }
})
