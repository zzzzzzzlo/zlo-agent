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
  error?: string
  processId: string
  state: string
  exitCode: number | null
  truncated: boolean
  cursor: number
  frames: { cursor: number; stream: string; text: string }[]
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
  const visible = first.frames.map(frame => frame.text).join('')
  assert.match(visible, /ready/)
  assert.doesNotMatch(visible, /test-private-value|incomplete/)
  assert.ok(!visible.includes(processEnvironmentSecret))
  assert.equal(await Promise.race([operations[0]!.completion, Promise.resolve('pending')]), 'pending')
  assert.equal((await invoke('process_status', { processId }, { ...context, agentRunId: 'other' })).ok, false)
  assert.equal((await invoke('process_output', { processId }, { ...context, taskId: 'other' })).ok, false)
  assert.equal((await invoke('process_stop', { processId }, { ...context, taskId: 'other' })).ok, false)
  assert.equal((await invoke('shell_exec', { shell, command })).ok, false)
  await writeFile(join(root, 'subdir', 'release.flag'), '')
  assert.equal(await operations[0]!.completion, 'failed')
  const final = await invoke('process_status', { processId })
  assert.equal(final.state, 'exited')
  assert.equal(final.exitCode, 7)
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

test('process_stop stops the controlled child tree and keeps the original write outcome unknown', async t => {
  const { root, invoke, operations } = await setup(t)
  const program = "setTimeout(()=>require('node:fs').writeFileSync('escaped.txt','ran'),4500)"
  const command = windows
    ? `$child = Start-Process -FilePath '${process.execPath.replaceAll("'", "''")}' -ArgumentList '-e',"${program}" -WindowStyle Hidden -PassThru; [Console]::WriteLine('started'); Wait-Process -Id $child.Id`
    : `"${process.execPath}" -e "${program}" & printf 'started\\n'; wait`
  const launched = await invoke('shell_exec', { shell, command })
  assert.equal(launched.ok, true)
  const processId = launched.processId
  await until(async () => {
    const output = await invoke('process_output', { processId })
    return output.frames.some(frame => frame.text.includes('started')) ? output : undefined
  })
  const result = await invoke('process_stop', { processId })
  assert.equal(result.state, 'stopped')
  assert.equal(await operations[0]!.completion, 'unknown_effect')
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
  assert.equal(await operations[1]!.completion, 'unknown_effect')
  assert.equal((await invoke('process_status', { processId: timed.processId })).state, 'timed_out')
  const abort = new AbortController()
  const cancelled = await invoke('shell_exec', { shell, command: blocking }, undefined, abort.signal)
  assert.equal(cancelled.ok, true)
  abort.abort()
  assert.equal(await operations[2]!.completion, 'unknown_effect')
  assert.equal((await invoke('process_status', { processId: cancelled.processId })).state, 'stopped')
})

test('the output cap discards a credential-bearing line cut in the middle', async t => {
  const { invoke, operations } = await setup(t)
  const command = windows
    ? "for ($i=0; $i -lt 15; $i++) { [Console]::Write(('x' * 4095) + [char]10) }; [Console]::Write(('x' * 4086) + [char]10); [Console]::WriteLine('sk-probe-xxxxxxxxxxxxxxxxxxxxxxxx')"
    : String.raw`i=0; while [ "$i" -lt 15 ]; do printf '%04095d\n' 0; i=$((i+1)); done; printf '%04086d\n' 0; printf 'sk-probe-xxxxxxxxxxxxxxxxxxxxxxxx\n'`
  const launched = await invoke('shell_exec', { shell, command })
  assert.equal(launched.ok, true)
  assert.equal(await operations[0]!.completion, 'succeeded')
  let after = 0
  const visible: string[] = []
  for (let page = 0; page < 6; page++) {
    const output = await invoke('process_output', { processId: launched.processId, after })
    assert.equal(output.truncated, true)
    visible.push(...output.frames.map(frame => frame.text))
    if (output.cursor === after) break
    after = output.cursor
  }
  assert.equal(visible.length, 16)
  assert.doesNotMatch(visible.join(''), /sk-probe/)
})
