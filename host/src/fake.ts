import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentExecution, ExecutionConfig, ExecutionSession, ModelRoute } from './execution.ts'

const defaultRoute = { provider: 'fake', model: 'coding' }

export class FakeExecution implements AgentExecution {
  async validateRoute(route: ModelRoute): Promise<void> {
    if (route.provider !== 'fake' || !['coding', 'alternate'].includes(route.model)) {
      throw new Error('Fake routes are fake/coding and fake/alternate')
    }
  }

  async open(config: ExecutionConfig): Promise<ExecutionSession> {
    await mkdir(config.sessionDirectory, { recursive: true })
    const id = randomUUID()
    const ref = config.session ?? { id, path: join(config.sessionDirectory, id + '.jsonl') }
    if (config.session) {
      const header = JSON.parse((await readFile(ref.path, 'utf8')).split('\n')[0])
      if (header.id !== ref.id) throw new Error('Invalid Fake session')
    } else {
      const file = await open(ref.path, 'wx', 0o600)
      try {
        await file.writeFile(JSON.stringify({ id: ref.id }) + '\n')
        await file.sync()
      } finally {
        await file.close()
      }
    }
    const route = config.route ?? defaultRoute
    await this.validateRoute(route)
    const abort = new AbortController()
    const worker = config.role === 'worker'
    let active: Promise<Awaited<ReturnType<ExecutionSession['run']>>> | undefined
    const append = async (value: unknown) => {
      const file = await open(ref.path, 'a')
      try {
        await file.writeFile(JSON.stringify(value) + '\n')
        await file.sync()
      } finally {
        await file.close()
      }
    }
    const execute = async (name: string, input: Record<string, unknown>) => {
      const tool = config.tools.find((item) => item.name === name)
      if (!tool) throw new Error('Fake tool unavailable')
      return tool.execute(randomUUID(), input, abort.signal)
    }
    return {
      ref, route,
      async run(prompt) {
        if (active) throw new Error('Fake session is active')
        active = (async () => {
          try {
            const transcript = await readFile(ref.path, 'utf8')
            await append({ prompt })
            config.onEvent({ type: 'model.request_started' })
            await delay(worker ? 900 : transcript.includes('slow') || prompt.includes('slow') ? 3000 : 80, undefined, { signal: abort.signal })
            if (worker) {
              await execute('read_text_file', { path: 'demo.txt' })
            } else {
              const previous = await execute('read_text_file', { path: 'demo.txt' })
              if (previous && typeof previous === 'object' && 'ok' in previous && !previous.ok) {
                await execute('create_text_file', { path: 'demo.txt', content: 'verified by zlo agent\n' })
              }
              if ((transcript + prompt).includes('delegate')) {
                await execute('delegate_task', { goal: 'Read demo.txt and report the verification marker' })
              }
            }
            abort.signal.throwIfAborted()
            const text = worker ? 'Read the demo marker.' : 'Demo run completed.'
            await append({ text })
            config.onEvent({ type: 'message.delta', delta: text })
            return { status: 'completed', text } as const
          } catch {
            return { status: abort.signal.aborted ? 'interrupted' : 'runtime_error' } as const
          }
        })()
        try {
          return await active
        } finally {
          active = undefined
        }
      },
      async steer(text) { await append({ instruction: text }) },
      async requestStop() { abort.abort(); await active },
      async checkpoint() { await active },
      async dispose() { await active },
    }
  }
}
