import { useLayoutEffect, useRef } from 'react'
import { ArrowLeft } from 'lucide-react'
import { ManagementSections } from '../settings/ManagementSections'
import { settingsGroups, settingsLabels, SettingsPreferences } from '../settings/Settings'
import type { SettingsSection } from '../settings/Settings'

export function ManagementPage({ section, onBack, onSelect }: {
  section: SettingsSection; onBack(): void; onSelect(section: SettingsSection): void
}) {
  const page = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    page.current?.scrollTo(0, 0)
    page.current?.querySelector('h1')?.focus({ preventScroll: true })
  }, [section])
  return (
    <>
      <aside className="settings-sidebar" aria-label="设置">
        <strong className="settings-sidebar-title">设置</strong>
        <nav className="settings-nav" aria-label="设置分类">
          {settingsGroups.map(({ label, entries }) => (
            <div className="settings-nav-group" key={label}>
              <p>{label}</p>
              {entries.map(([id, Icon]) => (
                <button type="button" key={id} aria-current={section === id ? 'page' : undefined} onClick={() => onSelect(id)}>
                  <Icon size={16} aria-hidden="true" />{settingsLabels[id]}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="settings-sidebar-footer">
          <button type="button" className="page-back" onClick={onBack}><ArrowLeft size={15} />返回对话</button>
        </div>
      </aside>
      <main className="management-page" aria-label={settingsLabels[section]} ref={page}>
        <div className="management-page-inner">
          {section === 'appearance' || section === 'about'
            ? <SettingsPreferences section={section} />
            : <ManagementSections key={section} section={section} />}
        </div>
      </main>
    </>
  )
}
