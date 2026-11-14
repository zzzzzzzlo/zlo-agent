import assert from 'node:assert/strict'
import { test } from 'node:test'
import { judgeProxyUrl } from '../electron/main/judge-proxy.ts'

test('uses Chromium proxy routing only when the first route is a supported HTTP proxy', () => {
  assert.equal(judgeProxyUrl('PROXY 127.0.0.1:1080; DIRECT'), 'http://127.0.0.1:1080/')
  assert.equal(judgeProxyUrl('HTTPS [::1]:444'), 'https://[::1]:444/')
  assert.equal(judgeProxyUrl('DIRECT; PROXY 127.0.0.1:1080'), undefined)
  assert.equal(judgeProxyUrl('SOCKS5 127.0.0.1:1080'), undefined)
  assert.equal(judgeProxyUrl('PROXY name:65536'), undefined)
  assert.equal(judgeProxyUrl('PROXY auth@name:1234'), undefined)
})
