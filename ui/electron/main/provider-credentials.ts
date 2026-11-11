import { join } from 'node:path'
import { clipboard, dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import type { ProviderId } from '../../../shared/contracts/management.ts'
import { readEncryptedJson, storageAvailable, writeEncryptedJson } from './encrypted-storage.ts'

const providers: Readonly<Record<ProviderId, string>> = {
  deepseek: 'DeepSeek', openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google Gemini',
}

type CredentialValues = Partial<Record<ProviderId, string | null>>

function validKey(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{8,2048}$/u.test(value)
}

export class ProviderCredentialError extends Error {}

export class SecureProviderCredentials {
  readonly #path: string
  #updates = Promise.resolve()

  constructor(userData: string) { this.#path = join(userData, 'provider-credentials.bin') }

  async load(): Promise<CredentialValues> {
    try { return await this.#read() } catch {
      throw new ProviderCredentialError('无法读取此系统账户的模型凭证。')
    }
  }

  set(provider: ProviderId, key: string | null | undefined): Promise<void> {
    if (!Object.hasOwn(providers, provider) || (key != null && !validKey(key))) {
      return Promise.reject(new ProviderCredentialError('模型凭证格式无效。'))
    }
    const update = this.#updates.then(async () => {
      if (!storageAvailable()) throw new ProviderCredentialError('系统安全凭证存储不可用。')
      const values = await this.load()
      if (key === undefined) delete values[provider]
      else values[provider] = key
      await writeEncryptedJson(this.#path, { version: 1, values })
    }).catch((error) => {
      if (error instanceof ProviderCredentialError) throw error
      throw new ProviderCredentialError('无法更新系统安全凭证。')
    })
    this.#updates = update.catch(() => {})
    return update
  }

  async #read(): Promise<CredentialValues> {
    const document = await readEncryptedJson(this.#path) as { version?: number; values?: Record<string, unknown> } | undefined
    if (document === undefined) return {}
    if (document?.version !== 1 || !document.values || typeof document.values !== 'object' || Array.isArray(document.values)) {
      throw new Error('Invalid credential store')
    }
    const values: CredentialValues = {}
    for (const provider of Object.keys(providers) as ProviderId[]) {
      const value = document.values[provider]
      if (value !== undefined && value !== null && !validKey(value)) throw new Error('Invalid credential store')
      if (value !== undefined) values[provider] = value
    }
    return values
  }
}

export async function captureProviderKey(window: BrowserWindow, provider: ProviderId): Promise<string | null> {
  if (!Object.hasOwn(providers, provider)) throw new ProviderCredentialError('模型供应商无效。')
  if (!storageAvailable()) throw new ProviderCredentialError('系统安全凭证存储不可用。')
  const { response } = await dialog.showMessageBox(window, {
    type: 'question', title: '添加模型凭证', message: `从剪贴板添加 ${providers[provider]} API Key？`,
    detail: '请先在供应商控制台复制 API Key。确认后，应用主进程会读取剪贴板中的文本并加密保存。',
    buttons: ['取消', '读取剪贴板'], defaultId: 0, cancelId: 0, noLink: true,
  })
  if (response !== 1 || window.isDestroyed()) return null
  const key = clipboard.readText().trim()
  if (!validKey(key)) throw new ProviderCredentialError('剪贴板中没有有效格式的 API Key。')
  return key
}
