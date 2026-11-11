import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { Browser } from '../../host/node_modules/playwright-core/index.js'
import { listenLoopback } from '../../shared/loopback-http.ts'

const require = createRequire(new URL('../../host/package.json', import.meta.url))
const { chromium } = require('playwright-core') as typeof import('../../host/node_modules/playwright-core/index.js')
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^ZLO_|(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN)$/iu.test(name)))
const telemetryToken = 'test-host-telemetry-token-123456789'
const dashboardToken = 'test-dashboard-access-token-1234567'

async function eventually<T>(read: () => T | Promise<T>, label: string, ms = 15_000): Promise<NonNullable<T>> {
  const until = Date.now() + ms
  do {
    const value = await read()
    if (value) return value
    await delay(80)
  } while (Date.now() < until)
  throw new Error('Timed out waiting for ' + label)
}

async function terminate(child?: ChildProcessWithoutNullStreams, graceful?: () => void) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const done = once(child, 'exit')
  if (graceful) {
    graceful()
    if (await Promise.race([done.then(() => true), delay(2_000, false, { ref: false })])) return
  }
  child.kill()
  await done
}

interface HostMessage {
  kind: string
  commandId?: string
  result?: { taskId?: string }
  event?: { type: string; payload: { status?: string } }
}

test('Dashboard authenticates, filters real Host events, opens traces and records a read-only evaluation', {
  timeout: 60_000, skip: process.platform !== 'win32',
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zlo-dashboard-'))
  let host: ChildProcessWithoutNullStreams | undefined
  let observatory: ChildProcessWithoutNullStreams | undefined
  let browser: Browser | undefined
  const send = (command: object) => host!.stdin.write(JSON.stringify({ schemaVersion: 1, ...command }) + '\n')
  t.after(async () => {
    try {
      await browser?.close()
      await terminate(observatory)
      await terminate(host, () => { send({ type: 'exit' }) })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  const workspace = join(directory, 'workspace')
  await mkdir(workspace)
  const ports = await Promise.all([listenLoopback(0, () => {}), listenLoopback(0, () => {})])
  const [hostPort, webPort] = ports.map(port => new URL(port.origin).port)
  await Promise.all(ports.map(port => port.close()))
  const telemetryEnv = { ...safeEnv, ZLO_TELEMETRY_TOKEN: telemetryToken, ZLO_TELEMETRY_PORT: hostPort }
  host = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../../host/src/cli.ts', import.meta.url)),
    '--fake', '--data', join(directory, 'host')], { env: telemetryEnv, windowsHide: true })
  host.stdin.on('error', () => {})
  host.stderr.resume()
  const events: HostMessage[] = []
  createInterface({ input: host.stdout }).on('line', line => { events.push(JSON.parse(line) as HostMessage) })
  await eventually(() => events.find(event => event.kind === 'ready'), 'Host startup')
  const hiddenGoal = 'demo delegate <svg/onload=alert(1)> PRIVATE_DASHBOARD_FIXTURE'
  send({ type: 'createTask', commandId: 'seed', requestId: 'dashboard-test-task', cwd: workspace,
    goal: hiddenGoal, check: { path: 'demo.txt', contains: 'verified by zlo agent' } })
  const { result } = await eventually(() => events.find(event => event.commandId === 'seed'), 'task creation')
  assert.ok(result?.taskId)
  const taskId = result.taskId
  send({ type: 'subscribe', taskId, after: 0 })
  await eventually(() => events.find(message =>
    message.event?.type === 'task.state_changed' && message.event.payload.status === 'succeeded'), 'task completion')
  observatory = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../src/cli.ts', import.meta.url))],
    { env: { ...telemetryEnv, ZLO_OBSERVATORY_TOKEN: dashboardToken, ZLO_OBSERVATORY_PORT: webPort,
      ZLO_OBSERVATORY_DATA: join(directory, 'observatory') }, windowsHide: true })
  observatory.stdout.resume()
  observatory.stderr.resume()
  const origin = 'http://127.0.0.1:' + webPort
  const headers = { authorization: 'Bearer ' + dashboardToken }
  await eventually(async () => {
    if (observatory!.exitCode !== null) assert.fail('The observatory CLI exited during startup.')
    try {
      const response = await fetch(origin + '/api/overview', { headers, signal: AbortSignal.timeout(500) })
      if (!response.ok) return false
      const data = await response.json() as { tasks: { id: string }[] }
      return data.tasks.some(task => task.id === taskId)
    } catch { return false }
  }, 'collection from the real Host')
  const denied = await fetch(origin + '/api/overview')
  assert.equal(denied.status, 401)
  await denied.body?.cancel()

  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1350, height: 890 } })
  page.setDefaultTimeout(10_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const external: string[] = []
  page.on('request', request => {
    if (!request.url().startsWith(origin + '/')) external.push(request.url())
  })
  await page.goto(origin + '/')
  await page.getByRole('heading', { name: '连接到本机中台' }).waitFor()
  await page.goto(origin + '/#token=' + dashboardToken)
  await page.getByRole('heading', { name: '核心指标' }).waitFor()
  assert.equal(new URL(page.url()).hash, '#overview')
  assert.ok(await page.locator('.metric-grid .metric').count() >= 20)
  assert.equal((await page.locator('main').textContent())?.includes('PRIVATE_DASHBOARD_FIXTURE'), false)

  await page.getByLabel('运行状态').selectOption('failed')
  const filtered = page.waitForResponse(response => response.url().includes('/api/overview?status=failed'))
  await page.getByRole('button', { name: '应用筛选' }).click()
  assert.ok((await filtered).ok())
  await page.getByText('没有符合筛选条件的任务。').waitFor()
  await page.getByRole('button', { name: '重置' }).click()
  await page.getByRole('link', { name: taskId.slice(0, 8) }).click()
  await page.getByRole('heading', { name: '任务 DAG' }).waitFor()
  assert.ok(await page.getByRole('heading', { name: 'Agent Tree' }).isVisible())
  assert.ok(await page.getByRole('heading', { name: 'Judgment 决策' }).isVisible())
  await page.locator('details.timeline-row summary').first().click()
  const eventLink = page.locator('details.timeline-row[open]').getByRole('link', { name: /^事件 /u }).first()
  await eventLink.click()
  await page.locator('details.event.flash[open]').waitFor()
  assert.ok(await page.locator('details.event.flash').getByText('Correlation ID', { exact: true }).isVisible())
  assert.equal((await page.locator('main').textContent())?.includes('PRIVATE_DASHBOARD_FIXTURE'), false)
  const traceResponse = await fetch(origin + '/api/tasks/' + taskId, { headers })
  const { events: traceEvents } = await traceResponse.json() as { events: { id: string; type: string; payload: { id?: string } }[] }
  const receipt = traceEvents.find(event => event.type === 'tool.finished' && event.payload.id)
  assert.ok(receipt?.payload.id)
  const hash = 'sha256:' + createHash('sha256').update(receipt.payload.id).digest('hex')
  await page.goto(origin + '/#traces?' + new URLSearchParams({ task: taskId, receipt: hash }))
  await page.locator('#event-' + receipt.id + '.flash[open]').waitFor()

  await page.getByRole('link', { name: '评估此任务' }).click()
  await page.getByRole('heading', { name: '发起评估' }).waitFor()
  assert.equal(await page.getByLabel('任务', { exact: true }).inputValue(), taskId)
  const evidenceInput = page.getByLabel('交付证据（可选，每行一个工作区相对路径）')
  await evidenceInput.fill('demo.txt')
  const submitted = page.waitForResponse(response => response.url() === origin + '/api/evaluations' && response.request().method() === 'POST')
  await page.getByRole('button', { name: '发起评估' }).click()
  const accepted = await submitted
  assert.equal(accepted.status(), 202, await accepted.text())
  const { id: evaluationId } = await accepted.json() as { id: string }
  const completed = await eventually(async () => {
    const response = await fetch(origin + '/api/evaluations', { headers })
    const { evaluations } = await response.json() as { evaluations: { id: string; status: string; result?: { verdict: string } }[] }
    return evaluations.find(job => job.id === evaluationId && !['queued', 'running'].includes(job.status))
  }, 'evaluation completion')
  assert.equal(completed.result?.verdict, 'pass', JSON.stringify(completed))
  const firstResult = page.locator('[data-detail="evaluation:' + evaluationId + '"]')
  const review = firstResult.locator(':scope > summary')
  await review.getByText('通过', { exact: true }).waitFor()
  await review.click()
  await page.getByRole('heading', { name: '任务完成度' }).waitFor()
  assert.ok(await page.getByRole('link', { name: '查看原始 Trace' }).isVisible())
  assert.ok(await page.getByText('评估费用（估算 USD）').isVisible())
  await evidenceInput.fill('')
  await firstResult.getByRole('button', { name: '重新评估' }).click()
  assert.equal(await evidenceInput.inputValue(), 'demo.txt')
  const repeated = page.waitForResponse(response => response.url() === origin + '/api/evaluations' && response.request().method() === 'POST')
  await page.getByRole('button', { name: '发起评估' }).click()
  const repeatResponse = await repeated
  assert.equal(repeatResponse.status(), 202, await repeatResponse.text())
  const { id: repeatId } = await repeatResponse.json() as { id: string }
  await page.getByRole('heading', { name: '比较评估' }).waitFor()
  await page.getByLabel('评估 A', { exact: true }).selectOption(evaluationId)
  await page.getByLabel('评估 B', { exact: true }).selectOption(repeatId)
  await page.getByText('两次评估使用了相同版本的证据。').waitFor()

  const automatic = page.getByLabel('任务结束后自动执行确定性评估')
  const configured = page.waitForResponse(response => response.url() === origin + '/api/evaluation-settings')
  await automatic.check()
  assert.ok((await configured).ok())
  await page.reload()
  await automatic.waitFor()
  assert.equal(await automatic.isChecked(), true)

  for (const section of ['模型与资源', '工具与可靠性', '记忆与上下文', 'Judgment']) {
    await page.getByRole('navigation').getByRole('link', { name: section, exact: true }).click()
    await page.getByRole('heading', { name: section, exact: true }).first().waitFor()
    await page.locator('#view .metric-grid').first().waitFor()
  }
  await page.setViewportSize({ width: 375, height: 812 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  await terminate(host, () => { send({ type: 'exit' }) })
  await page.getByText('Host 离线 · 本地历史', { exact: true }).waitFor({ timeout: 15_000 })
  await page.getByRole('navigation').getByRole('link', { name: '任务与追踪' }).click()
  await page.getByRole('link', { name: taskId.slice(0, 8) }).waitFor()
  assert.deepEqual(errors, [])
  assert.deepEqual(external, [])
})
