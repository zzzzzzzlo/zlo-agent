import type { ModelRoute } from '../../../../shared/contracts/desktop.ts'
import type { ManagedProvider } from '../../../../shared/contracts/management.ts'
import type { ChatGptStatus } from '../../../../shared/contracts/chatgpt.ts'
import { routeDisplayLabel, routeKey } from './managementData'

type ModelGroup = Omit<Pick<ManagedProvider, 'id' | 'name' | 'connection' | 'models'>, 'id'> & { id: string }

export function modelGroups(providers: ManagedProvider[], account?: ChatGptStatus): ModelGroup[] {
  const id = account?.models[0]?.route.provider
  return account?.state === 'connected' && id
    ? [...providers, { id, name: 'ChatGPT 账号', connection: 'connected', models: account.models }]
    : providers
}

export function ModelCatalogSelect({
  label, providers, value, onChange, provider, empty, disabled,
}: {
  label: string
  providers: ModelGroup[]
  value?: ModelRoute | null
  onChange(route: ModelRoute | null): void
  provider?: string
  empty: string
  disabled?: boolean
}) {
  const options = providers.filter((entry) =>
    (!provider || provider === entry.id) && entry.connection !== 'unauthorized' && entry.models.length > 0,
  )
  const current = routeKey(value)
  const present = options.some((entry) => entry.models.some((model) => routeKey(model.route) === current))

  return (
    <label className="field-label">
      {label}
      <select aria-label={label} value={current} disabled={disabled} onChange={(event) => {
        const selected = options.flatMap((entry) => entry.models)
          .find((model) => routeKey(model.route) === event.target.value)
        onChange(selected?.route ?? null)
      }}>
        <option value="">{empty}</option>
        {value && !present && <option value={current} disabled>{routeDisplayLabel(value)}（当前配置）</option>}
        {options.map((entry) => (
          <optgroup key={entry.id} label={entry.name}>
            {entry.models.map(({ route, name }) => <option key={routeKey(route)} value={routeKey(route)}>{name}</option>)}
          </optgroup>
        ))}
      </select>
    </label>
  )
}
