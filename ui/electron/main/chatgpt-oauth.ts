import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import type { JsonWebKey } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

const issuer = 'https://auth.openai.com'
const authorizeUrl = `${issuer}/api/accounts/authorize`
const tokenUrl = `${issuer}/api/accounts/oauth/token`
const revokeUrl = `${issuer}/api/accounts/oauth/revoke`
const jwksUrl = `${issuer}/.well-known/jwks.json`
const resource = 'https://api.openai.com/v1'
const callbackPath = '/auth/callback'
const requiredScope = 'chatgpt.tokens.use.direct'

export interface ChatGptIdentity {
  clientId: string
  subject: string
  email?: string
}

export interface ChatGptTokens {
  accessToken: string
  refreshToken: string
  idToken: string
  expiresAt: number
  earliestRefreshAt: number
}

export class ChatGptOAuthError extends Error {
  readonly reauthorize: boolean

  constructor(message: string, reauthorize = false) {
    super(message)
    this.reauthorize = reauthorize
  }
}

export function validModelId(value: unknown): value is string {
  return typeof value === 'string' && /^[\w.:/-]{1,200}$/u.test(value)
}

export function validToken(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{16,16384}$/u.test(value)
}

export function validClientId(value: unknown): value is string {
  return typeof value === 'string' && /^oaiapp_[A-Za-z0-9_-]{4,200}$/u.test(value)
}

function oauthFailure(): ChatGptOAuthError {
  return new ChatGptOAuthError('无法完成 ChatGPT 授权。请检查账号或网络后重试。')
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw oauthFailure()
  return value as Record<string, unknown>
}

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw oauthFailure()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 512 * 1024) {
        await reader.cancel()
        throw oauthFailure()
      }
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { reader.releaseLock() }
}

async function exchange(fields: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(tokenUrl, {
      method: 'POST', body: new URLSearchParams({ ...fields, resource }), redirect: 'error',
      headers: { accept: 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
    })
    const result = object(await readJson(response))
    if (!response.ok) {
      if (result.error === 'invalid_grant' || result.error === 'invalid_client') {
        throw new ChatGptOAuthError('ChatGPT 授权已失效，请重新登录。', true)
      }
      throw oauthFailure()
    }
    return result
  } catch (error) {
    if (error instanceof ChatGptOAuthError) throw error
    throw oauthFailure()
  }
}

function parseTokens(data: Record<string, unknown>, previousIdToken?: string): ChatGptTokens {
  const { access_token, refresh_token, id_token, expires_in, scope, token_type, earliest_refresh_at } = data
  if (!validToken(access_token) || access_token.startsWith('sk-') || !validToken(refresh_token) ||
    !validToken(id_token ?? previousIdToken) || typeof expires_in !== 'number' || !Number.isFinite(expires_in) ||
    expires_in <= 0 || expires_in > 86_400 || typeof scope !== 'string' ||
    !scope.split(/\s+/u).includes(requiredScope) || typeof token_type !== 'string' || token_type.toLowerCase() !== 'bearer') {
    throw new ChatGptOAuthError('ChatGPT 没有授予使用订阅额度的权限。', true)
  }
  const earliest = typeof earliest_refresh_at === 'string' ? Date.parse(earliest_refresh_at) :
    typeof earliest_refresh_at === 'number' ? earliest_refresh_at * 1000 : NaN
  const expiresAt = Date.now() + expires_in * 1000
  return {
    accessToken: access_token, refreshToken: refresh_token, idToken: (id_token ?? previousIdToken) as string,
    expiresAt, earliestRefreshAt: Number.isFinite(earliest) && earliest < expiresAt ? earliest : 0,
  }
}

export function verifyChatGptIdToken(token: string, keys: unknown, clientId: string, nonce?: string): ChatGptIdentity {
  try {
    const parts = token.split('.')
    if (parts.length !== 3 || parts.some(part => !/^[\w-]+$/u.test(part))) throw oauthFailure()
    const [headerPart, claimsPart, signature] = parts as [string, string, string]
    const header = object(JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')))
    const claims = object(JSON.parse(Buffer.from(claimsPart, 'base64url').toString('utf8')))
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw oauthFailure()
    const list = object(keys).keys
    if (!Array.isArray(list)) throw oauthFailure()
    const matches = list.filter(key => key?.kid === header.kid && key.kty === 'RSA' &&
      (key.use === undefined || key.use === 'sig') && (key.alg === undefined || key.alg === 'RS256'))
    if (matches.length !== 1) throw oauthFailure()
    const key = createPublicKey({ key: matches[0] as JsonWebKey, format: 'jwk' })
    if (!verify('RSA-SHA256', Buffer.from(`${headerPart}.${claimsPart}`), key, Buffer.from(signature, 'base64url'))) throw oauthFailure()
    const now = Math.floor(Date.now() / 1000)
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (claims.iss !== issuer || !audiences.includes(clientId) ||
      ((audiences.length > 1 || claims.azp !== undefined) && claims.azp !== clientId) ||
      typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now ||
      (typeof claims.nbf === 'number' && claims.nbf > now) || (nonce !== undefined && claims.nonce !== nonce) ||
      typeof claims.sub !== 'string' || claims.sub.length === 0 || claims.sub.length > 256) throw oauthFailure()
    const email = claims.email_verified === true && typeof claims.email === 'string' &&
      /^[^\s\u0000-\u001f]{3,254}$/u.test(claims.email) ? claims.email : undefined
    return { clientId, subject: claims.sub, email }
  } catch { throw oauthFailure() }
}

async function identity(token: string, clientId: string, signal: AbortSignal, nonce?: string): Promise<ChatGptIdentity> {
  const response = await fetch(jwksUrl, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) })
  if (!response.ok) throw oauthFailure()
  return verifyChatGptIdToken(token, await readJson(response), clientId, nonce)
}

export async function signInWithChatGpt(options: {
  hostId: string
  previous?: ChatGptIdentity & { tokens?: ChatGptTokens }
  openBrowser(url: string): Promise<void>
  signal: AbortSignal
}): Promise<ChatGptIdentity & { tokens: ChatGptTokens }> {
  const { hostId, previous, openBrowser, signal } = options
  const state = randomBytes(32).toString('base64url')
  const nonce = randomBytes(32).toString('base64url')
  const verifier = randomBytes(64).toString('base64url')
  let redirectUri: string | undefined
  let consumed = false
  const result = Promise.withResolvers<{ code: string; clientId: string }>()
  // The abort listener may fire while the browser is opening.
  void result.promise.catch(() => {})
  const server = createServer((request, response) => {
    const send = (status: number, message: string) => response.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff', connection: 'close',
    }).end(message)
    if (consumed || !redirectUri || request.method !== 'GET' || request.socket.remoteAddress !== '127.0.0.1' ||
      request.headers.host !== new URL(redirectUri).host || !request.url?.startsWith('/') || request.url.length > 8192) {
      return send(404, 'Not found')
    }
    const callback = new URL(request.url, redirectUri)
    if (callback.origin !== new URL(redirectUri).origin || callback.pathname !== callbackPath ||
      callback.searchParams.getAll('state').length !== 1 || callback.searchParams.get('state') !== state) {
      return send(400, 'Invalid callback')
    }
    consumed = true
    const code = callback.searchParams.get('code')
    const returnedClientId = callback.searchParams.get('client_id')
    const clientId = previous?.clientId ?? returnedClientId
    if (callback.searchParams.has('error') || !validToken(code) || !validClientId(clientId) ||
      (previous && returnedClientId && returnedClientId !== clientId)) {
      send(400, 'Authorization was canceled or could not be verified. Return to Zlo Agent.')
      result.reject(new ChatGptOAuthError('ChatGPT 授权已取消或验证失败。'))
      return
    }
    send(200, 'Authorization received. Return to Zlo Agent to finish signing in.')
    result.resolve({ code, clientId })
  })
  const abort = () => result.reject(new ChatGptOAuthError('ChatGPT 登录已取消或超时。'))
  signal.addEventListener('abort', abort, { once: true })
  server.on('error', () => result.reject(oauthFailure()))
  try {
    signal.throwIfAborted()
    await Promise.race([new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)), result.promise])
    redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}${callbackPath}`
    const params = new URLSearchParams({
      client_id: previous?.clientId ?? 'dynamic_agent_client', ext_agent_host_id: `urn:uuid:${hostId}`,
      redirect_uri: redirectUri, response_type: 'code', resource,
      scope: `openid profile email offline_access resource.invoke ${requiredScope}`, state, nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    })
    if (!previous) params.set('agent_name_hint', 'Zlo Agent')
    else if (previous.tokens?.idToken) params.set('id_token_hint', previous.tokens.idToken)
    await openBrowser(`${authorizeUrl}?${params}`)
    const { code, clientId } = await result.promise
    const tokens = parseTokens(await exchange({ grant_type: 'authorization_code', client_id: clientId,
      code, code_verifier: verifier, redirect_uri: redirectUri }, signal))
    const verified = await identity(tokens.idToken, clientId, signal, nonce)
    if (previous && previous.subject !== verified.subject) throw oauthFailure()
    return { ...verified, tokens }
  } catch (error) {
    if (error instanceof ChatGptOAuthError) throw error
    throw oauthFailure()
  } finally {
    signal.removeEventListener('abort', abort)
    server.close()
    server.closeAllConnections()
  }
}

export async function refreshChatGptTokens(profile: ChatGptIdentity & { tokens: ChatGptTokens }, signal: AbortSignal) {
  const data = await exchange({ grant_type: 'refresh_token', client_id: profile.clientId, refresh_token: profile.tokens.refreshToken }, signal)
  const tokens = parseTokens(data, profile.tokens.idToken)
  if (typeof data.id_token === 'string') {
    const verified = await identity(data.id_token, profile.clientId, signal)
    if (verified.subject !== profile.subject) throw oauthFailure()
  }
  return tokens
}

export async function listChatGptModels(tokens: ChatGptTokens, signal: AbortSignal) {
  const response = await fetch(`${resource}/models`, {
    headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json', 'user-agent': 'Zlo-Agent' },
    redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    if (response.status === 401 || response.status === 403) {
      throw new ChatGptOAuthError('ChatGPT 账号无权使用此应用的模型。', true)
    }
    throw oauthFailure()
  }
  const models = object(await readJson(response)).models
  if (!Array.isArray(models)) throw oauthFailure()
  return [...new Set(models.filter(model => model?.visibility === 'list' && validModelId(model.slug)).map(model => model.slug as string))]
}

export async function revokeChatGptTokens(profile: ChatGptIdentity & { tokens: ChatGptTokens }): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(revokeUrl, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
        body: new URLSearchParams({ token: profile.tokens.refreshToken, token_type_hint: 'refresh_token', client_id: profile.clientId }),
      })
      await response.body?.cancel().catch(() => {})
      if (response.status === 200) return true
      if (response.status < 500) return false
    } catch { /* A local sign-out can still finish if the server cannot be reached. */ }
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 350))
  }
  return false
}
