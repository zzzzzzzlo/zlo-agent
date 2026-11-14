import { useEffect, useState } from 'react'
import type { CustomProviderConfig, CustomProviderSummary, CustomProviderTest, DesktopProviderSetupApi, GrokStatus } from '../../../../shared/contracts/provider-setup.ts'
import { parseCustomProvider, validCustomModel } from '../../../../shared/contracts/provider-setup.ts'
import type { PerformManagement } from './ModelManagement'
import { managementError } from './managementData'

export function useProviderSetup() {
  const api = window.agentProviderSetup
  const [providers, setProviders] = useState<CustomProviderSummary[]>([])
  const [grok, setGrok] = useState<GrokStatus>()
  const [error, setError] = useState<string>()
  const [poll, setPoll] = useState(false)
  useEffect(() => {
    if (!api) return
    let live = true
    void api.listCustom().then(value => { if (live) setProviders(value) },
      reason => { if (live) setError(managementError(reason)) })
    return () => { live = false }
  }, [api])
  useEffect(() => {
    if (!api) return
    let live = true
    const update = () => void api.grokStatus().then(value => {
      if (live) { setGrok(value); if (value.state === 'signing_in') setPoll(true) }
    }, reason => { if (live) setError(managementError(reason)) })
    update()
    const timer = poll ? window.setInterval(update, 1000) : undefined
    window.addEventListener('focus', update)
    return () => { live = false; window.clearInterval(timer); window.removeEventListener('focus', update) }
  }, [api, poll])
  return { api, providers, setProviders, grok, setGrok, setPoll, error }
}

const grokLabels: Record<GrokStatus['state'], string> = {
  unavailable: '当前 Host 不支持',
  signed_out: '未登录',
  signing_in: '等待浏览器授权',
  connected: '已授权',
  reauthorization_required: '需要重新授权',
}

export function GrokManagement({ setup, busy, perform }: {
  setup: ReturnType<typeof useProviderSetup>; busy: boolean; perform: PerformManagement
}) {
  const { api, grok, setGrok, setPoll } = setup
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string>()
  const waiting = starting || grok?.state === 'signing_in'
  return (
    <section className="provider-form">
      <div className="provider-detail-title"><h4>Grok 订阅账号</h4><span>{grok ? grokLabels[grok.state] : '读取授权状态…'}</span></div>
      <p className="management-note">在系统浏览器授权 xAI 账号，订阅及可用模型由 xAI 确定。</p>
      {grok?.code && <p className="provider-device-code" role="status">浏览器要求输入验证码时使用 <strong>{grok.code}</strong></p>}
      {grok?.state === 'connected' && <p className="management-note">{grok.models.length} 个模型已加入会话选择器。</p>}
      {error && <p className="dialog-error" role="alert">{error}</p>}
      {api && grok && grok.state !== 'unavailable' && <div className="management-actions">
        {waiting ? <button className="button-neutral" type="button" onClick={() =>
          void api.grokCancel().catch(reason => setError(managementError(reason)))}>取消登录</button> :
          <button className="button-primary" type="button" disabled={busy} onClick={() => perform(async () => {
            setError(undefined)
            setStarting(true)
            setPoll(true)
            try { setGrok(await api.grokSignIn()) }
            catch (reason) { setError(managementError(reason)) }
            finally { setStarting(false); setPoll(false) }
          })}>{grok.state === 'connected' ? '重新授权 Grok' : '登录 Grok'}</button>}
        {(grok.state === 'connected' || grok.state === 'reauthorization_required') && <button type="button" className="button-neutral"
          disabled={busy} onClick={() => perform(async () => setGrok(await api.grokSignOut()), '已退出本机 Grok 账号。')}>退出 Grok</button>}
      </div>}
    </section>
  )
}

export function emptyProvider(providers: CustomProviderSummary[]): CustomProviderConfig {
  let id = 'custom'
  for (let suffix = 2; providers.some(provider => provider.id === id); suffix++) id = 'custom-' + suffix
  return { id, name: '', baseUrl: '', models: [] }
}

export function CustomProviderForm({ initial, hasKey, isNew, busy, api, perform, onChange, onDiscard }: {
  initial: CustomProviderConfig; hasKey: boolean; isNew: boolean; busy: boolean; api: DesktopProviderSetupApi; perform: PerformManagement
  onChange(providers: CustomProviderSummary[], id?: string): void; onDiscard(): void
}) {
  const [draft, setDraft] = useState(initial)
  const [model, setModel] = useState('')
  const [test, setTest] = useState<CustomProviderTest>()
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  const editable = parseCustomProvider(draft)
  const id = { id: initial.id }
  const input = (field: 'name' | 'id' | 'baseUrl', value: string) => setDraft(previous => ({ ...previous, [field]: value }))
  const add = (id: string) => {
    if (!validCustomModel(id) || draft.models.includes(id) || draft.models.length >= 20) return
    setDraft(previous => ({ ...previous, models: [...previous.models, id] }))
    setModel('')
  }
  const testText = test?.state === 'connected' ? '目录连接正常'
    : test?.state === 'unauthorized' ? '授权失败，请检查 API Key。' : '目录连接失败，可手动填写模型 ID。'
  return (
    <form className="provider-form" onSubmit={(event) => {
      event.preventDefault()
      if (!editable || busy) return
      perform(async () => {
        const providers = await api.saveCustom({ ...editable, create: isNew })
        if (editable.baseUrl !== initial.baseUrl) setTest(undefined)
        setDraft(editable)
        onChange(providers, editable.id)
      }, '已保存提供商。')
    }}>
      <div className="provider-detail-title">
        <h4>{isNew ? '新提供商' : initial.name}</h4>
        {isNew && <span>未保存</span>}
      </div>
      <div className="provider-field-pair">
        <label className="field-label">显示名称<input required maxLength={80} placeholder="例如 我的模型服务" disabled={busy}
          value={draft.name} onChange={event => input('name', event.target.value)} /></label>
        <label className="field-label">提供商 ID<input required maxLength={40} disabled={!isNew || busy}
          value={draft.id} onChange={event => input('id', event.target.value)} /></label>
      </div>
      <div className="field-label"><span>API 格式</span><span className="provider-static-field">OpenAI 兼容（Chat Completions）</span></div>
      <label className="field-label">接口地址（Base URL）<input required type="url" maxLength={512} placeholder="https://api.example.com/v1" disabled={busy}
        value={draft.baseUrl} onChange={event => input('baseUrl', event.target.value)} /></label>
      <div className="provider-field">
        <div className="provider-detail-title"><strong>API Key</strong><span>{hasKey ? '已加密保存' : '未配置'}</span></div>
        {isNew ? <p className="management-note">保存提供商后，可在系统确认框中导入已复制的密钥。</p> :
          <div className="management-actions">
            <button type="button" className="button-neutral" disabled={busy || dirty} onClick={() =>
              perform(async () => { setTest(undefined); onChange(await api.setCustomKey(id), id.id) })}>{hasKey ? '更新 API Key' : '添加 API Key'}</button>
            {hasKey && <button type="button" className="button-neutral" disabled={busy || dirty} onClick={() =>
              perform(async () => { setTest(undefined); onChange(await api.removeCustomKey(id), id.id) })}>删除 API Key</button>}
            <button type="button" className="button-neutral" disabled={busy || dirty} onClick={() =>
              perform(async () => setTest(await api.testCustom(id)))}>测试连接</button>
          </div>}
        {test && <p role="status" className={test.state === 'connected' ? 'management-note' : 'dialog-error'}>{testText}</p>}
      </div>
      <div className="provider-field">
        <strong>模型列表</strong>
        {draft.models.length > 0 && <ul className="provider-models">{draft.models.map(id => <li key={id}>
          <code>{id}</code><button className="button-neutral" type="button" disabled={busy}
            onClick={() => setDraft(previous => ({ ...previous, models: previous.models.filter(entry => entry !== id) }))} aria-label={`移除模型 ${id}`}>移除</button>
        </li>)}</ul>}
        <div className="provider-add-model">
          <label className="field-label">模型 ID<input maxLength={160} value={model} onChange={event => setModel(event.target.value)}
            list="provider-model-suggestions" placeholder="例如 deepseek-chat" disabled={busy} onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); add(model.trim()) }
            }} /></label>
          <datalist id="provider-model-suggestions">{test?.models.map(id => <option key={id} value={id} />)}</datalist>
          <button className="button-neutral" type="button" disabled={busy || !validCustomModel(model.trim()) ||
            draft.models.includes(model.trim()) || draft.models.length >= 20} onClick={() => add(model.trim())}>添加模型</button>
        </div>
      </div>
      <div className="provider-form-footer management-actions">
        {!isNew && <button type="button" className="button-danger" disabled={busy} onClick={() => perform(async () => {
          const providers = await api.deleteCustom(id)
          onChange(providers, providers.some(provider => provider.id === id.id) ? id.id : undefined)
        })}>移除提供商</button>}
        <div>
          {(isNew || dirty) && <button className="button-neutral" type="button" disabled={busy} onClick={() => {
            if (isNew) onDiscard()
            else setDraft(initial)
          }}>放弃修改</button>}
          <button className="button-primary" type="submit" disabled={busy || !editable || (!isNew && !dirty)}>保存提供商</button>
        </div>
      </div>
    </form>
  )
}
