import { ArrowUp, CircleHelp, Paperclip, Square } from 'lucide-react'
import { useWorkspace, activeDraft, activeSession } from '../../stores/workspace'
import { IconButton } from '../ui/IconButton'
import { Glass } from '../glass/Glass'

export function Composer({ notify }: { notify: (text: string) => void }) {
  const sessionId = useWorkspace((state) => state.activeId)
  const value = useWorkspace(activeDraft)
  const running = useWorkspace((state) => activeSession(state)?.turns.at(-1)?.status === 'running')
  const setDraft = useWorkspace((state) => state.setDraft)
  const send = useWorkspace((state) => state.send)
  const cancel = useWorkspace((state) => state.cancel)

  return (
    <footer className="composer-dock">
      <form className="chat-width" onSubmit={(event) => { event.preventDefault(); send() }}>
        <Glass className="composer-glass" elevated>
          <textarea
            id="composer-input"
            aria-label="消息"
            placeholder={running ? '可先编辑下一条消息…' : '给 Zlo Agent 发消息…'}
            rows={2}
            maxLength={8000}
            value={value}
            onChange={(event) => setDraft(sessionId, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault()
                if (!running) send()
              }
            }}
          />
          <div className="composer-tools">
            <IconButton label="添加附件" className="attach-button" onClick={() => notify('附件暂未接入。你可以粘贴文字到输入框。')}><Paperclip size={17} /></IconButton>
            <span className="composer-divider" />
            <span className="composer-mode"><i className="live-dot" />Mock 演示</span>
            <span className="composer-keys mono"><kbd>↵</kbd> 发送 <kbd>Shift ↵</kbd> 换行</span>
            {running
              ? <IconButton label="停止生成" className="send-button" onClick={cancel}><Square size={14} fill="currentColor" /></IconButton>
              : <IconButton label="发送消息" type="submit" className="send-button" disabled={!value.trim()}><ArrowUp size={19} strokeWidth={2.3} /></IconButton>}
          </div>
        </Glass>
        <div className="composer-footnote"><CircleHelp size={12} /><span>本地演示 · 消息和工具结果均为模拟</span></div>
      </form>
    </footer>
  )
}
