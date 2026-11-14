import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { dialog, ipcMain, shell } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { ManagedModel } from '../../../shared/contracts/management.ts'
import { customProviderLimit, parseCustomCredential, parseCustomProvider, parseGrokCredential, validCustomId } from '../../../shared/contracts/provider-setup.ts'
import type { CustomProviderCredential, CustomProviderSummary, CustomProviderTest, GrokCredential, GrokLoginProgress, GrokStatus } from '../../../shared/contracts/provider-setup.ts'
import { providerSetupChannels } from '../agent-channels.ts'
import { noInput, object } from './agent-input.ts'
import { readEncryptedJson, storageAvailable, writeEncryptedJson } from './encrypted-storage.ts'
import { HostTransportError } from './host-process.ts'
import type { HostProcessManager } from './host-process.ts'
import { captureKey, ProviderCredentialError } from './provider-credentials.ts'

const requestVersion = { schemaVersion: 1 } as const
const setupError = (message: string) => new HostTransportError('CONFLICT', message)

export class ProviderSetup {
  readonly #customPath: string
  readonly #grokPath: string
  #writes: Promise<unknown> = Promise.resolve()
  #login?: AbortController
  #code?: string
  #timer?: ReturnType<typeof setTimeout>
  #grokModels: ManagedModel[] = []
  #closed = false

  constructor(userData: string, private readonly getHost: () => HostProcessManager) {
    this.#customPath = join(userData, 'custom-providers.bin')
    this.#grokPath = join(userData, 'grok-credentials.bin')
  }

  async loadCustom(): Promise<CustomProviderCredential[]> {
    const data = await readEncryptedJson(this.#customPath)
    if (data === undefined) return []
    if (!Array.isArray(data) || data.length > customProviderLimit) throw setupError('无法读取自定义提供商配置。')
    return data.map(value => {
      const config = parseCustomCredential(value)
      if (!config) throw setupError('自定义提供商配置已损坏。')
      return config
    })
  }

  async loadGrok(): Promise<GrokCredential | undefined> {
    const value = await readEncryptedJson(this.#grokPath)
    if (value == null) return undefined
    const credential = parseGrokCredential(value)
    if (!credential) throw setupError('无法读取 Grok 授权。')
    this.#schedule(credential)
    return credential
  }

  #serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#writes.then(action, action)
    this.#writes = result.catch(() => {})
    return result
  }

  async listCustom(): Promise<CustomProviderSummary[]> { return summaries(await this.loadCustom()) }

  #applyCustom(id: string, config: CustomProviderCredential | null) {
    return this.getHost().request({ ...requestVersion, type: 'applyCustomProvider', id, config })
  }

  updateCustom(id: string, change: (previous?: CustomProviderCredential) => Promise<CustomProviderCredential | null | undefined>) {
    return this.#serialize(async () => {
      const previous = await this.loadCustom()
      const current = previous.find(config => config.id === id)
      const next = await change(current)
      if (next === undefined) return summaries(previous)
      const updated = next && current ? previous.map(config => config === current ? next : config)
        : next ? [...previous, next] : previous.filter(config => config !== current)
      if (updated.length > customProviderLimit) throw setupError('已达到自定义提供商数量上限。')
      await writeEncryptedJson(this.#customPath, updated)
      try { await this.#applyCustom(id, next) }
      catch (error) {
        await writeEncryptedJson(this.#customPath, previous)
        throw error
      }
      return summaries(updated)
    })
  }

  testCustom(id: string) { return this.getHost().request<CustomProviderTest>({ ...requestVersion, type: 'testCustomProvider', id }) }

  async grokStatus(): Promise<GrokStatus> {
    if (this.#login) return { state: 'signing_in', code: this.#code, models: this.#grokModels }
    const credential = parseGrokCredential(await readEncryptedJson(this.#grokPath))
    if (!credential) return { state: 'signed_out', models: [] }
    if (credential.expires <= Date.now()) return { state: 'reauthorization_required', models: [] }
    if (!this.#grokModels.length) {
      this.#grokModels = (await this.getHost().request<{ providers: { id: string; models: ManagedModel[] }[] }>({
        ...requestVersion, type: 'managementSnapshot',
      })).providers.find(provider => provider.id === 'xai')?.models ?? []
    }
    return { state: this.#grokModels.length ? 'connected' : 'reauthorization_required', models: this.#grokModels }
  }

  async grokSignIn(): Promise<GrokStatus> {
    if (this.#login) throw setupError('Grok 授权正在进行。')
    if (!storageAvailable()) throw setupError('系统加密存储不可用。')
    const controller = new AbortController()
    this.#login = controller
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)])
    const host = this.getHost()
    let opened = false
    try {
      await host.request({ ...requestVersion, type: 'startGrokLogin' })
      for (;;) {
        signal.throwIfAborted()
        const progress = await host.request<GrokLoginProgress>({ ...requestVersion, type: 'pollGrokLogin' })
        if (progress.state === 'failed') throw setupError('Grok 授权失败或已过期，请重试。')
        if (progress.state === 'complete') {
          const credential = parseGrokCredential(progress.credential)
          if (!credential) throw setupError('Grok 返回了无效授权。')
          await this.#serialize(async () => {
            signal.throwIfAborted()
            await this.#saveGrok(credential, true)
          })
          break
        }
        if (!opened && progress.verification) {
          const { url, code } = progress.verification
          await shell.openExternal(grokVerificationUrl(url))
          this.#code = /^[A-Z0-9-]{4,24}$/iu.test(code) ? code : undefined
          opened = true
        }
        await pause(850, undefined, { signal })
      }
    } catch (error) {
      if (signal.aborted) throw setupError('Grok 登录已取消或超时。')
      throw error
    } finally {
      await host.request({ ...requestVersion, type: 'cancelGrokLogin' }).catch(() => {})
      this.#login = undefined
      this.#code = undefined
    }
    return this.grokStatus()
  }

  cancelGrok() { this.#login?.abort() }

  signOutGrok() {
    this.cancelGrok()
    return this.#serialize(async (): Promise<GrokStatus> => {
      clearTimeout(this.#timer)
      await writeEncryptedJson(this.#grokPath, null)
      this.#grokModels = []
      const host = this.getHost()
      try { await host.request({ ...requestVersion, type: 'applyGrokSession', session: null, quiesce: true }) }
      catch { if ((await host.restart()).state !== 'ready') throw setupError('本地授权已清除，Agent Host 重启失败。') }
      return { state: 'signed_out', models: [] }
    })
  }

  async #saveGrok(credential: GrokCredential, quiesce: boolean) {
    const previous = await readEncryptedJson(this.#grokPath)
    await writeEncryptedJson(this.#grokPath, credential)
    try {
      this.#grokModels = await this.getHost().request({ ...requestVersion, type: 'applyGrokSession', session: credential, quiesce })
    } catch (error) {
      if (quiesce) await writeEncryptedJson(this.#grokPath, previous ?? null)
      else if ((await this.getHost().restart()).state === 'ready') return
      throw error
    } finally {
      if (!quiesce) this.#schedule(credential)
    }
    if (quiesce) this.#schedule(credential)
  }

  #schedule(credential: GrokCredential, retryMs?: number) {
    clearTimeout(this.#timer)
    if (this.#closed) return
    this.#timer = setTimeout(() => {
      void this.#serialize(async () => {
        const current = parseGrokCredential(await readEncryptedJson(this.#grokPath))
        if (this.#closed || current?.refresh !== credential.refresh || current.expires !== credential.expires) return
        const updated = await this.getHost().request<GrokCredential>({ ...requestVersion, type: 'refreshGrokLogin', credential: current })
        await this.#saveGrok(updated, false)
      }).catch(() => { if (!this.#closed && credential.expires > Date.now()) this.#schedule(credential, 30_000) })
    }, retryMs ?? Math.min(2_147_483_647, Math.max(5_000, credential.expires - Date.now() - 60_000)))
    this.#timer.unref()
  }

  close() {
    this.#closed = true
    this.cancelGrok()
    clearTimeout(this.#timer)
  }
}

function summaries(values: CustomProviderCredential[]): CustomProviderSummary[] {
  return values.map(({ key, ...config }) => ({ ...config, hasKey: !!key }))
}

export function grokVerificationUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
    !['auth.x.ai', 'accounts.x.ai', 'grok.com', 'x.ai'].includes(url.hostname)) {
    throw setupError('Grok 返回了无法验证的授权地址。')
  }
  return url.href
}

export function registerProviderSetupIpc(setup: ProviderSetup | undefined, windowFor: (event: IpcMainInvokeEvent) => BrowserWindow) {
  function register(method: keyof typeof providerSetupChannels, run: (setup: ProviderSetup, window: BrowserWindow, input: unknown) => unknown) {
    ipcMain.handle(providerSetupChannels[method], async (event, ...args: unknown[]) => {
      const window = windowFor(event)
      try {
        if (args.length > 1) throw new HostTransportError('INVALID_INPUT', '提供商参数无效。')
        if (!setup) {
          noInput(args[0])
          if (method === 'grokStatus') return { state: 'unavailable', models: [] }
          if (method === 'listCustom') return []
          throw setupError('此操作需要 Pi 模式。')
        }
        return await run(setup, window, args[0])
      } catch (error) {
        if (error instanceof HostTransportError) throw new Error('[' + error.code + '] ' + error.message)
        if (error instanceof ProviderCredentialError) throw new Error('[INVALID_INPUT] ' + error.message)
        throw new Error('[INTERNAL] 无法完成提供商操作。')
      }
    })
  }
  const idFrom = (input: unknown) => {
    const { id } = object(input, ['id'])
    if (!validCustomId(id)) throw new HostTransportError('INVALID_INPUT', '提供商 ID 无效。')
    return id
  }
  register('listCustom', (setup, _window, input) => { noInput(input); return setup.listCustom() })
  register('saveCustom', (setup, _window, input) => {
    const { create } = object(input, ['id', 'name', 'baseUrl', 'models', 'create'])
    const config = parseCustomProvider(input)
    if (!config || typeof create !== 'boolean') throw new HostTransportError('INVALID_INPUT', '请检查名称、ID、接口地址与模型 ID。接口使用 HTTPS，或本地回环地址的 HTTP。')
    return setup.updateCustom(config.id, async previous => {
      if (create && previous) throw setupError('此提供商 ID 已存在，请使用其他 ID。')
      if (!create && !previous) throw setupError('此提供商已被移除。')
      if (previous?.key && previous.baseUrl !== config.baseUrl) throw setupError('更换接口地址前请先移除已保存的 API Key。')
      return { ...config, key: previous?.key ?? null }
    })
  })
  register('setCustomKey', (setup, window, input) => setup.updateCustom(idFrom(input), async previous => {
    if (!previous) throw setupError('请先保存提供商。')
    const key = await captureKey(window, previous.name + ' · ' + new URL(previous.baseUrl).host)
    return key ? { ...previous, key } : undefined
  }))
  register('removeCustomKey', (setup, _window, input) => setup.updateCustom(idFrom(input), async previous =>
    previous?.key ? { ...previous, key: null } : undefined))
  register('deleteCustom', (setup, window, input) => setup.updateCustom(idFrom(input), async previous => {
    if (!previous) return
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning', message: '移除此提供商和本机保存的 API Key？', detail: previous.name,
      buttons: ['取消', '移除'], cancelId: 0, defaultId: 0, noLink: true,
    })
    return response === 1 && !window.isDestroyed() ? null : undefined
  }))
  register('testCustom', (setup, _window, input) => setup.testCustom(idFrom(input)))
  register('grokStatus', (setup, _window, input) => { noInput(input); return setup.grokStatus() })
  register('grokSignIn', async (setup, window, input) => {
    noInput(input)
    const { response } = await dialog.showMessageBox(window, {
      type: 'question', message: '在系统浏览器授权 Grok？',
      detail: 'xAI 将验证你的账号及订阅权益。',
      buttons: ['取消', '继续'], cancelId: 0, defaultId: 0, noLink: true,
    })
    if (response !== 1 || window.isDestroyed()) return setup.grokStatus()
    const contents = window.webContents
    const cancel = () => setup.cancelGrok()
    contents.once('destroyed', cancel)
    try { return await setup.grokSignIn() } finally { contents.off('destroyed', cancel) }
  })
  register('grokCancel', (setup, _window, input) => {
    noInput(input)
    setup.cancelGrok()
    return setup.grokStatus()
  })
  register('grokSignOut', async (setup, window, input) => {
    noInput(input)
    const result = await dialog.showMessageBox(window, {
      type: 'warning', message: '退出本机 Grok 账号并停止相关任务？',
      buttons: ['取消', '退出'], cancelId: 0, defaultId: 0, noLink: true,
    })
    return result.response === 1 && !window.isDestroyed() ? setup.signOutGrok() : setup.grokStatus()
  })
}
