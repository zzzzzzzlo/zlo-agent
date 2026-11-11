import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { test } from 'node:test'
import { signInWithChatGpt, verifyChatGptIdToken } from '../electron/main/chatgpt-oauth.ts'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const keys = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }] }
const clientId = 'oaiapp_fixture'
const baseClaims = { iss: 'https://auth.openai.com', sub: 'fixture-subject', aud: clientId,
  exp: Math.floor(Date.now() / 1000) + 3600, email: 'person@example.invalid', email_verified: true }
const accessToken = 'fixture-chatgpt-access-token'
const refreshToken = 'fixture-chatgpt-refresh-token'

function idToken(claims: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = encode({ alg: 'RS256', kid: 'test-key' }) + '.' + encode(claims)
  return unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')
}

test('signed OpenAI identity validates issuer, audience, expiry, and the browser nonce', () => {
  const claims = { ...baseClaims, nonce: 'test-nonce' }
  assert.deepEqual(verifyChatGptIdToken(idToken(claims), keys, clientId, claims.nonce), {
    clientId, subject: 'fixture-subject', email: 'person@example.invalid',
  })
  for (const change of [{ iss: 'https://invalid.example' }, { aud: 'other' }, { exp: 1 }, { nonce: 'other' }]) {
    assert.throws(() => verifyChatGptIdToken(idToken({ ...claims, ...change }), keys, clientId, claims.nonce))
  }
  const [header, payload, signature] = idToken(claims).split('.')
  const altered = (signature?.[0] === 'a' ? 'b' : 'a') + signature?.slice(1)
  assert.throws(() => verifyChatGptIdToken(`${header}.${payload}.${altered}`, keys, clientId, claims.nonce))
})

test('loopback authorization exchanges only the valid one-time callback with its issued client ID and PKCE', async context => {
  const browserFetch = fetch
  const hostId = randomUUID()
  let authUrl: URL | undefined
  let exchanged = 0
  let browserError: unknown
  context.mock.method(globalThis, 'fetch', async (input: string, options?: RequestInit) => {
    assert.equal(options?.redirect, 'error')
    if (input === 'https://auth.openai.com/.well-known/jwks.json') return Response.json(keys)
    assert.equal(input, 'https://auth.openai.com/api/accounts/oauth/token')
    const body = options?.body as URLSearchParams
    assert.equal(body.get('client_id'), clientId)
    assert.equal(body.get('redirect_uri'), authUrl?.searchParams.get('redirect_uri'))
    assert.equal(body.get('resource'), 'https://api.openai.com/v1')
    assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), authUrl?.searchParams.get('code_challenge'))
    exchanged++
    return Response.json({ access_token: accessToken, refresh_token: refreshToken,
      id_token: idToken({ ...baseClaims, nonce: authUrl?.searchParams.get('nonce') }),
      scope: 'openid chatgpt.tokens.use.direct offline_access', token_type: 'Bearer', expires_in: 3600 })
  })
  const result = await signInWithChatGpt({ hostId, signal: AbortSignal.timeout(3_000), async openBrowser(url) {
    try {
      authUrl = new URL(url)
      assert.equal(authUrl.origin, 'https://auth.openai.com')
      assert.equal(authUrl.searchParams.get('client_id'), 'dynamic_agent_client')
      assert.equal(authUrl.searchParams.get('ext_agent_host_id'), `urn:uuid:${hostId}`)
      assert.equal(authUrl.searchParams.get('agent_name_hint'), 'Zlo Agent')
      const callback = new URL(authUrl.searchParams.get('redirect_uri')!)
      assert.equal(callback.hostname, '127.0.0.1')
      callback.search = new URLSearchParams({ code: 'fixture-authorize-code', state: 'invalid', client_id: clientId }).toString()
      const rejected = await browserFetch(callback, { headers: { connection: 'close' } })
      assert.equal(rejected.status, 400)
      await rejected.text()
      assert.equal(exchanged, 0)
      callback.searchParams.set('state', authUrl.searchParams.get('state')!)
      const accepted = await browserFetch(callback, { headers: { connection: 'close' } })
      assert.equal(accepted.status, 200)
      await accepted.text()
    } catch (error) { browserError = error; throw error }
  } }).catch(error => { throw browserError ?? error })
  assert.equal(exchanged, 1)
  assert.equal(result.clientId, clientId)
  assert.equal(result.tokens.refreshToken, refreshToken)
})

test('canceling a browser authorization closes the callback listener without requesting tokens', async context => {
  const browserFetch = fetch
  const controller = new AbortController()
  let callback: URL | undefined
  const network = context.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected exchange') })
  await assert.rejects(signInWithChatGpt({ hostId: randomUUID(), signal: controller.signal, async openBrowser(url) {
    callback = new URL(new URL(url).searchParams.get('redirect_uri')!)
    controller.abort()
  } }), /取消/u)
  assert.equal(network.mock.callCount(), 0)
  await assert.rejects(browserFetch(callback!))
})
