import { dialog, ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { chatGptChannels } from '../agent-channels.ts'
import { entityId, noInput, object } from './agent-input.ts'
import type { ChatGptAccount } from './chatgpt-account.ts'
import { ChatGptOAuthError } from './chatgpt-oauth.ts'
import { HostTransportError } from './host-process.ts'

export function registerChatGptIpc(account: ChatGptAccount | undefined, windowFor: (event: IpcMainInvokeEvent) => BrowserWindow) {
  function register(method: keyof typeof chatGptChannels, run: (account: ChatGptAccount, window: BrowserWindow, args: unknown[]) => unknown) {
    ipcMain.handle(chatGptChannels[method], async (event, ...args: unknown[]) => {
      const window = windowFor(event)
      try {
        if (!account) throw new HostTransportError('MODEL_UNAVAILABLE', 'ChatGPT 账号授权需要 Pi 模式。')
        if (args.length > 1) throw new HostTransportError('INVALID_INPUT', '账号管理参数无效。')
        return await run(account, window, args)
      } catch (error) {
        if (error instanceof HostTransportError) throw new Error('[' + error.code + '] ' + error.message)
        if (error instanceof ChatGptOAuthError) throw new Error('[MODEL_UNAVAILABLE] ' + error.message)
        throw new Error('[INTERNAL] 无法完成 ChatGPT 账号操作。')
      }
    })
  }
  register('status', (account, _window, args) => { noInput(args[0]); return account.status() })
  register('cancelSignIn', (account, _window, args) => { noInput(args[0]); account.cancelSignIn() })
  register('signIn', async (account, window, [value]) => {
    const { profileId } = object(value, ['profileId'])
    const id = profileId === undefined ? undefined : entityId(profileId)
    const { response } = await dialog.showMessageBox(window, {
      type: 'question', title: '授权 ChatGPT 账号', message: '在系统浏览器继续授权？',
      detail: '浏览器将打开 OpenAI 官方授权页面。你可以在该页面查看并选择授权范围。',
      buttons: ['取消', '继续'], defaultId: 0, cancelId: 0, noLink: true,
    })
    if (response !== 1 || window.isDestroyed()) throw new HostTransportError('CONFLICT', '操作已取消。')
    const contents = window.webContents
    const cancel = () => account.cancelSignIn()
    contents.once('destroyed', cancel)
    try { return await account.signIn(id) } finally { contents.off('destroyed', cancel) }
  })
  register('signOut', async (account, window, args) => {
    noInput(args[0])
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning', title: '退出 ChatGPT 账号', message: '停止相关任务并移除此设备上的账号授权？',
      buttons: ['取消', '退出'], defaultId: 0, cancelId: 0, noLink: true,
    })
    if (response !== 1 || window.isDestroyed()) throw new HostTransportError('CONFLICT', '操作已取消。')
    return account.signOut()
  })
}
