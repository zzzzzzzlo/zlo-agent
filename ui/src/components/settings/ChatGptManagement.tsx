import { useEffect, useRef, useState } from 'react'
import type { ChatGptStatus } from '../../../../shared/contracts/chatgpt.ts'
import type { PerformManagement } from './ModelManagement'
import { managementError } from './managementData'

export function useChatGptAccount(enabled: boolean) {
  const api = globalThis.window?.agentChatGpt
  const [state, setState] = useState<{ status?: ChatGptStatus; error?: string }>({})
  const version = useRef(0)
  useEffect(() => {
    if (!api || !enabled) return
    function refresh() {
      const request = ++version.current
      void api!.status().then(
        (status) => { if (request === version.current) setState({ status }) },
        (error) => { if (request === version.current) setState({ error: managementError(error) }) },
      )
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      version.current++
      window.removeEventListener('focus', refresh)
    }
  }, [api, enabled])
  return { api, ...state, setStatus(status: ChatGptStatus) {
    version.current++
    setState({ status })
  } }
}

const accountLabels: Record<ChatGptStatus['state'], string> = {
  signed_out: '未登录',
  connected: '已授权',
  reauthorization_required: '需要重新授权',
}

export function ChatGptManagement({ account, unavailable, busy, perform }: {
  account: ReturnType<typeof useChatGptAccount>
  unavailable: string
  busy: boolean
  perform: PerformManagement
}) {
  const { api, status, error, setStatus } = account
  const [selected, setSelected] = useState('')
  const [signingIn, setSigningIn] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string>()
  const active = status?.profiles.find((profile) => profile.id === status.activeProfileId)
  return (
    <section className="provider-form">
      <div className="provider-detail-title"><h4>ChatGPT / Codex 账号</h4>
        {status && <span>{accountLabels[status.state]}</span>}
      </div>
      {!api ? <p className="management-note">{unavailable}</p>
        : error ? <p className="dialog-error" role="alert">{error}</p>
          : !status ? <p className="management-note" role="status">正在读取授权状态…</p>
            : <>
              {active && <p className="management-note">{active.label}</p>}
              <p className="management-note">通过浏览器授权 ChatGPT 账号。OpenAI API Key 使用独立的 API 额度。</p>
              {status.state === 'connected' && <p className="management-note">{status.models.length} 个可用模型</p>}
              {status.profiles.length > 0 && (
                <label className="field-label">
                  要授权的账号
                  <select disabled={busy} value={selected} onChange={(event) => setSelected(event.target.value)}>
                    <option value="">添加其他账号</option>
                    {status.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
                  </select>
                </label>
              )}
              {status.remoteRevocationConfirmed === false && <p className="management-note">已退出本机，服务端撤销暂未确认。</p>}
              {cancelError && <p className="dialog-error" role="alert">{cancelError}</p>}
              <div className="management-actions">
                {signingIn ? (
                  <button type="button" className="button-neutral" disabled={cancelling} onClick={() => {
                    setCancelling(true)
                    void api.cancelSignIn().catch((reason) => setCancelError(managementError(reason))).finally(() => setCancelling(false))
                  }}>取消登录</button>
                ) : (
                  <button type="button" className="button-primary" disabled={busy} onClick={() => perform(async () => {
                    setCancelError(undefined)
                    setSigningIn(true)
                    try { setStatus(await api.signIn({ profileId: selected || undefined })) }
                    finally { setSigningIn(false) }
                  })}>{selected ? '重新授权账号' : '继续使用 ChatGPT'}</button>
                )}
                {status.activeProfileId && (
                  <button type="button" className="button-neutral" disabled={busy} onClick={() => perform(async () => {
                    setStatus(await api.signOut())
                  })}>退出 ChatGPT</button>
                )}
              </div>
            </>}
    </section>
  )
}
