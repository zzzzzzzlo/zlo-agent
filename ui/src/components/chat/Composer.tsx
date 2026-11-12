import { ArrowUp, Play, RotateCw, Square } from 'lucide-react'
import { useWorkspace, activeDraft, activeSession } from '../../stores/workspace'
import { isBusy } from '../../integrations/agent/conversationProjection'
import { IconButton } from '../ui/IconButton'

export function Composer() {
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
  const alert = error ?? (host.state === 'offline' ? host.message : undefined)

  return (
    <footer className="composer-dock">
      <form className="chat-width" onSubmit={(event) => { event.preventDefault(); if (canSend) void send() }}>
        {alert && <p className="composer-error" role="alert">{alert}</p>}
        <div className="composer-box">
          <textarea
            id="composer-input"
            aria-label="消息"
            placeholder={running ? '追加本轮任务的说明…' : '描述你想完成的任务…'}
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
            <span className="composer-context">{running ? '正在执行，可追加说明' : session ? '继续当前会话' : '开始一个新任务'}</span>
            {host.state === 'offline' && <IconButton label="重启 Host" onClick={() => void restart()}><RotateCw size={15} /></IconButton>}
            <span className="composer-keys"><kbd>Enter</kbd> {running ? '追加' : '发送'}<kbd>Shift Enter</kbd> 换行</span>
            {canResume && <IconButton label="恢复执行" className="send-button" onClick={() => void resume()}><Play size={15} /></IconButton>}
            {running && <IconButton label="停止生成" className="send-button stop-button" disabled={!available || status === 'stopping'} onClick={() => void cancel()}><Square size={13} fill="currentColor" /></IconButton>}
            <IconButton label={sendLabel} type="submit" className="send-button" disabled={!canSend || !value.trim()}><ArrowUp size={18} strokeWidth={2.2} /></IconButton>
          </div>
        </div>
      </form>
    </footer>
  )
}
