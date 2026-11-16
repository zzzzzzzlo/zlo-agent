import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { jevEndpoint, openCodeJudgeEndpoint } from '../../shared/contracts/jev.ts'
import type { GrokCredential } from '../../shared/contracts/provider-setup.ts'
import { ChatGptAccount } from '../electron/main/chatgpt-account.ts'
import type { EncryptedStore } from '../electron/main/encrypted-storage.ts'
import { HostTransportError } from '../electron/main/host-process.ts'
import type { HostProcessManager } from '../electron/main/host-process.ts'
import { SecureJevCredentials } from '../electron/main/provider-credentials.ts'
import { ProviderSetup } from '../electron/main/provider-setup.ts'

function memoryStore(): EncryptedStore & { files: Map<string, unknown> } {
  const files = new Map<string, unknown>()
  return {
    files,
    available: () => true,
    async read(path) {
      await delay(5)
      return files.has(path) ? structuredClone(files.get(path)) : undefined
    },
    async write(path, value) {
      await delay(5)
      files.set(path, structuredClone(value))
    },
  }
}

test('P1-4: SecureJevCredentials serializes concurrent writes without losing sibling endpoints', async () => {
  const store = memoryStore()
  const creds = new SecureJevCredentials('/virtual-user-data', store)
  await Promise.all([
    creds.set(jevEndpoint, 'jev-typesafekey-123456'),
    creds.set(openCodeJudgeEndpoint, 'oc_sk_opencodekey_123456'),
  ])
  assert.deepEqual(await creds.load(), {
    [jevEndpoint]: 'jev-typesafekey-123456',
    [openCodeJudgeEndpoint]: 'oc_sk_opencodekey_123456',
  })
})

test('P1-4: custom provider key/provider deletion never restores deleted secret when Host is offline', async () => {
  const store = memoryStore()
  let hostOnline = true
  let restartState: 'ready' | 'offline' = 'ready'
  let restarts = 0
  const fakeHost = {
    async request() {
      if (!hostOnline) throw new HostTransportError('HOST_UNAVAILABLE', 'Host offline')
      return []
    },
    async restart() {
      restarts++
      return { state: restartState, mode: 'pi' as const }
    },
  } as unknown as HostProcessManager
  const setup = new ProviderSetup('/virtual-user-data', () => fakeHost, { store })
  t_cleanup: {
    await setup.updateCustom('local-vllm', async () => ({
      id: 'local-vllm', name: 'Local vLLM', baseUrl: 'http://127.0.0.1:8000/v1', models: ['qwen'], key: 'sk-custom-secret-to-delete',
    }))
    hostOnline = false
    restartState = 'ready'
    const afterKeyRemove = await setup.updateCustom('local-vllm', async prev => prev ? { ...prev, key: null } : undefined)
    assert.equal(afterKeyRemove[0]?.hasKey, false)
    assert.equal(restarts, 1)
    assert.equal((await setup.loadCustom())[0]?.key, null)

    await setup.updateCustom('local-vllm', async prev => prev).catch(() => {})
    // Re-seed a secret directly to test total offline failure during deleteCustom:
    hostOnline = true
    await setup.updateCustom('local-vllm', async prev => prev ? { ...prev, key: 'sk-second-secret-to-delete' } : undefined)
    hostOnline = false
    restartState = 'offline'
    await assert.rejects(
      setup.updateCustom('local-vllm', async () => null),
      /本地凭证已清除/,
    )
    assert.deepEqual(await setup.loadCustom(), [])
    break t_cleanup
  }
  setup.close()
})

test('P1-4: Grok refresh keeps retrying with backoff even when the saved token is already expired', async () => {
  const store = memoryStore()
  const expired: GrokCredential = {
    type: 'oauth',
    access: 'grok-expired-access-token',
    refresh: 'grok-valid-refresh-token',
    expires: Date.now() - 10_000,
  }
  await store.write('/virtual-user-data\\grok-credentials.bin', expired)
  await store.write('/virtual-user-data/grok-credentials.bin', expired)
  let refreshCalls = 0
  const refreshed: GrokCredential = {
    type: 'oauth',
    access: 'grok-fresh-access-token',
    refresh: 'grok-rotated-refresh-token',
    expires: Date.now() + 3_600_000,
  }
  const fakeHost = {
    async request(cmd: { type: string }) {
      if (cmd.type === 'refreshGrokLogin') {
        refreshCalls++
        if (refreshCalls === 1) throw new HostTransportError('HOST_UNAVAILABLE', 'Transient network error')
        return refreshed
      }
      if (cmd.type === 'applyGrokSession') {
        return [{ route: { provider: 'xai', model: 'grok-3' }, name: 'Grok 3' }]
      }
      return []
    },
    async restart() { return { state: 'ready' as const, mode: 'pi' as const } },
  } as unknown as HostProcessManager
  // Ensure exact path match via join:
  const { join } = await import('node:path')
  await store.write(join('/virtual-user-data', 'grok-credentials.bin'), expired)
  const setup = new ProviderSetup('/virtual-user-data', () => fakeHost, { store, retryBaseMs: 25 })
  try {
    await setup.loadGrok()
    for (let tick = 0; tick < 40; tick++) {
      if (refreshCalls >= 2 && (await setup.grokStatus()).state === 'connected') break
      await delay(20)
    }
    assert.ok(refreshCalls >= 2, `Expected retry after expired failure, got ${refreshCalls}`)
    const status = await setup.grokStatus()
    assert.equal(status.state, 'connected')
  } finally {
    setup.close()
  }
})

test('P1-4: ChatGptAccount.loadSession refreshes an expired access token before returning', async (context) => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const keys = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] }
  const profileId = randomUUID()
  const hostId = randomUUID()
  const clientId = 'oaiapp_refresh_fixture'
  const makeIdToken = () => {
    const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
    const unsigned = encode({ alg: 'RS256', kid: 'k1' }) + '.' + encode({
      iss: 'https://auth.openai.com', sub: 'subj-1', aud: clientId, exp: Math.floor(Date.now() / 1000) + 3600,
    })
    return unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')
  }
  const store = memoryStore()
  const { join } = await import('node:path')
  await store.write(join('/virtual-user-data', 'chatgpt-credentials.bin'), {
    version: 1,
    hostId,
    active: profileId,
    profiles: [{
      id: profileId,
      clientId,
      subject: 'subj-1',
      models: ['gpt-5'],
      tokens: {
        accessToken: 'expired-chatgpt-access-token',
        refreshToken: 'valid-chatgpt-refresh-token',
        idToken: makeIdToken(),
        expiresAt: Date.now() - 5_000,
        earliestRefreshAt: Date.now() - 60_000,
      },
    }],
  })
  context.mock.method(globalThis, 'fetch', async (input: string) => {
    if (input === 'https://auth.openai.com/.well-known/jwks.json') return Response.json(keys)
    return Response.json({
      access_token: 'fresh-chatgpt-access-token',
      refresh_token: 'rotated-chatgpt-refresh-token',
      id_token: makeIdToken(),
      scope: 'openid chatgpt.tokens.use.direct offline_access',
      token_type: 'Bearer',
      expires_in: 3600,
    })
  })
  const account = new ChatGptAccount('/virtual-user-data', {
    store,
    async applySession() { return [] },
  })
  try {
    const session = await account.loadSession()
    assert.ok(session)
    assert.equal(session.accessToken, 'fresh-chatgpt-access-token')
    assert.equal((await account.status()).state, 'connected')
  } finally {
    account.close()
  }
})
