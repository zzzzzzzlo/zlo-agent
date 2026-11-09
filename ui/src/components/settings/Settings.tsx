import { Check, CircleHelp, Moon, Palette, Sun } from 'lucide-react'
import { useState } from 'react'
import type { GlassStrength } from '../../features/appearance/preferences'
import { useWorkspace } from '../../stores/workspace'
import { Modal } from '../ui/Modal'

const themes = [
  { id: 'dark', label: '深色', icon: Moon },
  { id: 'light', label: '浅色', icon: Sun },
] as const

const strengths: { id: GlassStrength; label: string; description: string }[] = [
  { id: 'soft', label: '柔和', description: '桌面更淡，磨砂边缘' },
  { id: 'balanced', label: '均衡', description: '适度透出桌面' },
  { id: 'vivid', label: '通透', description: '桌面更清晰，折射更强' },
]

export function Settings({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<'appearance' | 'about'>('appearance')
  const theme = useWorkspace((state) => state.theme)
  const strength = useWorkspace((state) => state.strength)
  const setTheme = useWorkspace((state) => state.setTheme)
  const setStrength = useWorkspace((state) => state.setStrength)
  const mock = useWorkspace((state) => state.mock)

  return (
    <Modal title="设置" subtitle="工作区偏好" className="settings-modal" onClose={onClose}>
      <div className="settings-grid">
        <nav className="settings-nav" aria-label="设置分类">
          <button aria-current={section === 'appearance' ? 'page' : undefined} onClick={() => setSection('appearance')}><Palette size={15} />外观</button>
          <button aria-current={section === 'about' ? 'page' : undefined} onClick={() => setSection('about')}><CircleHelp size={15} />关于</button>
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
            <fieldset>
              <legend>玻璃强度</legend>
              <div className="strength-options">
                {strengths.map(({ id, label, description }) => (
                  <label key={id} className="strength-option">
                    <input type="radio" name="strength" checked={strength === id} onChange={() => setStrength(id)} />
                    <strong>{label}</strong><small>{description}</small>
                  </label>
                ))}
              </div>
              <p className="settings-hint">设备不支持折射时，自动使用磨砂效果。</p>
            </fieldset>
          </section>
        ) : (
          <section className="settings-content settings-about">
            <h3>Zlo Agent <span className="mono">v0.1.0</span></h3>
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
