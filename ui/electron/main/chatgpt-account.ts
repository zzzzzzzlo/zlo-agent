import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { shell } from 'electron'
import type { ChatGptSession, ChatGptStatus } from '../../../shared/contracts/chatgpt.ts'
import type { ManagedModel } from '../../../shared/contracts/management.ts'
import {
  ChatGptOAuthError, listChatGptModels, refreshChatGptTokens, revokeChatGptTokens, signInWithChatGpt,
  validClientId, validModelId, validToken,
} from './chatgpt-oauth.ts'
import type { ChatGptIdentity, ChatGptTokens } from './chatgpt-oauth.ts'
import { readEncryptedJson, storageAvailable, writeEncryptedJson } from './encrypted-storage.ts'

interface Profile extends ChatGptIdentity {
  id: string
  tokens?: ChatGptTokens
  models: string[]
}

interface Vault {
  version: 1
  hostId: string
  active?: string
  profiles: Profile[]
}

interface ChatGptAccountOptions {
  applySession(session: ChatGptSession | null, quiesce: boolean): Promise<ManagedModel[] | void>
}

const refreshMarginMs = 3 * 60_000

function profileOf(vault: Vault): Profile | undefined { return vault.profiles.find(({ id }) => id === vault.active) }

function sessionOf(profile?: Profile): ChatGptSession | null {
  if (!profile?.tokens || profile.tokens.expiresAt <= Date.now()) return null
  return { profileId: profile.id, accessToken: profile.tokens.accessToken, expiresAt: profile.tokens.expiresAt, models: profile.models }
}

function localFailure(): ChatGptOAuthError { return new ChatGptOAuthError('无法更新 ChatGPT 的安全凭证。') }

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/u.test(value)
}

export class ChatGptAccount {
  readonly #path: string
  readonly #options: ChatGptAccountOptions
  #queue = Promise.resolve()
  #signInAttempt?: AbortController
  #refreshTimer?: NodeJS.Timeout
  #models?: { profile: string; values: ManagedModel[] }
  #closed = false

  constructor(userData: string, options: ChatGptAccountOptions) {
    this.#path = join(userData, 'chatgpt-credentials.bin')
    this.#options = options
  }

  async loadSession(): Promise<ChatGptSession | null> {
    const profile = profileOf(await this.#read())
    this.#schedule(profile)
    return sessionOf(profile)
  }

  async status(): Promise<ChatGptStatus> { return this.#statusOf(await this.#read()) }

  #statusOf(vault: Vault): ChatGptStatus {
    const profile = profileOf(vault)
    const session = sessionOf(profile)
    return {
      available: true, state: session ? 'connected' : profile ? 'reauthorization_required' : 'signed_out',
      profiles: vault.profiles.map(({ id, email }, index) => ({ id, label: email ? `${email} · ${index + 1}` : `ChatGPT ${index + 1}` })),
      activeProfileId: profile?.id,
      models: session ? this.#models?.profile === session.profileId ? this.#models.values :
        session.models.map(model => ({ route: { provider: `chatgpt-${session.profileId}`, model }, name: model })) : [],
    }
  }

  async signIn(profileId?: string): Promise<ChatGptStatus> {
    if (this.#signInAttempt) throw new ChatGptOAuthError('已有 ChatGPT 登录请求正在进行。')
    if (!storageAvailable()) throw localFailure()
    const controller = new AbortController()
    this.#signInAttempt = controller
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)])
    try {
      const { hostId, previous } = await this.#serialize(async () => {
        const vault = await this.#read()
        const previous = profileId && vault.profiles.find(({ id }) => id === profileId)
        if (profileId && !previous) throw new ChatGptOAuthError('找不到这个 ChatGPT 账号。')
        if (!previous && vault.profiles.length >= 10) throw new ChatGptOAuthError('已达到本地 ChatGPT 账号数量上限。')
        await this.#write(vault)
        return { hostId: vault.hostId, previous: previous || undefined }
      })
      const verified = await signInWithChatGpt({ hostId, previous, signal, openBrowser: url => shell.openExternal(url) })
      const models = await listChatGptModels(verified.tokens, signal)
      return await this.#serialize(async () => {
        signal.throwIfAborted()
        const vault = await this.#read()
        const next: Profile = { ...verified, models, id: previous?.id ?? randomUUID() }
        const existing = vault.profiles.find(({ clientId }) => clientId === next.clientId)
        if (existing && existing.subject !== next.subject) throw new ChatGptOAuthError('ChatGPT 账号与已保存的授权不匹配。')
        if (existing) next.id = existing.id
        const profiles = vault.profiles.map(profile => profile.id === next.id ? next : profile)
        if (!profiles.some(({ id }) => id === next.id)) profiles.push(next)
        const updated = { ...vault, active: next.id, profiles }
        await this.#write(updated)
        try {
          const available = await this.#options.applySession(sessionOf(next), true)
          this.#models = { profile: next.id, values: available ?? [] }
          if (available) {
            next.models = available.map(({ route }) => route.model)
            await this.#write(updated)
          }
        } catch {
          await this.#write(vault)
          await this.#options.applySession(sessionOf(profileOf(vault)), true).catch(() => {})
          throw new ChatGptOAuthError('Agent Host 未能启用 ChatGPT 授权，请重试。')
        }
        this.#schedule(next)
        return this.#statusOf(updated)
      })
    } catch (error) {
      if (error instanceof ChatGptOAuthError) throw error
      if (signal.aborted) throw new ChatGptOAuthError('ChatGPT 登录已取消或超时。')
      throw new ChatGptOAuthError('无法完成 ChatGPT 登录。请检查账号或网络后重试。')
    } finally { this.#signInAttempt = undefined }
  }

  cancelSignIn(): void { this.#signInAttempt?.abort() }

  signOut(): Promise<ChatGptStatus> {
    this.cancelSignIn()
    return this.#serialize(async () => {
      const vault = await this.#read()
      const profile = profileOf(vault)
      if (!profile) return this.#statusOf(vault)
      const profiles = vault.profiles.map(entry => entry.id === profile.id ? { ...entry, tokens: undefined, models: [] } : entry)
      const updated = { ...vault, active: undefined, profiles }
      // Persist the signed-out state first so a replacement Host cannot pick up
      // the prior session if the live Host fails while quiescing.
      await this.#write(updated)
      this.#schedule(undefined)
      this.#models = undefined
      const stopped = this.#options.applySession(null, true).then(() => true, () => false)
      const remoteRevocationConfirmed = profile.tokens
        ? await revokeChatGptTokens({ ...profile, tokens: profile.tokens }) : undefined
      if (!await stopped && !remoteRevocationConfirmed) {
        throw new ChatGptOAuthError('已清除本地 ChatGPT 凭证。Agent Host 或远程撤销未能确认，请重启应用。')
      }
      return { ...this.#statusOf(updated), remoteRevocationConfirmed }
    })
  }

  close(): void {
    this.#closed = true
    this.cancelSignIn()
    clearTimeout(this.#refreshTimer)
  }

  #serialize<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.#queue.then(action)
    this.#queue = operation.then(() => {}, () => {})
    return operation
  }

  #schedule(profile?: Profile, retryMs?: number): void {
    clearTimeout(this.#refreshTimer)
    if (this.#closed || !profile?.tokens) return
    const delay = retryMs ?? Math.max(0, profile.tokens.earliestRefreshAt - Date.now(), profile.tokens.expiresAt - Date.now() - refreshMarginMs)
    this.#refreshTimer = setTimeout(() => {
      void this.#serialize(() => this.#refresh(profile.id)).catch(() => this.#schedule(profile, 30_000))
    }, delay)
    this.#refreshTimer.unref()
  }

  async #refresh(id: string): Promise<void> {
    if (this.#closed) return
    const vault = await this.#read()
    const profile = profileOf(vault)
    if (!profile?.tokens || profile.id !== id) return
    const signal = AbortSignal.timeout(28_000)
    let next: Profile
    try {
      const tokens = await refreshChatGptTokens({ ...profile, tokens: profile.tokens }, signal)
      next = { ...profile, tokens }
    } catch (error) {
      if (!(error instanceof ChatGptOAuthError) || !error.reauthorize) throw error
      // Invalid grants stop immediately and keep the account/client mapping for reauthorization.
      next = { ...profile, tokens: undefined, models: [] }
    }
    const updated = { ...vault, profiles: vault.profiles.map(entry => entry.id === id ? next : entry) }
    // Commit rotating refresh credentials before updating the runtime or making another request.
    await this.#write(updated)
    const session = sessionOf(next)
    try {
      const available = await this.#options.applySession(session, !session)
      this.#models = { profile: id, values: available ?? [] }
      this.#schedule(next)
    } catch {
      this.#retryApply(id)
    }
  }

  #retryApply(id: string): void {
    clearTimeout(this.#refreshTimer)
    if (this.#closed) return
    this.#refreshTimer = setTimeout(() => {
      void this.#serialize(async () => {
        const profile = profileOf(await this.#read())
        if (profile?.id !== id) return
        const session = sessionOf(profile)
        const available = await this.#options.applySession(session, !session)
        this.#models = { profile: id, values: available ?? [] }
        this.#schedule(profile)
      }).catch(() => this.#retryApply(id))
    }, 10_000)
    this.#refreshTimer.unref()
  }

  async #read(): Promise<Vault> {
    try {
      const raw = await readEncryptedJson(this.#path) as Vault | undefined
      if (raw === undefined) return { version: 1, hostId: randomUUID(), profiles: [] }
      if (raw?.version !== 1 || !validUuid(raw.hostId) || !Array.isArray(raw.profiles) || raw.profiles.length > 10 ||
        (raw.active !== undefined && !raw.profiles.some(({ id }) => id === raw.active))) throw localFailure()
      for (const profile of raw.profiles) {
        if (!validUuid(profile.id) || !validClientId(profile.clientId) || typeof profile.subject !== 'string' ||
          (profile.email !== undefined && (typeof profile.email !== 'string' || profile.email.length > 254)) ||
          !Array.isArray(profile.models) || profile.models.length > 1024 || !profile.models.every(validModelId)) throw localFailure()
        const tokens = profile.tokens
        if (tokens && (!validToken(tokens.accessToken) || tokens.accessToken.startsWith('sk-') || !validToken(tokens.refreshToken) ||
          !validToken(tokens.idToken) || !Number.isFinite(tokens.expiresAt) || !Number.isFinite(tokens.earliestRefreshAt))) throw localFailure()
      }
      return raw
    } catch { throw localFailure() }
  }

  async #write(vault: Vault): Promise<void> {
    try { await writeEncryptedJson(this.#path, vault) } catch { throw localFailure() }
  }
}
