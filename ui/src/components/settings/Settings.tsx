import { Check, CircleHelp, Moon, Palette, Sun } from 'lucide-react'
import { useState } from 'react'
import { version } from '../../../package.json'
import { useWorkspace } from '../../stores/workspace'
import { Modal } from '../ui/Modal'

const themes = [
  { id: 'dark', label: '深色', icon: Moon },
  { id: 'light', label: '浅色', icon: Sun },
] as const

type SettingsSection = 'appearance' | 'about'

const sections = [
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'about', label: '关于', icon: CircleHelp },
] as const

export function Settings({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<SettingsSection>('appearance')
  const theme = useWorkspace((state) => state.theme)
  const setTheme = useWorkspace((state) => state.setTheme)
  const mock = useWorkspace((state) => state.mock)

  return (
    <Modal title="设置" className="settings-modal" onClose={onClose}>
      <div className="settings-grid">
        <nav className="settings-nav" aria-label="设置分类">
          {sections.map(({ id, label, icon: Icon }) => (
            <button type="button" key={id} aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}>
              <Icon size={15} />{label}
            </button>
          ))}
        </nav>
        {section === 'appearance' ? (
          <section className="settings-content">
            <h3>外观</h3>
            <fieldset>
              <legend>颜色主题</legend>
              <div className="theme-options">
                {themes.map(({ id, label, icon: Icon }) => (
                  <label className="theme-option" key={id}>
                    <input type="radio" name="theme" checked={theme === id} onChange={() => setTheme(id)} />
                    <span className={`theme-preview preview-${id}`}><i /><i /><i /></span>
                    <span className="theme-option-label"><Icon size={14} />{label}{theme === id && <Check size={14} className="option-check" />}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <p className="settings-hint">界面使用统一的温暖中性色与细边框，不随设备图形能力改变材质。</p>
          </section>
        ) : (
          <section className="settings-content settings-about">
            <h3>Zlo Agent <span className="mono">v{version}</span></h3>
            <p>{mock ? '个人 AI Agent 桌面工作区。当前启用了界面演示。' : '个人 AI Agent 桌面工作区。会话和执行记录由本地 Agent Host 保存。'}</p>
            <dl>
              <div><dt>新建会话</dt><dd><kbd>Ctrl N</kbd></dd></div>
              <div><dt>打开设置</dt><dd><kbd>Ctrl ,</kbd></dd></div>
              <div><dt>发送消息</dt><dd><kbd>Enter</kbd></dd></div>
              <div><dt>换行</dt><dd><kbd>Shift Enter</kbd></dd></div>
            </dl>
          </section>
        )}
      </div>
    </Modal>
  )
}
