import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createProcessTools } from '../src/process-tools.ts'
import { CodingWorkspace } from '../src/workspace.ts'
import type { ToolInvocationContext } from '../src/workspace.ts'

const windows = process.platform === 'win32'
const shell = windows ? 'powershell' : 'sh'

interface ToolResult {
  ok: boolean
  untrusted?: boolean
  error?: string
  code?: string
  processId: string
  state: string
  exitCode: number | null
  truncated: boolean
  cursor: number
  hasMore?: boolean
  totalFrames?: number
  tailStartCursor?: number
  truncationNotice?: string
  frames: { cursor: number; stream: string; text: string }[]
  capturedOutput?: { untrusted: boolean; frames: ToolResult['frames'] }
}

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'zlo-process-tools-'))
  const tools = createProcessTools(new CodingWorkspace(root))
  const operations: Parameters<ToolInvocationContext['defer']>[0][] = []
  const context: ToolInvocationContext = {
    taskId: 'task', agentRunId: 'agent',
    defer: operation => { operations.push(operation) },
    onCleanup: () => {},
  }
  async function invoke(name: string, input: unknown, owner: ToolInvocationContext | null = context, signal?: AbortSignal) {
    const tool = tools.find(item => item.name === name)
    assert.ok(tool, name)
    return await tool.execute('call', input, signal, owner ?? undefined) as ToolResult
  }
  t.after(async () => {
    await Promise.allSettled(operations.map(operation => operation.stop()))
    if (dirname(root) === tmpdir()) await rm(root, { recursive: true, force: true })
  })
  return { root, tools, operations, context, invoke }
}

async function until<T>(read: () => Promise<T | undefined>, timeout = 12_000): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await delay(25)
  }
  throw new Error('Condition did not occur before deadline')
}

test('authorized shell streams complete redacted frames and settles the original receipt at exit', async t => {
  const { root, operations, context, invoke } = await setup(t)
  const processEnvironmentSecret = 'zlo-private-env-credential-for-test'
  process.env.ZLO_PROCESS_TEST_API_KEY = processEnvironmentSecret
  t.after(() => { delete process.env.ZLO_PROCESS_TEST_API_KEY })
  await mkdir(join(root, 'subdir'))
  const command = windows
    ? "[Console]::WriteLine('ready'); [Console]::WriteLine('Cookie: sid=test-private-value'); [Console]::WriteLine([Environment]::GetEnvironmentVariable('ZLO_PROCESS_TEST_API_KEY')); [Console]::Write('incomplete'); while (-not [IO.File]::Exists('release.flag')) { Start-Sleep -Milliseconds 30 }; [Console]::WriteLine('-line'); exit 7"
    : String.raw`printf 'ready\nCookie: sid=test-private-value\n%s\nincomplete' "$ZLO_PROCESS_TEST_API_KEY"; while [ ! -f release.flag ]; do sleep 0.03; done; printf '%s\n' '-line'; exit 7`
  const launched = await invoke('shell_exec', { shell, command, path: 'subdir', timeoutMs: 20_000 })
  assert.equal(launched.ok, true)
  assert.match(launched.processId, /^[\da-f-]{36}$/)
  assert.equal(operations.length, 1)
  const processId = launched.processId
  const first = await until(async () => {
    const output = await invoke('process_output', { processId })
    return output.frames.some(frame => frame.text.includes('[redacted]')) ? output : undefined
  })
  assert.equal(first.state, 'running')
  assert.equal(first.untrusted, true)
  const visible = first.frames.map(frame => frame.text).join('')
  assert.match(visible, /ready/)
  assert.doesNotMatch(visible, /test-private-value|incomplete/)
  assert.ok(!visible.includes(processEnvironmentSecret))
  assert.equal(await Promise.race([operations[0]!.completion, Promise.resolve('pending')]), 'pending')
  assert.equal((await invoke('process_status', { processId }, { ...context, agentRunId: 'other' })).ok, false)
  assert.equal((await invoke('process_output', { processId }, { ...context, taskId: 'other' })).ok, false)
  assert.equal((await invoke('process_stop', { processId }, { ...context, taskId: 'other' })).ok, false)
  assert.equal((await invoke('shell_exec', { shell, command })).ok, false)
  assert.equal((await invoke('process_status', { processId, waitMs: 300_001 })).ok, false)
  const controller = new AbortController()
  const cancelledWait = invoke('process_status', { processId, waitMs: 300_000 }, context, controller.signal)
  controller.abort()
  assert.equal((await cancelledWait).state, 'running')
  const longWait = invoke('process_status', { processId, waitMs: 300_000 })
  await writeFile(join(root, 'subdir', 'release.flag'), '')
  assert.equal(await operations[0]!.completion, 'failed')
  const final = await longWait
  assert.equal(final.state, 'exited')
  assert.equal(final.exitCode, 7)
  assert.equal(final.ok, false)
  assert.equal(final.code, 'PROCESS_FAILED')
  const tail = await invoke('process_output', { processId, after: first.cursor })
  assert.match(tail.frames.map(frame => frame.text).join(''), /incomplete-line/)
  assert.ok(tail.frames.every(frame => frame.cursor > first.cursor))
})

test('CMD supports explicit quoting and propagates the true exit code', { skip: !windows }, async t => {
  const { invoke, operations } = await setup(t)
  const result = await invoke('shell_exec', { shell: 'cmd', command: 'echo "zlo space"&exit /b 23' })
  assert.equal(result.ok, true)
  assert.equal(await operations[0]!.completion, 'failed')
  const status = await invoke('process_status', { processId: result.processId })
  assert.equal(status.exitCode, 23)
  const output = await invoke('process_output', { processId: result.processId })
  assert.match(output.frames[0].text, /"zlo space"/)
})

test('process_stop confirms the controlled tree stopped and returns redacted partial output', { timeout: 25_000 }, async t => {
  const { root, invoke, operations } = await setup(t)
  const script = join(root, 'child.cjs')
  await writeFile(script, [
    "const { writeFileSync } = require('node:fs')",
    "console.log('partial test progress')",
    "console.log('Cookie: sid=stop-private-fixture')",
    "writeFileSync('started.flag', '')",
    "setTimeout(() => writeFileSync('escaped.txt', 'ran'), 4500)",
  ].join('\n'))
  const command = windows
    ? `& '${process.execPath.replaceAll("'", "''")}' '${script.replaceAll("'", "''")}'`
    : `"${process.execPath}" "${script}" & wait`
  const launched = await invoke('shell_exec', { shell, command })
  assert.equal(launched.ok, true)
  const processId = launched.processId
  await until(async () => {
    try {
      await access(join(root, 'started.flag'))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const status = await invoke('process_status', { processId })
      if (status.state !== 'running' && status.state !== 'starting') {
        const output = await invoke('process_output', { processId })
        assert.fail('Managed child ended before readiness: ' + JSON.stringify(output.frames))
      }
    }
  })
  const result = await invoke('process_stop', { processId })
  assert.equal(result.state, 'stopped')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'PROCESS_INTERRUPTED')
  assert.equal(result.exitCode, null)
  assert.equal(result.capturedOutput?.untrusted, true)
  const captured = result.capturedOutput?.frames.map(frame => frame.text).join('') ?? ''
  assert.match(captured, /partial test progress/u)
  assert.match(captured, /\[redacted\]/u)
  assert.doesNotMatch(captured, /stop-private-fixture/u)
  assert.equal(await operations[0]!.completion, 'interrupted')
  await delay(4_700)
  await assert.rejects(access(join(root, 'escaped.txt')), { code: 'ENOENT' })
})

test('shell enforces bounded input, output, timeout and task abort', async t => {
  const { invoke, operations, tools } = await setup(t)
  assert.equal(tools.find(tool => tool.name === 'shell_exec')?.policy?.approval, 'shell')
  assert.equal((await invoke('shell_exec', { shell, command: 'x', path: '..' })).ok, false)
  assert.equal((await invoke('shell_exec', { shell, command: 'line\nbreak' })).ok, false)
  assert.equal((await invoke('shell_exec', { shell, command: 'x' }, null)).ok, false)
  const flood = windows ? "for ($i=0; $i -lt 400; $i++) { [Console]::WriteLine(('a' * 256)) }"
    : String.raw`i=0; while [ "$i" -lt 400 ]; do printf '%0256d\n' 0; i=$((i+1)); done`
  const launched = await invoke('shell_exec', { shell, command: flood })
  assert.equal(launched.ok, true)
  assert.equal(await operations[0]!.completion, 'succeeded')
  const capped = await invoke('process_output', { processId: launched.processId, limit: 32 })
  assert.ok(capped.truncated)
  assert.ok(capped.frames.length <= 32)
  assert.ok(Buffer.byteLength(capped.frames.map(frame => frame.text).join('')) <= 16 * 1024)
  const blocking = windows ? 'Start-Sleep -Seconds 50' : 'sleep 50'
  const timed = await invoke('shell_exec', { shell, command: blocking, timeoutMs: 300 })
  assert.equal(timed.ok, true)
  assert.equal(await operations[1]!.completion, 'interrupted')
  const timedStatus = await invoke('process_status', { processId: timed.processId })
  assert.equal(timedStatus.state, 'timed_out')
  assert.equal(timedStatus.code, 'PROCESS_TIMEOUT')
  const abort = new AbortController()
  const cancelled = await invoke('shell_exec', { shell, command: blocking }, undefined, abort.signal)
  assert.equal(cancelled.ok, true)
  abort.abort()
  assert.equal(await operations[2]!.completion, 'interrupted')
  assert.equal((await invoke('process_status', { processId: cancelled.processId })).state, 'stopped')
})

test('the output cap retains and redacts tail credentials while discarding oversized credential lines', async t => {
  const { invoke, operations } = await setup(t)
  const command = windows
    ? "for ($i=0; $i -lt 15; $i++) { [Console]::Write(('x' * 4095) + [char]10) }; [Console]::Write(('x' * 4086) + [char]10); [Console]::WriteLine('sk-probe-xxxxxxxxxxxxxxxxxxxxxxxx'); [Console]::Write(('y' * 4096) + 'sk-probe-yyyyyyyyyyyyyyyyyyyyyyyy' + [char]10); [Console]::WriteLine('AFTER_OVERSIZED')"
    : String.raw`i=0; while [ "$i" -lt 15 ]; do printf '%04095d\n' 0; i=$((i+1)); done; printf '%04086d\n' 0; printf 'sk-probe-xxxxxxxxxxxxxxxxxxxxxxxx\n'; printf '%04096d' 0; printf 'sk-probe-yyyyyyyyyyyyyyyyyyyyyyyy\nAFTER_OVERSIZED\n'`
  const launched = await invoke('shell_exec', { shell, command })
  assert.equal(launched.ok, true)
  assert.equal(await operations[0]!.completion, 'succeeded')
  let after = 0
  const visible: string[] = []
  for (let page = 0; page < 12; page++) {
    const output = await invoke('process_output', { processId: launched.processId, after })
    assert.equal(output.untrusted, true)
    assert.equal(output.truncated, true)
    visible.push(...output.frames.map(frame => frame.text))
    if (!output.hasMore || output.cursor === after) break
    after = output.cursor
  }
  const joined = visible.join('')
  assert.match(joined, /\[redacted\]/u)
  assert.match(joined, /AFTER_OVERSIZED/u)
  assert.doesNotMatch(joined, /sk-probe/)
})

test('ProcessOutput preserves head, middle diagnostic lines, and latest tail past 256 frames / 64 KiB', async t => {
  const { root, invoke, operations, context } = await setup(t)
  const script = join(root, 'noisy-build.cjs')
  await writeFile(script, [
    "console.log('HEADER_START_LINE')",
    "for (let i = 1; i <= 420; i++) {",
    "  if (i === 120) console.error('src/app.ts(12,3): error TS2345: Type string is not assignable')",
    "  else console.log('noise line ' + i + ' ' + 'z'.repeat(240))",
    "}",
    "console.error('FINAL_SUMMARY_FAIL')",
    "process.exitCode = 1",
  ].join('\n'))
  const command = windows
    ? `& '${process.execPath.replaceAll("'", "''")}' '${script.replaceAll("'", "''")}'`
    : `"${process.execPath}" "${script}"`
  const launched = await invoke('shell_exec', { shell, command })
  assert.equal(launched.ok, true)
  assert.equal(await operations[0]!.completion, 'failed')

  const collected: string[] = []
  let after = 0
  let firstPage: ToolResult | undefined
  for (let i = 0; i < 32; i++) {
    const page = await invoke('process_output', { processId: launched.processId, after, limit: 32 })
    if (!firstPage) firstPage = page
    assert.equal(page.ok, true)
    assert.equal(page.untrusted, true)
    assert.equal(page.truncated, true)
    collected.push(...page.frames.map(frame => frame.text))
    if (!page.hasMore || page.cursor === after) break
    after = page.cursor
  }
  const full = collected.join('')
  assert.ok(firstPage?.tailStartCursor && firstPage.tailStartCursor > 100)
  assert.ok((firstPage?.totalFrames ?? 0) > 300)
  assert.match(firstPage?.truncationNotice ?? '', /tailStartCursor/u)
  assert.match(full, /HEADER_START_LINE/u)
  assert.match(full, /omitted output line/u)
  assert.match(full, /error TS2345: Type string is not assignable/u)
  assert.match(full, /FINAL_SUMMARY_FAIL/u)

  // Jumping directly to tail past cursor 256 must work without hitting maxFrames input cap.
  const jumped = await invoke('process_output', {
    processId: launched.processId,
    after: firstPage!.tailStartCursor! - 1,
    limit: 32,
  })
  assert.equal(jumped.ok, true)
  assert.ok(jumped.frames.length > 0)

  // Subsequent runs keep isolated process handles cleanly without leaking across runs.
  const secondRun = { ...context, agentRunId: 'agent-2' }
  const second = await invoke('shell_exec', {
    shell,
    command: windows ? '[Console]::WriteLine("run2-ok")' : 'printf "run2-ok\\n"',
  }, secondRun)
  assert.equal(second.ok, true)
  assert.equal(await operations[1]!.completion, 'succeeded')
  assert.equal((await invoke('process_output', { processId: launched.processId }, secondRun)).ok, false)
  assert.match((await invoke('process_output', { processId: second.processId }, secondRun)).frames[0]!.text, /run2-ok/u)
})

test('P1-3: process_stop terminates inherited-pipe descendants even after the top-level shell has already exited', { timeout: 25_000 }, async t => {
  const { root, invoke, operations } = await setup(t)
  const script = join(root, 'bg-descendant.cjs')
  await writeFile(script, [
    "const { writeFileSync } = require('node:fs')",
    "const { join } = require('node:path')",
    "writeFileSync(join(__dirname, 'bg-ready.flag'), '')",
    "setTimeout(() => writeFileSync(join(__dirname, 'bg-escaped.txt'), 'ran'), 8500)",
  ].join('\n'))
  const launched = windows
    ? await invoke('shell_exec', { shell: 'cmd', command: `start /b "" "${process.execPath}" "${script}" & exit /b 0` })
    : await invoke('shell_exec', { shell: 'sh', command: `"${process.execPath}" "${script}" & exit 0` })
  assert.equal(launched.ok, true)
  await until(async () => {
    try { await access(join(root, 'bg-ready.flag')); return true } catch { return undefined }
  })
  await delay(150)
  const stopped = await invoke('process_stop', { processId: launched.processId })
  assert.equal(stopped.state, 'stopped')
  assert.equal(await operations[0]!.completion, 'interrupted')
  await delay(8_700)
  await assert.rejects(access(join(root, 'bg-escaped.txt')), { code: 'ENOENT' })
})
