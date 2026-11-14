import { useState } from 'react'
import { Box, CircleUserRound, Plus } from 'lucide-react'
import type { ModelRoute } from '../../../../shared/contracts/desktop.ts'
import type { AgentPreferences, DesktopManagementApi, ManagedProvider, ManagementSnapshot } from '../../../../shared/contracts/management.ts'
import { ModelCatalogSelect, modelGroups } from './ModelCatalogSelect'
import { routeKey } from './managementData'
import { ChatGptManagement, useChatGptAccount } from './ChatGptManagement'
import { JevManagement } from './JevManagement'
import { CustomProviderForm, emptyProvider, GrokManagement, useProviderSetup } from './ProviderSetup'
import { customProviderLimit } from '../../../../shared/contracts/provider-setup.ts'
import type { CustomProviderConfig } from '../../../../shared/contracts/provider-setup.ts'

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

const sections = [['providers', '提供商'], ['policy', '默认模型'], ['jev', '判定模型 (Jev)']] as const

export function ModelManagement({ snapshot, api, busy, perform, save }: {
  snapshot: ManagementSnapshot
  api: DesktopManagementApi
  busy: boolean
  perform: PerformManagement
  save(patch: Partial<AgentPreferences>): void
}) {
  const account = useChatGptAccount(true)
  const [section, setSection] = useState<typeof sections[number][0]>('providers')
  return (
    <div className="management-stack">
      <nav className="model-sections" aria-label="模型与账号分类">
        {sections.map(([id, label]) => <button type="button" key={id} aria-current={section === id ? 'page' : undefined}
          onClick={() => setSection(id)}>{label}</button>)}
      </nav>
      {section === 'providers' && <Providers snapshot={snapshot} api={api} account={account} perform={perform} busy={busy} />}
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
      {section === 'jev' && <JevManagement api={api} busy={busy} perform={perform} />}
    </div>
  )
}

function Providers({ snapshot, api, account, busy, perform }: {
  snapshot: ManagementSnapshot
  api: DesktopManagementApi
  account: ReturnType<typeof useChatGptAccount>
  busy: boolean
  perform: PerformManagement
}) {
  const setup = useProviderSetup()
  const [selected, setSelected] = useState('chatgpt')
  const [adding, setAdding] = useState<CustomProviderConfig>()
  const saved = setup.providers.find(provider => selected === 'custom-' + provider.id)
  const builtin = snapshot.providers.find((provider): provider is ManagedProvider =>
    provider.id === selected && ['deepseek', 'openai', 'anthropic', 'google'].includes(provider.id))

  function entry(id: string, name: string, ready: boolean, account?: boolean) {
    const Icon = account ? CircleUserRound : Box
    return <button key={id} type="button" aria-current={selected === id ? 'true' : undefined}
      onClick={() => { if (id !== 'new') setAdding(undefined); setSelected(id) }}>
      <Icon size={15} aria-hidden="true" /><span>{name}</span>
      <i className={ready ? 'is-ready' : ''} title={ready ? '已配置' : '未配置'} aria-hidden="true" />
    </button>
  }

  return (
    <section className="provider-page" aria-label="提供商">
      <div className="provider-page-actions">
        <button className="button-primary" type="button" disabled={!setup.api || busy || setup.providers.length >= customProviderLimit} onClick={() => {
          setAdding(emptyProvider(setup.providers))
          setSelected('new')
        }}><Plus size={15} />添加提供商</button>
      </div>
      {setup.error && <p className="dialog-error" role="alert">{setup.error}</p>}
      <div className="provider-workspace">
        <nav className="provider-directory" aria-label="提供商列表">
          <div><p>订阅登录</p>
            {entry('chatgpt', 'ChatGPT', account.status?.state === 'connected', true)}
            {entry('grok', 'Grok', setup.grok?.state === 'connected', true)}
          </div>
          <div><p>API 提供商</p>
            {snapshot.providers.filter(provider => ['deepseek', 'openai', 'anthropic', 'google'].includes(provider.id))
              .map(provider => entry(provider.id, provider.name, provider.credential !== 'missing'))}
            {setup.providers.map(provider => entry('custom-' + provider.id, provider.name, provider.hasKey))}
            {adding && entry('new', '新提供商', false)}
          </div>
        </nav>
        <div className="provider-detail">
          {selected === 'chatgpt' && <ChatGptManagement account={account} unavailable={snapshot.account.reason} busy={busy} perform={perform} />}
          {selected === 'grok' && <GrokManagement setup={setup} busy={busy} perform={perform} />}
          {builtin && <ProviderControls key={builtin.id} provider={builtin} api={api} busy={busy} perform={perform} />}
          {setup.api && ((selected === 'new' && adding) || saved) && <CustomProviderForm key={selected}
            initial={(saved ?? adding)!} hasKey={saved?.hasKey ?? false} isNew={!saved} busy={busy} api={setup.api} perform={perform}
            onDiscard={() => { setAdding(undefined); setSelected('chatgpt') }}
            onChange={(providers, id) => { setup.setProviders(providers); setAdding(undefined); setSelected(id ? 'custom-' + id : 'chatgpt') }} />}
        </div>
      </div>
    </section>
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
    <section className="provider-builtin">
      <div className="provider-detail-title">
        <h4>{provider.name}</h4>
        <span>{credential ? connectionLabels[provider.connection] : credentialLabels.missing}</span>
      </div>
      <div className="provider-form">
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
    </section>
  )
}
