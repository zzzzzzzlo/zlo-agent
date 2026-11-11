import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { toolImages } from '../src/execution.ts'
import type { ToolImage } from '../src/execution.ts'
import { LocalAgentHost } from '../src/host.ts'
import { PiExecution } from '../src/pi.ts'
import { createPreviewTools } from '../src/preview-tools.ts'
import { CodingWorkspace } from '../src/workspace.ts'

const route = { provider: 'deepseek', model: 'deepseek-flash' }
const tasks = { pelican: '鹈鹕', crocodile: '鳄鱼' } as const
const baselinePath = process.argv[2], outputPath = process.argv[3], selected = process.argv[4], variant = process.argv[5]
const tokenBudget = Number(process.env.ZLO_VISUAL_BENCH_TOKENS ?? '160000')
if (!baselinePath || !outputPath || selected && selected !== 'both' && !Object.hasOwn(tasks, selected) ||
  variant && variant !== 'before' && variant !== 'after' || !process.env.DEEPSEEK_API_KEY ||
  !Number.isSafeInteger(tokenBudget) || tokenBudget < 80_000 || tokenBudget > 320_000) {
  process.stderr.write('Set DEEPSEEK_API_KEY locally. Usage: node host/scripts/visual-benchmark.ts <baseline checkout> <output directory> [both|pelican|crocodile] [before|after]\n')
  process.exit(2)
}
const key = process.env.DEEPSEEK_API_KEY
const output = resolve(outputPath)
await mkdir(output, { recursive: true })
const batch = await mkdtemp(join(output, 'run-'))
const baselineHost = await import(pathToFileURL(resolve(baselinePath, 'host/src/host.ts')).href) as typeof import('../src/host.ts')
const baselinePi = await import(pathToFileURL(resolve(baselinePath, 'host/src/pi.ts')).href) as typeof import('../src/pi.ts')

async function run(name: string, animal: string, phase: 'before' | 'after') {
  const root = join(batch, name, phase), workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  const execution = phase === 'before' ? new baselinePi.PiExecution() : new PiExecution()
  await execution.setProviderKey('deepseek', key)
  const Host = phase === 'before' ? baselineHost.LocalAgentHost : LocalAgentHost
  const host = new Host({ directory: join(root, 'state'), execution, modelLimits: { requests: 12, tokens: tokenBudget } })
  const started = performance.now()
  let stop: NodeJS.Timeout | undefined
  try {
    const goal = `在当前空工作区创建 index.html，以 SVG 绘制一只${animal}骑自行车的 2D 循环动画。` +
      '单文件内嵌 SVG、CSS、JavaScript，不使用外部资源或 Shell。视口 800×600，主体全身与两轮清晰可见。' +
      '自行车的两轮接地且车架稳定，脚随踏板运动，动画循环连续。用简洁的配色和构图，最后简短说明交付。'
    const { taskId } = await host.createTask({ requestId: 'visual-benchmark', cwd: workspace, goal, workspaceAccess: 'write', route, check: { path: 'index.html' } })
    stop = setTimeout(() => { try { host.stop(taskId, 'visual-benchmark-deadline') } catch {} }, 210_000)
    await host.idle()
    clearTimeout(stop)
    const task = host.getTask(taskId)
    const elapsedMs = Math.round(performance.now() - started)
    const events = host.events(taskId)
    const usage = events.filter(event => event.type === 'model.usage')
    const preview = events.filter(event => event.type === 'visual.preview_finished' && event.payload.rendered === true)
    const total = (field: string) => usage.length ? usage.reduce((sum, { payload }) => sum + Number(payload[field] ?? 0), 0) : null
    const render = await createPreviewTools(new CodingWorkspace(workspace))[0].execute('benchmark-review',
      { path: 'index.html', width: 800, height: 600, timesMs: [0, 450, 900] }) as { ok: boolean; samples?: unknown[]; [toolImages]?: ToolImage[] }
    for (const [index, frame] of (render[toolImages] ?? []).entries()) await writeFile(join(root, `frame-${index}.jpg`), frame.bytes)
    const result = { scenario: name, phase, tokenBudget, taskStatus: task.status, reason: task.reason, elapsedMs,
      modelRequests: events.filter(event => event.type === 'model.request_started').length,
      reportedUsage: usage.length, input: total('input'), output: total('output'), cacheRead: total('cacheRead'), cacheWrite: total('cacheWrite'),
      internalPreviews: preview.length, visualRounds: events.filter(event => event.type === 'visual.round_finished').map(event => event.payload),
      framesSent: events.filter(event => event.type === 'visual.frames_sent').reduce((sum, event) => sum + Number(event.payload.frames), 0),
      independentlyRendered: render.ok, samples: render.samples, root }
    await writeFile(join(root, 'summary.json'), JSON.stringify(result, null, 2))
    process.stdout.write(JSON.stringify(result) + '\n')
  } finally {
    clearTimeout(stop)
    await host.close()
  }
}

async function runScenarios() {
  const scenarios = Object.entries(tasks).filter(([name]) => !selected || selected === 'both' || name === selected)
  async function pair(name: string, animal: string) {
    const phases = (['before', 'after'] as const).filter(phase => !variant || phase === variant)
    const results = await Promise.allSettled(phases.map(phase => run(name, animal, phase)))
    if (!results.some(result => result.status === 'rejected')) return
    process.stderr.write(`Benchmark ${name} failed to capture at least one result.\n`)
    process.exitCode = 1
  }
  if (variant) await Promise.all(scenarios.map(([name, animal]) => pair(name, animal)))
  else for (const [name, animal] of scenarios) await pair(name, animal)
}

await runScenarios()
