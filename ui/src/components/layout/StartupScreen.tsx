import { CircleAlert, RotateCw } from 'lucide-react'
import { BrandMark } from '../ui/BrandMark'
import { useWorkspace } from '../../stores/workspace'

export function StartupScreen() {
  const host = useWorkspace((state) => state.host)
  const restart = useWorkspace((state) => state.restart)
  const offline = host.state === 'offline'

  return (
    <div className="startup-screen">
      <div className="startup-content">
        <span className={`startup-mark ${offline ? 'startup-mark-failed' : ''}`}>
          {offline ? <CircleAlert size={28} /> : <BrandMark size={30} />}
        </span>
        <h1>{offline ? '连接失败' : '正在启动'}</h1>
        <p>{host.message ?? (offline ? '无法连接到 Agent Host。' : '正在连接到本地 Agent Host…')}</p>
        {offline
          ? <button type="button" className="startup-retry" onClick={() => void restart()}><RotateCw size={14} />重试连接</button>
          : <div className="startup-progress"><span /></div>}
      </div>
    </div>
  )
}
