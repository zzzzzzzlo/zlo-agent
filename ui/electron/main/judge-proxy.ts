import { openCodeJudgeEndpoint } from '../../../shared/contracts/jev.ts'

/** Respect the first route chosen by Chromium, including an explicit DIRECT result. */
export function judgeProxyUrl(resolved: string): string | undefined {
  const first = resolved.split(';', 1)[0].trim()
  const match = /^(PROXY|HTTPS) ([a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\]):([0-9]{1,5})$/u.exec(first)
  if (!match || Number(match[3]) < 1 || Number(match[3]) > 65535) return
  const url = URL.parse((match[1] === 'HTTPS' ? 'https://' : 'http://') + match[2] + ':' + match[3])
  return url?.href
}

export async function resolveOpenCodeJudgeProxy(
  resolveProxy: (url: string) => Promise<string>,
  timeoutMs = 1_000,
): Promise<string | undefined> {
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const route = await Promise.race([
      resolveProxy(openCodeJudgeEndpoint),
      new Promise<string>(resolve => { deadline = setTimeout(() => resolve('DIRECT'), timeoutMs) }),
    ])
    return judgeProxyUrl(route)
  } catch {
    return undefined
  } finally {
    clearTimeout(deadline)
  }
}
