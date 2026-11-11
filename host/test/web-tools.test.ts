import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BraveSearch, HackerNewsSearch, PublicWebClient, cleanWebText, createWebTools, extractWebText, isPublicWebAddress, publicWebUrl } from '../src/web-tools.ts'
import type { WebClient, WebResponse } from '../src/web-tools.ts'
import type { CodingWorkspace } from '../src/workspace.ts'

const publicV4 = { address: '1.1.1.1', family: 4 }
const publicV6 = { address: '2606:4700:4700::1111', family: 6 }
const response: WebResponse = { status: 200, contentType: 'text/html', body: Buffer.from('<main><p>Example</p></main>') }

test('public web policy rejects non-HTTPS, credential-bearing and internal URLs', () => {
  for (const url of [
    'http://example.com/', 'https://example.com:444/', 'https://root:secret@example.com/',
    'https://localhost/', 'https://metadata.google.internal/', 'https://169.254.169.254/',
    'https://0177.0.0.1/', 'https://[::ffff:127.0.0.1]/', 'https://example.com/?session_id=hidden',
    'https://example.com/?x=%73%6b%2dthis_is_a_test_fixture_key',
  ]) assert.throws(() => publicWebUrl(url), /policy/, url)
  assert.equal(publicWebUrl('https://example.com:443/?q=patch#heading').href, 'https://example.com/?q=patch')
})

test('address policy accepts ordinary public routes and rejects mapped, special and private DNS answers', () => {
  assert.ok(isPublicWebAddress(publicV4))
  assert.ok(isPublicWebAddress(publicV6))
  for (const address of ['127.0.0.1', '169.254.169.254', '168.63.129.16', '192.168.1.2', '100.100.100.200',
    '::ffff:8.8.8.8', '::1', 'fd00:ec2::254', 'fe80::1%eth0', '2002:c0a8:101::', '64:ff9b::a9fe:a9fe', '2001:db8::1']) {
    assert.equal(isPublicWebAddress({ address, family: address.includes(':') ? 6 : 4 }), false, address)
  }
})

test('public transport rejects mixed DNS sets, reuses a pinned address on retry, and checks redirects anew', async () => {
  const attempts: string[] = []
  const mixed = new PublicWebClient({
    resolve: async () => [publicV4, { address: '::1', family: 6 }],
    send: async url => { attempts.push(url.href); return response },
  })
  await assert.rejects(mixed.get('https://example.com/'), /policy/)
  assert.equal(attempts.length, 0)

  let resolutions = 0
  const pinned = new PublicWebClient({
    resolve: async () => ++resolutions === 1 ? [publicV4, publicV6] : [{ address: '127.0.0.1', family: 4 }],
    send: async (url, address) => {
      attempts.push(url.href)
      assert.deepEqual(address, publicV4)
      return attempts.length === 1 ? { ...response, status: 503 } : response
    },
  })
  assert.equal((await pinned.get('https://example.com/')).status, 200)
  assert.equal(resolutions, 1)
  assert.equal(attempts.length, 2)

  const redirect = new PublicWebClient({
    resolve: async hostname => hostname === 'example.com' ? [publicV4] : [{ address: '169.254.169.254', family: 4 }],
    send: async url => {
      assert.equal(url.hostname, 'example.com')
      return { ...response, status: 302, location: 'https://redirect.example.net/private' }
    },
  })
  await assert.rejects(redirect.get('https://example.com/'), /policy/)
  await assert.rejects(redirect.get('https://example.com/', { allowedOrigin: 'https://example.com' }), /policy/)
})

test('public transport bounds response size and settles on abort even if DNS has not finished', async () => {
  const limited = new PublicWebClient({ resolve: async () => [publicV4], send: async () => response })
  await assert.rejects(limited.get('https://example.com/', { maxBytes: 1 }), /limit/)
  const slow = new PublicWebClient({
    resolve: () => new Promise(() => {}),
    send: async () => { throw new Error('Should not send') },
  })
  const abort = new AbortController()
  const result = slow.get('https://example.com/', { signal: abort.signal })
  abort.abort()
  await assert.rejects(result, /timeout/)
})

test('web tools extract useful source data and use a replaceable keyless search provider', async () => {
  const client: WebClient = {
    async get(input) {
      const url = new URL(input)
      if (url.hostname === 'hn.algolia.com') {
        assert.equal(url.searchParams.get('query'), 'type systems')
        return { ...response, url, body: Buffer.from(JSON.stringify({ hits: [
          { objectID: '123', title: 'Type system', url: 'https://example.com/types', story_text: '<span>Types</span> &amp; rules' },
        ] })) }
      }
      return { ...response, url,
        body: Buffer.from('<title>Source &amp; record</title><nav>menu</nav><main><h1>Main</h1><script>discard()</script><p> Evidence </p></main>') }
    },
  }
  const tools = createWebTools({} as CodingWorkspace, { client, provider: new HackerNewsSearch(client) })
  const search = tools.find(tool => tool.name === 'web_search')!
  const fetch = tools.find(tool => tool.name === 'web_fetch')!
  assert.equal(search.policy?.approval, 'network')
  assert.equal(fetch.policy?.approval, 'network')
  assert.deepEqual(await search.execute('search', { query: 'type systems' }), {
    ok: true, untrusted: true,
    results: [{ url: 'https://example.com/types', title: 'Type system', snippet: 'Types & rules',
      source: 'Hacker News via Algolia', sourceUrl: 'https://news.ycombinator.com/item?id=123' }],
  })
  assert.deepEqual(await fetch.execute('fetch', { url: 'https://example.com/info?lang=en' }), {
    ok: true, untrusted: true, url: 'https://example.com/info', source: 'example.com', title: 'Source & record', text: 'Main Evidence',
  })
  assert.deepEqual(extractWebText('<article>hello <style>not shown</style>test</article>', 9), { title: '', text: 'hello tes' })
  assert.equal(cleanWebText('Set-Cookie: session=example-fixture', 128), '[redacted]')
})

test('Brave provider uses its fixed HTTPS web endpoint and bounded source fields', async () => {
  const provider = new BraveSearch('test-fixture', {
    async get(input, options) {
      const url = new URL(input)
      assert.equal(url.origin + url.pathname, 'https://api.search.brave.com/res/v1/web/search')
      assert.equal(options?.allowedOrigin, url.origin)
      assert.equal(url.searchParams.get('q'), 'a search query')
      assert.equal(url.href.includes('test-fixture'), false)
      return { ...response, url, body: Buffer.from(JSON.stringify({ web: { results: [
        { title: 'Result', url: 'https://example.com/', description: '<strong>Example</strong>' },
      ] } })) }
    },
  })
  assert.deepEqual(await provider.search('a search query', 2), [
    { title: 'Result', url: 'https://example.com/', snippet: 'Example', source: 'Brave Search' },
  ])
})
