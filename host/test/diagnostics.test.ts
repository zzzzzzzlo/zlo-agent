import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseHostDiagnostic } from '../../shared/diagnostics.ts'

function temporaryDirectory(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'zlo-diagnostic-test-'))
  t.after(() => {
    assert.ok(root.startsWith(join(tmpdir(), 'zlo-diagnostic-test-')))
    rmSync(root, { recursive: true, force: true })
  })
  return root
}

function run(relative: string, args: string[], overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [
    '--disable-warning=ExperimentalWarning', fileURLToPath(new URL(relative, import.meta.url)), ...args,
  ], { encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, ...overrides } })
}

function parse(stderr: string) {
  return stderr.trim().split('\n').map((line) => {
    const entry = parseHostDiagnostic(line)
    assert.ok(entry, 'Every line must be a valid Host diagnostic')
    return entry
  })
}

test('Host startup failures are classified without reporting raw environment or paths', (t) => {
  const root = temporaryDirectory(t)
  const invalid = run('../src/cli.ts', ['--fake', '--data', join(root, 'state')], {
    ZLO_AGENT_MODEL_PROVIDER: 'Authorization: Bearer fake-credential-marker', ZLO_AGENT_MODEL_ID: 'model',
  })
  assert.equal(invalid.status, 1)
  assert.equal(invalid.stdout, '')
  assert.equal(parse(invalid.stderr)[0].code, 'host.startup_config_invalid')
  assert.doesNotMatch(invalid.stderr, /fake-credential-marker|Authorization/i)
  const file = join(root, 'private-path-marker')
  writeFileSync(file, '')
  const storage = run('../src/cli.ts', ['--fake', '--data', file], { ZLO_AGENT_MODEL_PROVIDER: '', ZLO_AGENT_MODEL_ID: '' })
  assert.equal(storage.status, 1)
  assert.equal(parse(storage.stderr)[0].code, 'host.startup_storage_failed')
  assert.doesNotMatch(storage.stderr, /private-path-marker/)
})

test('Pi provider errors and failed tools emit safe correlated diagnostics', (t) => {
  const child = run('./fixtures/diagnostic-host.ts', [temporaryDirectory(t)], { OPENAI_API_KEY: 'fake-credential-marker' })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), { status: 'blocked' })
  assert.doesNotMatch(child.stderr, /Authorization|fake-credential-marker|private-prompt-marker|tool-secret-marker/i)
  const entries = parse(child.stderr)
  const model = entries.filter(({ category }) => category === 'model')
  assert.deepEqual(model.map(({ code }) => code), [
    'host.model_started', 'host.model_completed', 'host.model_started', 'host.model_failed',
  ])
  assert.equal(new Set(model.map(({ correlationId }) => correlationId)).size, 1)
  const tool = entries.filter(({ category }) => category === 'tool')
  assert.deepEqual(tool.map(({ code }) => code), ['host.tool_started', 'host.tool_failed'])
  assert.equal(tool[0].correlationId, tool[1].correlationId)
  assert.equal(tool[0].correlationId, model[0].correlationId)
})
