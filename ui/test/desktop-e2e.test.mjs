import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { _electron as electron } from 'playwright-core'

const appPath = resolve(fileURLToPath(new URL('..', import.meta.url)))
const executablePath = join(appPath, 'node_modules', 'electron', 'dist', 'electron.exe')
const exec = promisify(execFile)

async function eventually(predicate, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(50)
  }
  throw new Error('Timed out waiting for ' + label)
}

async function launch(data) {
  const env = { ...process.env, ZLO_AGENT_DESKTOP_MODE: 'faux', ZLO_AGENT_DESKTOP_DATA: data }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  return electron.launch({
    executablePath, args: ['--enable-logging=stderr', '--user-data-dir=' + data, appPath], cwd: appPath,
    env, chromiumSandbox: true, timeout: 20000,
  })
}

async function ready(app) {
  const page = await app.firstWindow()
  await eventually(async () => {
    const status = await page.evaluate(() => window.agentHost?.getStatus())
    if (status?.state === 'offline') throw new Error('Host is offline: ' + status.message)
    return status?.state === 'ready'
  }, 'Host Ready')
  assert.deepEqual(await page.evaluate(() => ({
    node: typeof process,
    require: typeof require,
    invoke: typeof window.agentHost.invoke,
  })), { node: 'undefined', require: 'undefined', invoke: 'undefined' })
  return page
}

async function history(page, conversationId) {
  return page.evaluate((id) => window.agentHost.getHistory({ conversationId: id }), conversationId)
}

async function waitForRun(page, conversationId, count, status) {
  await eventually(async () => {
    const result = await history(page, conversationId)
    return result.turns.length === count && result.turns.at(-1).status === status
  }, 'turn ' + count + ' in state ' + status)
}

async function waitForPartial(page, id, marker) {
  await eventually(async () => {
    const turn = (await history(page, id)).turns.at(-1)
    return turn?.user.text.startsWith(marker) && turn.status === 'running' && turn.assistant.text.length > 20
  }, 'live reply for ' + marker)
}

async function send(page, text) {
  await page.locator('#composer-input').fill(text)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
}

async function crashTestHost(app, data) {
  const mainPid = await app.evaluate(() => process.pid)
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [
    "$zloHosts = @(Get-CimInstance Win32_Process -Filter ('ParentProcessId = ' + $env:ZLO_E2E_PARENT) | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('cli.ts') -and $_.CommandLine.Contains('--faux') -and $_.CommandLine.Contains($env:ZLO_E2E_DATA) })",
    "if ($zloHosts.Count -ne 1) { throw 'Expected exactly one test Agent Host child' }",
    '$zloHosts[0].ProcessId',
  ].join('\n')], {
    env: { ...process.env, ZLO_E2E_PARENT: String(mainPid), ZLO_E2E_DATA: data },
    windowsHide: true, timeout: 10000,
  })
  const pid = Number(stdout.trim())
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  process.kill(pid, 'SIGKILL')
}

test('Windows Electron uses the Pi Host for coding, model switch, steering, stop and history recovery',
  { skip: process.platform !== 'win32', timeout: 90000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'zlo-electron-e2e-'))
    const workspace = join(root, 'selected-workspace')
    const data = join(root, 'desktop-data')
    await mkdir(workspace)
    let app
    try {
      app = await launch(data)
      const page = await ready(app)
      assert.deepEqual(await page.evaluate(() => window.agentHost.listConversations()), [])
      const invalidPath = await page.evaluate(async (path) => {
        try {
          await window.agentHost.createConversation({ requestId: 'forged-workspace', workspace: path })
          return false
        } catch { return true }
      }, workspace)
      assert.equal(invalidPath, true)

      // The native Windows folder dialog is replaced with a deterministic selection.
      // The real Main grant, IPC, Host, renderer and filesystem path checks remain active.
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
      }, workspace)
      await page.getByRole('button', { name: /新建会话/ }).click()
      await page.getByLabel('会话名称').fill('桌面登录页验收')
      await page.getByRole('button', { name: '选择工作区' }).click()
      await page.getByLabel('验收文件（相对路径）').fill('login.html')
      await page.getByLabel('文件包含内容').fill('<form>')
      await page.getByRole('button', { name: '创建会话' }).click()
      await page.getByRole('button', { name: '创建会话' }).waitFor({ state: 'hidden' })

      await eventually(async () => (await page.evaluate(() => window.agentHost.listConversations())).length === 1, 'Conversation creation')
      const [{ id }] = await page.evaluate(() => window.agentHost.listConversations())
      await send(page, '帮我创建一个简单的登录页面')
      await page.getByText('已创建简单登录页面', { exact: false }).waitFor()
      await waitForRun(page, id, 1, 'succeeded')
      let snapshot = await history(page, id)
      const sessionId = snapshot.conversation.piSessionId
      assert.ok(sessionId)
      assert.equal(snapshot.turns[0].tools[0].name, 'create_text_file')
      assert.equal(snapshot.turns[0].tools[0].status, 'succeeded')
      const { input, output, cacheRead, cacheWrite } = snapshot.turns[0].usage
      assert.ok(output > 0 && input + cacheRead + cacheWrite > 0)
      assert.match(await readFile(join(workspace, 'login.html'), 'utf8'), /name="username"/)
      await page.getByRole('button', { name: '展开活动面板' }).click()
      await page.getByRole('complementary', { name: '活动面板' }).getByText('create_text_file', { exact: false }).waitFor()
      await page.getByLabel('Token 用量').waitFor()

      await send(page, '再给它添加一个验证码输入框')
      await page.getByText('已在登录页中添加验证码输入框', { exact: false }).waitFor()
      await waitForRun(page, id, 2, 'succeeded')
      snapshot = await history(page, id)
      assert.equal(snapshot.conversation.piSessionId, sessionId)
      assert.notEqual(snapshot.turns[0].taskId, snapshot.turns[1].taskId)
      assert.notEqual(snapshot.turns[0].taskRunId, snapshot.turns[1].taskRunId)
      assert.notEqual(snapshot.turns[1].taskRunId, snapshot.turns[1].taskAttemptId)
      assert.match(await readFile(join(workspace, 'login.html'), 'utf8'), /name="captcha"/)

      await page.getByRole('button', { name: '会话模型设置' }).click()
      const modelDialog = page.getByRole('dialog', { name: '会话模型' })
      await modelDialog.getByLabel('模型 ID').fill('unavailable-test-model')
      await modelDialog.getByRole('button', { name: '保存模型' }).click()
      await modelDialog.getByRole('alert').waitFor()
      const unchanged = await history(page, id)
      assert.equal(unchanged.conversation.route.model, 'desktop-test')
      assert.equal(unchanged.conversation.piSessionId, sessionId)
      assert.equal(unchanged.conversation.pendingRoute, undefined)
      await modelDialog.getByLabel('模型 ID').fill('desktop-alt')
      await modelDialog.getByRole('button', { name: '保存模型' }).click()
      await modelDialog.waitFor({ state: 'hidden' })
      await page.locator('[data-model-pending]').waitFor()
      assert.match(await page.locator('[data-model-pending]').textContent(), /desktop-alt/)
      const pending = await history(page, id)
      assert.equal(pending.turns.length, 2)
      assert.equal(pending.conversation.route.model, 'desktop-test')
      assert.equal(pending.conversation.pendingRoute.model, 'desktop-alt')

      await send(page, '[steer] 检查当前页面')
      await page.getByRole('button', { name: '停止生成' }).waitFor()
      await waitForPartial(page, id, '[steer]')
      await page.locator('#composer-input').fill('仅保留现有验证码控件')
      await page.getByRole('button', { name: '追加指令' }).click()
      await waitForRun(page, id, 3, 'succeeded')
      snapshot = await history(page, id)
      assert.equal(snapshot.conversation.route.model, 'desktop-alt')
      assert.equal(snapshot.conversation.pendingRoute, undefined)
      assert.equal(snapshot.conversation.piSessionId, sessionId)
      await eventually(async () => (await page.locator('[data-model-current]').textContent()).includes('desktop-alt'), 'applied desktop model')
      assert.equal(snapshot.turns[2].instructions[0].text, '仅保留现有验证码控件')
      assert.match(snapshot.turns[2].assistant.text, /已应用追加指令：仅保留现有验证码控件/)

      await send(page, '[slow] 检查恢复')
      await waitForPartial(page, id, '[slow]')
      await page.getByRole('button', { name: '停止生成' }).click()
      await waitForRun(page, id, 4, 'stopped')
      const stopped = await history(page, id)
      assert.ok(stopped.turns[3].assistant.text.length > 20)
      await app.close()
      app = undefined

      app = await launch(data)
      const restored = await ready(app)
      await restored.getByText('已在登录页中添加验证码输入框', { exact: false }).waitFor()
      assert.deepEqual(await history(restored, id), stopped)
      await restored.getByRole('button', { name: '恢复执行' }).click()
      await waitForRun(restored, id, 4, 'succeeded')
      snapshot = await history(restored, id)
      assert.equal(snapshot.conversation.piSessionId, sessionId)
      assert.equal(snapshot.turns[3].taskRunId, stopped.turns[3].taskRunId)
      assert.notEqual(snapshot.turns[3].taskAttemptId, stopped.turns[3].taskAttemptId)
      await send(restored, '请简要总结修改')
      await waitForRun(restored, id, 5, 'succeeded')
      assert.equal((await history(restored, id)).conversation.piSessionId, sessionId)

      await send(restored, '[slow] 验证 Host 异常退出')
      await waitForPartial(restored, id, '[slow]')
      const beforeCrash = (await history(restored, id)).turns[5]
      await crashTestHost(app, data)
      await restored.getByRole('button', { name: '重启 Host' }).click()
      await eventually(async () => (await restored.evaluate(() => window.agentHost.getStatus())).state === 'ready', 'Host restart')
      await waitForRun(restored, id, 6, 'stopped')
      const recovered = (await history(restored, id)).turns[5]
      assert.equal(recovered.reason, 'process_interrupted')
      assert.equal(recovered.taskAttemptId, beforeCrash.taskAttemptId)
      assert.ok(recovered.assistant.text.startsWith(beforeCrash.assistant.text))
      await restored.getByRole('button', { name: '恢复执行' }).click()
      await waitForRun(restored, id, 6, 'succeeded')
      snapshot = await history(restored, id)
      assert.equal(snapshot.turns[5].taskAttemptId, beforeCrash.taskAttemptId)
      assert.equal(snapshot.turns[5].taskRunId, beforeCrash.taskRunId)
      assert.equal(snapshot.conversation.piSessionId, sessionId)

      await app.close()
      app = undefined
      const log = await readFile(join(data, 'logs', 'diagnostics.jsonl'), 'utf8')
      const diagnostics = log.trim().split('\n').map((line) => JSON.parse(line))
      for (const code of ['desktop.host_ready', 'desktop.host_crashed', 'host.model_started', 'host.tool_completed']) {
        assert.ok(diagnostics.some((entry) => entry.code === code), 'Missing desktop diagnostic ' + code)
      }
      assert.doesNotMatch(log, /请简要总结修改|仅保留现有验证码控件|login\.html|unavailable-test-model/)
    } catch (error) {
      const trace = await readFile(join(data, 'logs', 'diagnostics.jsonl'), 'utf8').catch(() => '')
      const codes = trace.match(/"code":"(?:desktop|host)\.[a-z_]+"/g)
      if (codes?.length) t.diagnostic(codes.slice(-12).join(', '))
      throw error
    } finally {
      await app?.close()
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  })
