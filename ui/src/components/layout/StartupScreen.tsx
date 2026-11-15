import { AlertCircle, RotateCw } from 'lucide-react'
import { useWorkspace } from '../../stores/workspace'
import { BrandMark } from '../ui/BrandMark'

export function StartupScreen() {
  const host = useWorkspace(state => state.host)
  const error = useWorkspace(state => state.error)
  const restart = useWorkspace(state => state.restart)
  const failed = host.state === 'offline'
  return (
    <main className="startup-screen" aria-label="Zlo Agent 启动">
      <div className="startup-content">
        <div className={'startup-mark' + (failed ? ' startup-mark-failed' : '')}>
          {failed ? <AlertCircle size={32} aria-hidden="true" /> : <BrandMark size={38} />}
        </div>
        <h1>{failed ? '工作区连接失败' : '正在启动 Zlo Agent'}</h1>
        {failed ? <>
          <p role="alert">{host.message ?? error ?? '无法连接本地执行服务。'}</p>
          <button type="button" className="button-neutral startup-retry" onClick={() => void restart()}><RotateCw size={14} />重新连接</button>
        </> : <div className="startup-progress" role="progressbar" aria-label="正在连接本地执行服务"><span /></div>}
      </div>
    </main>
  )
}
