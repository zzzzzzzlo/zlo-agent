import type { AgentAdapter, AgentEvent, RunKey, SendRequest, ToolUpdate } from './AgentAdapter'

interface Job {
  key: RunKey
  controller: AbortController
  tool?: ToolUpdate
}

const failurePrompt = '演示错误状态'

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return }
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })
}

export class MockAgentAdapter implements AgentAdapter {
  private jobs = new Map<string, Job>()
  private listeners = new Set<(event: AgentEvent) => void>()

  subscribe(listener: (event: AgentEvent) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(event: AgentEvent) {
    for (const listener of this.listeners) listener(event)
  }

  async send({ sessionId, runId, messages }: SendRequest) {
    if (this.jobs.has(runId)) throw new Error('运行 ID 已存在')
    const key = { sessionId, runId }
    const job: Job = { key, controller: new AbortController() }
    this.jobs.set(runId, job)
    void this.run(job, messages.at(-1)?.text ?? '')
  }

  private async run(job: Job, prompt: string) {
    const { key, controller } = job
    const signal = controller.signal
    await pause(360, signal)
    if (signal.aborted) return

    const isError = prompt.includes(failurePrompt)
    job.tool = {
      id: 'preview', name: '准备演示内容', status: 'running',
      detail: '正在读取本地演示模板…',
    }
    this.emit({ ...key, type: 'tool.updated', tool: job.tool })
    await pause(850, signal)
    if (signal.aborted) return

    job.tool = {
      ...job.tool, status: isError ? 'error' : 'completed',
      detail: isError ? '模拟模板读取失败。' : '已加载一份内置演示模板。',
    }
    this.emit({ ...key, type: 'tool.updated', tool: job.tool })
    if (isError) {
      this.jobs.delete(key.runId)
      this.emit({ ...key, type: 'run.ended', status: 'error', error: '模拟错误：演示工具返回失败。可以发送另一条消息继续体验。' })
      return
    }

    const excerpt = Array.from(prompt.replace(/\s+/g, ' ')).slice(0, 48).join('')
    const reply = prompt.includes('工具') ?
      '这是一次工具执行演示。刚才的卡片从「运行中」变为「已完成」，点开可以查看模拟结果。\n\n打开右上角的活动面板，可以在同一处查看这次运行和工具状态。' :
      `收到「${excerpt}」。这段回复由本地模板逐步输出，用于预览一次完整的对话。\n\n如果把它当作一项任务，可以先写清预期结果，再列出最先需要的信息，最后决定下一步。\n\n发送期间可以随时按停止按钮，已显示的内容会留在会话里。`
    for (const delta of reply.match(/.{1,4}|\n/gu) ?? []) {
      if (signal.aborted) return
      this.emit({ ...key, type: 'message.delta', delta })
      await pause(46, signal)
    }
    if (signal.aborted) return
    this.jobs.delete(key.runId)
    this.emit({ ...key, type: 'run.ended', status: 'completed' })
  }

  async cancel(key: RunKey) {
    const job = this.jobs.get(key.runId)
    if (!job || job.key.sessionId !== key.sessionId) return
    this.jobs.delete(key.runId)
    job.controller.abort()
    if (job.tool?.status === 'running') {
      this.emit({ ...key, type: 'tool.updated', tool: { ...job.tool, status: 'cancelled', detail: '已停止模拟执行。' } })
    }
    this.emit({ ...key, type: 'run.ended', status: 'cancelled' })
  }

  async steer(_key: RunKey, _text: string) {
    throw new Error('演示模式暂未接入运行中指令')
  }
}
