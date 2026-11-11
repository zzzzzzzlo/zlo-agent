import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { localPort, validLocalToken } from '../../shared/loopback-http.ts'
import { Collector, TelemetryClient } from './collector.ts'
import { ObservatoryDatabase } from './database.ts'
import { Evaluator } from './evaluation.ts'
import { EvaluationJobs } from './evaluation-jobs.ts'
import { startDashboard } from './server.ts'

const env = process.env
const value = (name: string) => {
  const raw = env[name]
  if (!raw) return undefined
  const n = Number(raw)
  if (!/^\d+(?:\.\d+)?$/u.test(raw) || !Number.isFinite(n) || n < 0) throw new Error('Invalid evaluation setting')
  return n
}

async function run() {
  const hostToken = env.ZLO_TELEMETRY_TOKEN
  if (!validLocalToken(hostToken)) throw new Error('Set ZLO_TELEMETRY_TOKEN to a 32–128 character base64url token shared with the Host')
  const token = env.ZLO_OBSERVATORY_TOKEN ?? randomBytes(32).toString('base64url')
  if (hostToken === token) throw new Error('Use separate Host and dashboard tokens')
  const source = new TelemetryClient(localPort(env.ZLO_TELEMETRY_PORT, 4557), hostToken)
  const provider = env.ZLO_EVAL_PROVIDER
  const model = env.ZLO_EVAL_MODEL
  const apiKey = env.ZLO_EVAL_API_KEY
  if (provider || model || apiKey) {
    if ((provider !== 'openai' && provider !== 'deepseek') || !model || !/^[\w.-]{1,120}$/u.test(model) || !apiKey ||
      /^(?:sk[-_]|gh[pousr]_|eyJ)/u.test(model) || model === apiKey) throw new Error('Invalid evaluation provider configuration')
  }
  const evaluator = new Evaluator({ provider: provider === 'openai' || provider === 'deepseek' ? provider : undefined, model, apiKey,
    maxTokens: value('ZLO_EVAL_MAX_TOKENS'), maxRounds: value('ZLO_EVAL_MAX_ROUNDS'), timeoutMs: value('ZLO_EVAL_TIMEOUT_MS'),
    maxInputBytes: value('ZLO_EVAL_MAX_INPUT_BYTES'), inputUsdPerMillion: value('ZLO_EVAL_INPUT_USD_PER_MILLION'),
    outputUsdPerMillion: value('ZLO_EVAL_OUTPUT_USD_PER_MILLION') })
  const directory = resolve(env.ZLO_OBSERVATORY_DATA ?? join(env.LOCALAPPDATA ?? homedir(), 'ZloAgent', 'observatory'))
  const database = new ObservatoryDatabase(directory)
  const jobs = new EvaluationJobs(database, source, evaluator)
  const collector = new Collector(database, source, task => jobs.observe(task))
  try {
    const dashboard = await startDashboard({ port: localPort(env.ZLO_OBSERVATORY_PORT, 4558), token, database, collector, jobs, model })
    collector.start()
    // The fragment bootstraps this local browser session and is never sent in the HTTP URL.
    process.stdout.write(`Open Zlo Observatory at ${dashboard.origin}/#token=${token}\n`)
    await new Promise<void>(resolve => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
    await dashboard.close()
  } finally {
    await collector.close()
    await jobs.close()
    database.close()
  }
}

if (process.argv.includes('--help')) {
  process.stdout.write('Run npm start in observatory/ with ZLO_TELEMETRY_TOKEN set. See docs/23-observatory.md.\n')
} else {
  await run().catch(() => {
    process.stderr.write('Zlo Observatory could not start. Check the local ports, access tokens, data directory and evaluation configuration.\n')
    process.exitCode = 1
  })
}
