import { ArrowUp, CircleHelp, Play, RotateCw, Square } from 'lucide-react'
import { useWorkspace, activeDraft, activeSession } from '../../stores/workspace'
import { isBusy } from '../../integrations/agent/conversationProjection'
import { IconButton } from '../ui/IconButton'
import { Glass } from '../glass/Glass'
export function Composer({ onReconcile }: { onReconcile: () => void }) {
  const session = useWorkspace(activeSession)
  const value = useWorkspace(activeDraft)
  const status = session?.turns.at(-1)?.status ?? session?.latestStatus
  const host = useWorkspace((state) => state.host)
  const error = useWorkspace((state) => state.error)
  const mock = useWorkspace((state) => state.mock)
  const pending = useWorkspace((state) => state.pending)
  const setDraft = useWorkspace((state) => state.setDraft)
  const send = useWorkspace((state) => state.send)
  const cancel = useWorkspace((state) => state.cancel)
  const resume = useWorkspace((state) => state.resume)
  const restart = useWorkspace((state) => state.restart)
  const running = isBusy(status)
  const available = host.state === 'ready' && !pending && (!session || session.loaded)
  const canSend = available && status !== 'stopping' && status !== 'reconciliation' && (!mock || !running)
  const canResume = available && !mock && (status === 'stopped' || status === 'blocked')
  const sendLabel = running ? '追加指令' : '发送消息'
  const label = host.state === 'starting' ? 'Host 启动中' : host.state === 'offline' ? 'Host 已断开'
    : mock ? 'Mock 演示' : host.mode === 'faux' ? 'Pi · Faux' : 'Pi Host 已连接'
  const alert = error ?? (host.state === 'offline' ? host.message : undefined)

  return (
    <footer className="composer-dock">
      <form className="chat-width" onSubmit={(event) => { event.preventDefault(); if (canSend) void send() }}>
        {alert && <p className="composer-error" role="alert">{alert}</p>}
        <Glass className="composer-glass" elevated>
          <textarea
            id="composer-input"
            aria-label="消息"
            placeholder={running ? '追加本轮任务的说明…' : '给 Zlo Agent 发消息…'}
            rows={2}
            maxLength={8000}
            value={value}
            onChange={(event) => setDraft(session?.id ?? null, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault()
                if (canSend) void send()
              }
            }}
          />
          <div className="composer-tools">
            <span className="composer-mode" role="status" data-host-state={host.state}>
              {host.state === 'ready' && <i className="live-dot" />}{label}
            </span>
            {host.state === 'offline' && <IconButton label="重启 Host" onClick={() => void restart()}><RotateCw size={15} /></IconButton>}
            <span className="composer-keys mono"><kbd>↵</kbd> {running ? '追加' : '发送'} <kbd>Shift ↵</kbd> 换行</span>
            {canResume && <IconButton label="恢复执行" className="send-button" onClick={() => void resume()}><Play size={15} /></IconButton>}
            {running && <IconButton label="停止生成" className="send-button" disabled={!available || status === 'stopping'} onClick={() => void cancel()}><Square size={14} fill="currentColor" /></IconButton>}
            <IconButton label={sendLabel} type="submit" className="send-button" disabled={!canSend || !value.trim()}><ArrowUp size={19} strokeWidth={2.3} /></IconButton>
          </div>
        </Glass>
        <div className="composer-footnote">
          <CircleHelp size={12} />
          <span>{mock ? '本地界面演示' : '本地 Host' +
            (session?.check ? (session.check.command ? ' · 命令验收' : ' · 文件验收') : '')}</span>
          {status === 'reconciliation' && globalThis.window?.agentManagement && (
            <button type="button" className="composer-reconcile" onClick={onReconcile}>核对异常操作</button>
          )}
        </div>
      </form>
    </footer>
  )
}
