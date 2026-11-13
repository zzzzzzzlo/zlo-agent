import { useEffect, useState } from 'react'
import { judgeProviders, judgmentPoints, parseJevSettings } from '../../../../shared/contracts/jev.ts'
import type { JevReason, JevSettings, JevStatus, JudgeProviderId } from '../../../../shared/contracts/jev.ts'
import type { DesktopManagementApi } from '../../../../shared/contracts/management.ts'
import type { PerformManagement } from './ModelManagement'

const reasons: Record<JevReason, string> = {
  missing_key: '尚未配置 API Key',
  timeout: '请求超时',
  busy: '判定并发已满',
  budget_exhausted: '本地判定预算已用尽',
  billing: '供应商账户余额不足',
  unauthorized: '服务拒绝了此凭证',
  rate_limited: '服务限流，稍后重试',
  unavailable: '暂时无法访问判定服务',
  invalid_response: '服务返回的判定格式无效',
  uncertain: '置信度不足',
  configuration_changed: '配置已变更',
  no_choice: '只有一个合法选项',
  invalid_model: '服务找不到配置的判定模型',
  cancelled: '任务已取消',
}

export function JevManagement({ api, busy, perform }: {
  api: DesktopManagementApi
  busy: boolean
  perform: PerformManagement
}) {
  const [status, setStatus] = useState<JevStatus>()
  const [draft, setDraft] = useState<JevSettings>()
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    let current = true
    const refresh = async () => {
      try {
        const next = await api.getJevStatus()
        if (current) {
          setStatus(next)
          setUnavailable(false)
        }
      } catch {
        if (current) setUnavailable(true)
      }
    }
    void refresh()
    const poll = setInterval(refresh, 5000)
    return () => { current = false; clearInterval(poll) }
  }, [api])

  const settings = draft ?? status?.settings
  function run(action: () => Promise<JevStatus>, save = false) {
    perform(async () => {
      const next = await action()
      setStatus(next)
      if (save) setDraft(undefined)
    })
  }

  if (!status || !settings) return <section className="management-group"><p className="management-note" role="status">
    {unavailable ? '暂时无法读取 Jev 设置。' : '正在读取 Jev 设置…'}
  </p></section>

  const stored = status.credential === 'stored'
  const connection = status.connection
  const endpointChanged = settings.endpoint !== status.settings.endpoint || settings.provider !== status.settings.provider
  const routeChanged = endpointChanged || settings.model !== status.settings.model
  const disabled = busy || unavailable
  return <>
    <section className="management-group">
      <h4>Jev / System One</h4>
      <label className="field-label">判定供应商
        <select value={settings.provider} disabled={disabled} onChange={event => {
          const provider = event.target.value as JudgeProviderId
          const preset = judgeProviders[provider]
          setDraft({ ...settings, provider, endpoint: preset.endpoint, model: preset.model })
        }}>
          {Object.entries(judgeProviders).map(([id, preset]) => <option key={id} value={id}>{preset.label}</option>)}
        </select>
      </label>
      <label className="field-label">API Endpoint
        <input value={settings.endpoint} placeholder="https://example.com/v1/systemone" disabled={disabled}
          readOnly={settings.provider !== 'custom'} onChange={event => setDraft({ ...settings, endpoint: event.target.value.trim() })} />
      </label>
      <label className="field-label">判定模型 ID
        <input value={settings.model} maxLength={100} disabled={disabled} onChange={event =>
          setDraft({ ...settings, model: event.target.value })} />
      </label>
      <p className="management-note">模型 ID 以供应商目录为准。自定义地址需提供兼容 System One 的完整请求地址。</p>
      <p className="management-note" role="status">{unavailable ? 'Host 暂时不可用'
        : routeChanged ? '保存后可为新地址配置凭证并测试'
        : !stored ? '尚未配置 API Key' : connection.state === 'untested' ? 'API Key 已加密保存，待测试'
        : connection.state === 'connected' ? '已连接 · ' + (connection.model ?? status.settings.model)
        : '已降级到规则基线 · ' + (connection.reason ? reasons[connection.reason] : '连接失败')}</p>
      <div className="management-actions">
        <button type="button" className="button-neutral" disabled={disabled || endpointChanged} onClick={() => run(() => api.setJevKey())}>
          {stored && !endpointChanged ? '更新 API Key' : '添加 API Key'}
        </button>
        <button type="button" className="button-neutral" disabled={disabled || !stored || routeChanged}
          onClick={() => run(() => api.testJevConnection())}>测试连接</button>
        {stored && !endpointChanged && <button type="button" className="button-danger" disabled={disabled}
          onClick={() => run(() => api.removeJevKey())}>删除 API Key</button>}
      </div>
      <label><input type="checkbox" checked={settings.enabled} disabled={disabled}
        onChange={event => setDraft({ ...settings, enabled: event.target.checked })} /> 全局启用 Jev</label>
      <p className="management-note">Shadow 和 Active 都会发送当前判定需要的脱敏片段。Shadow 只记录建议，Active 可以在 Host 允许的选项中作选择。</p>
    </section>
    <section className="management-group">
      <h4>判定点管理</h4>
      {judgmentPoints.map(point => {
        const mode = settings.modes[point.id]
        const effective = status.settings.modes[point.id]
        const latest = status.decisions[point.id]
        const label = !status.settings.enabled || effective === 'off' ? '已关闭'
          : !stored ? '等待 API Key' : latest?.mode !== effective ? '等待判定'
          : latest.reason ? '最近回退 · ' + reasons[latest.reason] : '最近判定 · ' + (latest.model ?? effective)
        return <div className="management-stack" key={point.id}>
          <div><strong>{point.label}</strong> <code>{point.id}</code></div>
          <p className="management-note">{point.description} {label}</p>
          <div className="management-actions">
            <label><input type="checkbox" checked={mode !== 'off'} disabled={disabled}
              onChange={event => setDraft({ ...settings, modes: { ...settings.modes,
                [point.id]: event.target.checked ? 'shadow' : 'off' } })} /> 启用{point.label}</label>
            <select aria-label={point.label + '模式'} value={mode === 'active' ? 'active' : 'shadow'} disabled={disabled || mode === 'off'}
              onChange={event => setDraft({ ...settings, modes: { ...settings.modes,
                [point.id]: event.target.value === 'active' ? 'active' : 'shadow' } })}>
              <option value="shadow">Shadow</option>
              <option value="active">Active</option>
            </select>
          </div>
        </div>
      })}
      <div className="management-actions">
        <button type="button" className="button-primary" disabled={disabled || !draft || !parseJevSettings(settings)}
          onClick={() => run(() => api.saveJevSettings(settings), true)}>保存 Jev 设置</button>
      </div>
    </section>
  </>
}
