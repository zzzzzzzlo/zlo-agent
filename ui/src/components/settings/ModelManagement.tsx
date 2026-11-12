import { useState } from 'react'
import type { ModelRoute } from '../../../../shared/contracts/desktop.ts'
import type { AgentPreferences, DesktopManagementApi, ManagedProvider, ManagementSnapshot } from '../../../../shared/contracts/management.ts'
import { ModelCatalogSelect, modelGroups } from './ModelCatalogSelect'
import { routeKey } from './managementData'
import { ChatGptManagement, useChatGptAccount } from './ChatGptManagement'

const connectionLabels: Record<ManagedProvider['connection'], string> = {
  untested: '待测试',
  connected: '连接正常',
  unauthorized: '授权失败',
  unavailable: '连接不可用',
}
const credentialLabels: Record<ManagedProvider['credential'], string> = {
  stored: '已保存到系统凭证存储',
  environment: '由启动环境提供',
  missing: '尚未配置 API Key',
}

export type PerformManagement = (operation: () => Promise<unknown>, success?: string) => void

const sections = [['api', 'API 接入'], ['account', 'ChatGPT 账号'], ['policy', '默认模型']] as const

export function ModelManagement({ snapshot, api, busy, perform, save }: {
  snapshot: ManagementSnapshot
  api: DesktopManagementApi
  busy: boolean
  perform: PerformManagement
  save(patch: Partial<AgentPreferences>): void
}) {
  const account = useChatGptAccount(true)
  const [section, setSection] = useState<typeof sections[number][0]>('api')
  return (
    <div className="management-stack">
      <nav className="model-sections" aria-label="模型与账号分类">
        {sections.map(([id, label]) => <button type="button" key={id} aria-current={section === id ? 'page' : undefined}
          onClick={() => setSection(id)}>{label}</button>)}
      </nav>
      {section === 'api' && <section className="management-group provider-page">
        <h4>API 供应商</h4>
        {snapshot.providers.length ? <div className="provider-grid">{snapshot.providers.map((provider) => (
          <ProviderControls key={provider.id} provider={provider} api={api} busy={busy} perform={perform} />
        ))}</div> : <p className="management-note">当前 Host 未提供可配置的供应商。</p>}
      </section>}
      {section === 'policy' && <section className="management-group">
        <h4>模型策略</h4>
        <ModelCatalogSelect label="默认模型" providers={modelGroups(snapshot.providers, account.status)} value={snapshot.preferences.defaultRoute}
          empty="使用 Host 默认模型" disabled={busy} onChange={(defaultRoute) =>
            save({ defaultRoute, modelSelection: defaultRoute ? snapshot.preferences.modelSelection : 'automatic' })} />
        <label className="field-label">
          自动选模
          <select value={snapshot.preferences.modelSelection} disabled={busy} onChange={(event) => {
            save({ modelSelection: event.target.value === 'fixed' ? 'fixed' : 'automatic' })
          }}>
            <option value="automatic">按任务和可用模型选择</option>
            <option value="fixed" disabled={!snapshot.preferences.defaultRoute}>固定使用已选默认模型</option>
          </select>
        </label>
        {!snapshot.preferences.defaultRoute && <p className="management-note">选择默认模型后即可使用固定策略。</p>}
      </section>}
      {section === 'account' && <ChatGptManagement account={account} unavailable={snapshot.account.reason} busy={busy} perform={perform} />}
    </div>
  )
}

function ProviderControls({ provider, api, busy, perform }: {
  provider: ManagedProvider
  api: DesktopManagementApi
  busy: boolean
  perform: PerformManagement
}) {
  const [testRoute, setTestRoute] = useState<ModelRoute>()
  const selected = provider.models.some((model) => routeKey(model.route) === routeKey(testRoute)) ? testRoute : undefined
  const credential = provider.credential !== 'missing'
  return (
    <details className="management-detail">
      <summary>
        <strong>{provider.name}</strong>
        <span>{credential ? connectionLabels[provider.connection] : credentialLabels.missing}</span>
      </summary>
      <div className="management-detail-content">
        <p className="management-note">{credentialLabels[provider.credential]}</p>
        {credential && provider.connection === 'untested' && (
          <p className="management-note">当前显示 Pi 支持的模型。测试连接后会核对供应商目录。</p>
        )}
        {!credential && <p className="management-note">先复制此 Provider 的 API Key，再点击添加。</p>}
        {provider.models.length > 0 && (
          <ModelCatalogSelect label="测试模型" providers={[provider]} value={selected}
            onChange={(route) => setTestRoute(route ?? undefined)} empty="使用 Provider 默认模型" disabled={busy} />
        )}
        <div className="management-actions">
          <button type="button" className="button-primary" disabled={busy} onClick={() =>
            perform(() => api.setProviderKey({ provider: provider.id }))}>
            {provider.credential === 'stored' ? '更新 API Key' : '添加 API Key'}
          </button>
          <button type="button" className="button-neutral" disabled={busy || !credential} onClick={() =>
            perform(() => api.testProvider({ provider: provider.id, model: selected?.model }), '连接测试已完成。')}>
            {selected ? '测试模型' : '测试连接'}
          </button>
          {credential && (
            <button type="button" className="button-danger" disabled={busy} onClick={() =>
              perform(() => api.removeProviderKey({ provider: provider.id }))}>
              {provider.credential === 'environment' ? '停用环境凭证' : '删除 API Key'}
            </button>
          )}
        </div>
      </div>
    </details>
  )
}
