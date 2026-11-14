import { Activity, Brain, Check, CircleHelp, KeyRound, Moon, Palette, ShieldCheck, Sun, Workflow, Wrench } from 'lucide-react'
import { version } from '../../../package.json'
import { useWorkspace } from '../../stores/workspace'
import { managementLabels } from './ManagementSections'
import type { ManagementSection } from './ManagementSections'

const themes = [
  { id: 'dark', label: '深色', icon: Moon },
  { id: 'light', label: '浅色', icon: Sun },
] as const

export type SettingsSection = ManagementSection | 'appearance' | 'about'

export const settingsGroups = [
  { label: '连接', entries: [['models', KeyRound]] },
  { label: '工作区', entries: [['permissions', ShieldCheck], ['tasks', Workflow], ['tools', Wrench], ['memory', Brain], ['diagnostics', Activity]] },
  { label: '应用', entries: [['appearance', Palette], ['about', CircleHelp]] },
] as const

export const settingsLabels = { ...managementLabels, appearance: '外观', about: '关于' }

export function SettingsPreferences({ section }: { section: 'appearance' | 'about' }) {
  const theme = useWorkspace((state) => state.theme)
  const setTheme = useWorkspace((state) => state.setTheme)
  const mock = useWorkspace((state) => state.mock)

  return section === 'appearance' ? (
    <section className="settings-content settings-preferences">
      <h1 tabIndex={-1}>外观</h1>
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
    </section>
  ) : (
    <section className="settings-content settings-preferences settings-about">
      <h1 tabIndex={-1}>关于</h1>
      <h3>Zlo Agent <span className="mono">v{version}</span></h3>
      <p>{mock ? '个人 AI Agent 桌面工作区。当前启用了界面演示。' : '个人 AI Agent 桌面工作区。会话和执行记录由本地 Agent Host 保存。'}</p>
      <dl>
        <div><dt>新建会话</dt><dd><kbd>Ctrl N</kbd></dd></div>
        <div><dt>打开设置</dt><dd><kbd>Ctrl ,</kbd></dd></div>
        <div><dt>发送消息</dt><dd><kbd>Enter</kbd></dd></div>
        <div><dt>换行</dt><dd><kbd>Shift Enter</kbd></dd></div>
      </dl>
    </section>
  )
}
