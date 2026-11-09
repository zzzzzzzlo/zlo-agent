import { InMemoryCredentialStore, getCurrentTools } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { PiExecution } from './pi.ts'

const loginPage = '<!doctype html>\n<html lang="zh-CN"><title>登录</title>\n<form><label>用户名<input name="username"></label><label>密码<input type="password" name="password"></label><button>登录</button></form>\n</html>\n'

/** Explicit development fixture. Every request runs through the installed Pi SDK and its Faux provider. */
export class FauxExecution extends PiExecution {
  constructor() {
    super(async () => {
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
      })
      const provider = fauxProvider({ models: [{ id: 'desktop-test' }], tokensPerSecond: 180, tokenSize: { min: 3, max: 3 } })
      const respond: FauxResponseFactory = (context) => {
        provider.appendResponses([respond])
        const tool = (name: string, args: Record<string, string>) =>
          fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' })
        const previous = context.messages.findLast((message) => message.role === 'user')
        const tail = context.messages.findLast((message) => message.role === 'user' || message.role === 'toolResult')
        if (tail?.role === 'toolResult') {
          const content = tail.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
          if (!content.includes('"ok":true')) return fauxAssistantMessage('文件工具未完成请求，请检查工作区和验收路径。')
          return fauxAssistantMessage(tail.toolName === 'edit_text_file' ? '已在登录页中添加验证码输入框。' : '已创建简单登录页面，包含用户名和密码输入框。')
        }
        const text = previous?.role === 'user'
          ? (typeof previous.content === 'string' ? previous.content
            : previous.content.filter((part) => part.type === 'text').map((part) => part.text).join(''))
          : ''
        const available = getCurrentTools(context.messages).map(({ name }) => name)
        if (text.startsWith('Additional user instruction (')) return fauxAssistantMessage('已应用追加指令：' + text.split('): ').slice(1).join('): '))
        if (text.startsWith('Resume the task')) return fauxAssistantMessage('已从保存的会话继续。')
        if (text.includes('[slow]') || text.includes('[steer]')) {
          return fauxAssistantMessage('正在生成可中断的分段内容。'.repeat(140))
        }
        if (/(验证码|captcha)/iu.test(text) && available.includes('edit_text_file')) {
          return tool('edit_text_file', {
            path: 'login.html', oldText: '</form>',
            newText: '<label>验证码<input name="captcha" autocomplete="off"></label></form>',
          })
        }
        if (/(登录|login)/iu.test(text) && available.includes('create_text_file')) {
          return tool('create_text_file', { path: 'login.html', content: loginPage })
        }
        return fauxAssistantMessage('已收到：' + text.slice(0, 240))
      }
      provider.setResponses([respond])
      runtime.registerNativeProvider(provider.provider)
      return runtime
    })
  }
}
