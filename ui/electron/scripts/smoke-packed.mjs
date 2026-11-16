import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const uiRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const unpackedDir = process.env.ZLO_AGENT_UNPACKED_DIR
  ? resolve(process.env.ZLO_AGENT_UNPACKED_DIR)
  : join(uiRoot, 'release', 'win-unpacked')
const executablePath = join(unpackedDir, 'Zlo Agent.exe')

await access(executablePath)
await access(join(unpackedDir, 'resources', 'agent-host', 'src', 'cli.ts'))

const userData = await mkdtemp(join(tmpdir(), 'zlo-packed-smoke-'))
const env = {
  ...process.env,
  ZLO_AGENT_DESKTOP_MODE: 'faux',
  ZLO_AGENT_DESKTOP_DATA: userData,
  ZLO_AGENT_E2E_HIDDEN: '1',
}
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL

let app
try {
  app = await electron.launch({
    executablePath,
    args: ['--enable-logging=stderr', '--user-data-dir=' + userData],
    cwd: unpackedDir,
    env,
    chromiumSandbox: true,
    timeout: 25_000,
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  const deadline = Date.now() + 45_000
  let ready = false
  while (Date.now() < deadline) {
    const status = await page.evaluate(() => window.agentHost?.getStatus())
    if (status?.state === 'offline') throw new Error('Packaged Host reported offline: ' + status.message)
    if (status?.state === 'ready') {
      ready = true
      break
    }
    await delay(100)
  }
  assert.equal(ready, true, 'Packaged Host did not reach ready state within timeout')
  const conversations = await page.evaluate(() => window.agentHost.listConversations())
  assert.equal(Array.isArray(conversations), true)
  await app.close()
  app = undefined
} finally {
  if (app) await app.close().catch(() => {})
  await rm(userData, { recursive: true, force: true }).catch(() => {})
}
