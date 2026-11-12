import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { before, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { _electron as electron } from 'playwright-core'

const appPath = resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const exec = promisify(execFile)
let executablePath

before(async () => {
  if (process.platform !== 'win32') return
  // Electron's npm entry point downloads the binary on a clean install.
  executablePath = require('electron')
  try {
    const { stdout } = await exec(executablePath, ['-p', 'process.versions.electron'], {
      cwd: appPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 12_000,
    })
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/u)
  } catch (error) {
    const code = typeof error.code === 'number' ? '0x' + (error.code >>> 0).toString(16) : error.code ?? 'unknown'
    throw new Error(`Electron could not start in Node mode before opening a GUI or acquiring a profile lock (${code}).`,
      { cause: error })
  }
})

async function eventually(predicate, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(50)
  }
  throw new Error('Timed out waiting for ' + label)
}

async function launch(data, mode = 'faux') {
  const env = { ...process.env, ZLO_AGENT_DESKTOP_MODE: mode, ZLO_AGENT_DESKTOP_DATA: data }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  return electron.launch({
    executablePath, args: ['--enable-logging=stderr', '--user-data-dir=' + data, appPath], cwd: appPath,
    env, chromiumSandbox: true, timeout: 20000,
  })
}

async function ready(app, data) {
  const page = await app.firstWindow()
  const profile = await app.evaluate(({ app }) => ({
    userData: app.getPath('userData'),
    ownsLock: app.hasSingleInstanceLock(),
  }))
  assert.equal(profile.userData, resolve(data))
  assert.equal(profile.ownsLock, true)
  await eventually(async () => {
    const status = await page.evaluate(() => window.agentHost?.getStatus())
    if (status?.state === 'offline') throw new Error('Host is offline: ' + status.message)
    return status?.state === 'ready'
  }, 'Host Ready', 50_000)
  assert.deepEqual(await page.evaluate(() => ({
    node: typeof process,
    require: typeof require,
    invoke: typeof window.agentHost.invoke,
    readKey: typeof window.agentManagement?.getProviderKey,
    credentialInvoke: typeof window.agentManagement?.invoke,
  })), { node: 'undefined', require: 'undefined', invoke: 'undefined', readKey: 'undefined', credentialInvoke: 'undefined' })
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
      const page = await ready(app, data)
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
      await page.setViewportSize({ width: 1000, height: 720 })
      await page.getByRole('button', { name: '展开会话中台' }).click()
      const activity = page.getByRole('complementary', { name: '会话中台' })
      await activity.getByRole('region', { name: '运行明细' }).getByText('create_text_file', { exact: false }).waitFor()
      assert.equal(await activity.evaluate(panel => getComputedStyle(panel).position), 'absolute')
      await page.getByLabel('Token 用量').waitFor()
      await activity.getByRole('button', { name: '关闭会话中台' }).click()
      await activity.waitFor({ state: 'hidden' })

      await send(page, '再给它添加一个验证码输入框')
      await page.getByText('已在登录页中添加验证码输入框', { exact: false }).waitFor()
      await waitForRun(page, id, 2, 'succeeded')
      snapshot = await history(page, id)
      assert.equal(snapshot.conversation.piSessionId, sessionId)
      assert.notEqual(snapshot.turns[0].taskId, snapshot.turns[1].taskId)
      assert.notEqual(snapshot.turns[0].taskRunId, snapshot.turns[1].taskRunId)
      assert.notEqual(snapshot.turns[1].taskRunId, snapshot.turns[1].taskAttemptId)
      assert.match(await readFile(join(workspace, 'login.html'), 'utf8'), /name="captcha"/)
      await page.getByRole('button', { name: '展开会话中台' }).click()
      const totals = await page.evaluate(conversationId => window.agentManagement.conversationObservatory({ conversationId }), id)
      const tokens = snapshot.turns.reduce((sum, turn) => sum + Object.values(turn.usage).reduce((a, b) => a + b, 0), 0)
      const tools = snapshot.turns.reduce((sum, turn) => sum + turn.tools.length, 0)
      assert.equal(totals.turns, 2)
      assert.equal(await activity.locator('[data-observatory-tokens]').textContent(), tokens.toLocaleString('zh-CN'))
      assert.equal(await activity.locator('[data-observatory-tools]').textContent(), tools.toLocaleString('zh-CN'))
      if (process.env.ZLO_UI_REVIEW_DIR) await page.screenshot({ path: join(process.env.ZLO_UI_REVIEW_DIR, 'conversation.png') })
      await activity.getByRole('button', { name: '关闭会话中台' }).click()

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
      const restored = await ready(app, data)
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
      await eventually(async () => (await restored.evaluate(() => window.agentManagement.recentDiagnostics()))
        .some(entry => entry.code === 'desktop.host_crashed'), 'redacted diagnostic while Host is offline')
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

test('Windows Electron authorizes a writable workspace without a file check and confirms trusted project execution',
  { skip: process.platform !== 'win32', timeout: 60000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'zlo-electron-grants-'))
    const writable = join(root, 'writable')
    const trusted = join(root, 'trusted')
    const data = join(root, 'desktop-data')
    await Promise.all([mkdir(writable), mkdir(trusted)])
    await writeFile(join(trusted, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node verify.cjs' } }))
    await writeFile(join(trusted, 'verify.cjs'), 'require("node:fs").writeFileSync("tested.txt", "verified")\n')
    let app
    try {
      app = await launch(data)
      const page = await ready(app, data)
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
        dialog.showMessageBox = async () => { throw new Error('Unexpected trust request for file-only access') }
      }, writable)
      await page.getByRole('button', { name: /新建会话/ }).click()
      await page.getByLabel('会话名称').fill('独立写入授权')
      await page.getByRole('button', { name: '选择工作区' }).click()
      assert.equal(await page.getByLabel('工作区权限').inputValue(), 'write')
      assert.equal(await page.getByLabel('验收文件（相对路径）').inputValue(), '')
      await page.getByRole('button', { name: '创建会话' }).click()
      await page.getByRole('button', { name: '创建会话' }).waitFor({ state: 'hidden' })
      const [writeConversation] = await page.evaluate(() => window.agentHost.listConversations())
      assert.equal(writeConversation.workspaceAccess, 'write')
      assert.equal(writeConversation.check, undefined)
      await send(page, '帮我创建一个简单的登录页面')
      await waitForRun(page, writeConversation.id, 1, 'succeeded')
      assert.match(await readFile(join(writable, 'login.html'), 'utf8'), /name="username"/)
      const writeTurn = (await history(page, writeConversation.id)).turns[0]
      assert.ok(writeTurn.tools.some(({ name, status }) => name === 'create_text_file' && status === 'succeeded'))
      assert.equal(writeTurn.verification.verdict, 'unverified')
      assert.equal(writeTurn.verification.passed, false)
      await page.getByText('目标尚未验证', { exact: true }).first().waitFor()
      await send(page, '[team-check] 请用团队核对登录页')
      await waitForRun(page, writeConversation.id, 2, 'succeeded')
      const teamTurn = (await history(page, writeConversation.id)).turns[1]
      assert.deepEqual(teamTurn.nodes?.map(({ role, status }) => [role, status]), [['team', 'succeeded'], ['worker', 'succeeded']])
      await page.getByRole('button', { name: '展开会话中台' }).click()
      const activity = page.getByRole('complementary', { name: '会话中台' })
      await activity.getByText('Team Agent', { exact: true }).waitFor()
      await activity.getByRole('button', { name: '查看任务详情' }).click()
      const tasks = page.getByRole('main', { name: 'Agent 与任务' })
      await tasks.getByRole('heading', { name: '任务 DAG' }).waitFor()
      await tasks.getByRole('heading', { name: 'Agent Tree' }).waitFor()
      await tasks.getByText(/^Worker · /).first().waitFor()
      assert.equal(await tasks.getByLabel('任务历史').inputValue(), teamTurn.taskId)
      await tasks.getByRole('button', { name: '返回对话' }).click()
      await activity.getByRole('button', { name: '关闭会话中台' }).click()
      await activity.waitFor({ state: 'hidden' })

      const exported = join(root, 'exported-login.html')
      await app.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async (_window, options) => {
          if (options.defaultPath !== 'login.html') throw new Error('Unexpected suggested artifact')
          return { canceled: false, filePath }
        }
      }, exported)
      await send(page, '[export-check] 导出登录页面')
      await waitForRun(page, writeConversation.id, 3, 'succeeded')
      assert.equal(await readFile(exported, 'utf8'), await readFile(join(writable, 'login.html'), 'utf8'))
      assert.ok((await history(page, writeConversation.id)).turns[2].tools
        .some(({ name, status }) => name === 'export_artifact' && status === 'succeeded'))

      // Exercise the trusted consent handler for both responses while leaving the
      // Renderer, Preload, IPC, Host and real local project command paths intact.
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
        dialog.showMessageBox = async (_window, options) => {
          if (!options.detail.includes(path) || options.defaultId !== 0 || options.cancelId !== 0) {
            throw new Error('Unsafe trust prompt')
          }
          return { response: 0 }
        }
      }, trusted)
      await page.getByRole('button', { name: /新建会话/ }).click()
      await page.getByLabel('会话名称').fill('受信任项目验收')
      await page.getByRole('button', { name: '选择工作区' }).click()
      await page.getByLabel('工作区权限').selectOption('trusted')
      await page.getByLabel('验收方式').selectOption('command')
      assert.equal(await page.getByLabel('验收命令').inputValue(), 'npm_test')
      await page.getByRole('button', { name: '创建会话' }).click()
      await page.getByRole('dialog', { name: '新建会话' }).getByText(/已取消运行项目代码的授权/).waitFor()
      assert.equal((await page.evaluate(() => window.agentHost.listConversations())).length, 1)
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      await page.getByRole('button', { name: '创建会话' }).click()
      await page.getByRole('button', { name: '创建会话' }).waitFor({ state: 'hidden' })
      const trustedConversation = (await page.evaluate(() => window.agentHost.listConversations()))
        .find(({ title }) => title === '受信任项目验收')
      assert.equal(trustedConversation.workspaceAccess, 'trusted')
      assert.deepEqual(trustedConversation.check, { command: { command: 'npm_test', path: '.' } })
      await send(page, '帮我创建一个简单的登录页面')
      await waitForRun(page, trustedConversation.id, 1, 'succeeded')
      const result = await history(page, trustedConversation.id)
      assert.deepEqual(result.turns[0].verification, {
        passed: true, evidence: 'workspace_command_passed', verdict: 'verified', basis: 'project_command',
      })
      assert.equal(await readFile(join(trusted, 'tested.txt'), 'utf8'), 'verified')

      const permissionControl = page.getByRole('button', { name: '会话权限设置' })
      await permissionControl.click()
      const permissionDialog = page.getByRole('dialog', { name: '会话权限' })
      const access = permissionDialog.getByLabel('当前会话权限')
      await access.waitFor()
      assert.equal(await access.inputValue(), 'trusted')
      await access.selectOption('read')
      await permissionDialog.getByRole('button', { name: '保存权限' }).click()
      await permissionDialog.waitFor({ state: 'hidden' })
      await permissionControl.getByText('只读', { exact: true }).waitFor()
      const revised = (await page.evaluate(() => window.agentHost.listConversations()))
        .find(({ id }) => id === trustedConversation.id)
      assert.equal(revised.workspaceAccess, 'read')
      const nav = page.getByRole('navigation', { name: '工作台' })
      await nav.getByRole('button', { name: '权限与安全' }).click()
      assert.equal(await page.getByRole('main', { name: '权限与安全' }).getByLabel('当前会话权限').inputValue(), 'read')
      await nav.getByRole('button', { name: '工具与插件' }).click()
      const tools = page.getByRole('main', { name: '工具与插件' })
      await tools.getByRole('heading', { name: '已安装的工具' }).waitFor()
      await tools.getByRole('checkbox', { name: 'create_text_file 已启用' }).waitFor()
      await tools.getByLabel('筛选工具').fill('search_files')
      const searchTool = tools.getByRole('checkbox', { name: 'search_files 已启用' })
      await searchTool.waitFor()
      assert.equal(await searchTool.isChecked(), true)
      await searchTool.click()
      await eventually(async () => !(await searchTool.isChecked()), 'disabled file search')
      await nav.getByRole('button', { name: '记忆与上下文' }).click()
      const memoryPage = page.getByRole('main', { name: '记忆与上下文' })
      await memoryPage.getByRole('heading', { name: '检索记录' }).waitFor()
      const memory = memoryPage.getByText('Project verification passed using npm_test', { exact: true })
      await memory.waitFor()
      await memoryPage.getByRole('button', { name: '删除已列出的记忆' }).click()
      await memory.waitFor({ state: 'hidden' })
      assert.deepEqual((await page.evaluate(conversationId => window.agentManagement.snapshot({ conversationId }),
        trustedConversation.id)).memory.entries, [])
      await nav.getByRole('button', { name: '用量与诊断' }).click()
      const diagnosticsPage = page.getByRole('main', { name: '用量与诊断' })
      await diagnosticsPage.getByRole('heading', { name: '近期诊断' }).waitFor()
      await diagnosticsPage.getByRole('heading', { name: '异常核对' }).waitFor()
      const diagnostics = await page.evaluate(conversationId => window.agentManagement.snapshot({ conversationId }),
        trustedConversation.id)
      assert.ok(diagnostics.tasks[0].usage.output > 0)
      assert.ok(diagnostics.tasks[0].budget.tokenLimit > diagnostics.tasks[0].budget.confirmed)
      await nav.getByRole('button', { name: '模型与账号' }).click()
      const models = page.getByRole('main', { name: '模型与账号' })
      await models.getByRole('button', { name: 'ChatGPT 账号' }).click()
      await models.getByRole('heading', { name: 'ChatGPT / Codex 账号' }).waitFor()
      await page.getByRole('button', { name: /^设置/ }).click()
      const settings = page.getByRole('dialog', { name: '设置' })
      await settings.getByRole('button', { name: '关于' }).click()
      const version = await app.evaluate(({ app }) => app.getVersion())
      await settings.getByText('v' + version, { exact: true }).waitFor()
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

test('Windows Electron sends credential capture through Main and omits invalid clipboard contents from Renderer',
  { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
    const data = await mkdtemp(join(tmpdir(), 'zlo-electron-credentials-'))
    const canary = 'ZLO canary invalid provider key from Main'
    let app
    try {
      app = await launch(data, 'pi')
      const page = await ready(app, data)
      const consoleOutput = []
      page.on('console', (message) => consoleOutput.push(message.text()))
      page.on('pageerror', (error) => consoleOutput.push(error.message))
      // Stub native input in Main only. The Renderer, Preload, real credential
      // handler and local credential validation are exercised as shipped.
      await app.evaluate(({ clipboard, dialog }, text) => {
        clipboard.readText = () => text
        dialog.showMessageBox = async (_window, options) => {
          if (options.defaultId !== 0 || options.cancelId !== 0 || options.detail.includes(text)) {
            throw new Error('Unsafe credential consent prompt')
          }
          return { response: 1 }
        }
      }, canary)

      await page.getByRole('navigation', { name: '工作台' }).getByRole('button', { name: '模型与账号' }).click()
      const models = page.getByRole('main', { name: '模型与账号' })
      const provider = models.locator('details').filter({ hasText: 'DeepSeek' })
      await provider.locator('summary').click()
      if (process.env.ZLO_UI_REVIEW_DIR) await page.screenshot({ path: join(process.env.ZLO_UI_REVIEW_DIR, 'api.png') })
      await provider.getByRole('button', { name: /API Key/ }).filter({ hasText: /添加|更新/ }).click()
      await models.getByText(/剪贴板中没有有效格式的 API Key/).waitFor()

      const exposed = await page.evaluate(async () => ({
        dom: document.documentElement.outerHTML,
        local: { ...localStorage },
        session: { ...sessionStorage },
        snapshot: await window.agentManagement.snapshot({}),
      }))
      assert.ok(!JSON.stringify(exposed).includes(canary))
      assert.ok(!consoleOutput.join('\n').includes(canary))
      const log = await readFile(join(data, 'logs', 'diagnostics.jsonl'), 'utf8').catch(() => '')
      assert.ok(!log.includes(canary))
      await assert.rejects(readFile(join(data, 'provider-credentials.bin')), { code: 'ENOENT' })
    } finally {
      await app?.close()
      await rm(data, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  })
