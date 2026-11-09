import { memo, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, CircleAlert } from 'lucide-react'
import { useWorkspace, activeSession } from '../../stores/workspace'
import type { Turn } from '../../features/sessions/model'
import { BrandMark } from '../ui/BrandMark'
import { IconButton } from '../ui/IconButton'
import { RunBadge, ToolCard } from './ToolCard'
import { Welcome } from './Welcome'

export function ChatSurface() {
  const session = useWorkspace(activeSession)
  const id = session?.id ?? null
  const turns = session?.turns
  const setDraft = useWorkspace((state) => state.setDraft)
  const viewport = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const [atEnd, setAtEnd] = useState(true)

  function scrollToEnd() {
    const element = viewport.current
    if (element) element.scrollTop = element.scrollHeight
    following.current = true
    setAtEnd(true)
  }

  useLayoutEffect(scrollToEnd, [id, turns?.length])
  useLayoutEffect(() => { if (following.current) scrollToEnd() }, [turns])

  if (!turns?.length) return (
    <div className="welcome-viewport">
      <Welcome onPrompt={(prompt) => {
        setDraft(id, prompt)
        document.getElementById('composer-input')?.focus()
      }} />
    </div>
  )

  return (
    <div className="transcript-shell">
      <div className="transcript" ref={viewport} tabIndex={0} aria-label="聊天记录" onScroll={(event) => {
        const { scrollHeight, scrollTop, clientHeight } = event.currentTarget
        following.current = scrollHeight - scrollTop - clientHeight < 64
        setAtEnd(following.current)
      }}>
        <div className="chat-width messages">
          <div className="thread-marker"><span />本地演示会话<span /></div>
          {turns.map((turn) => <TurnView key={turn.id} turn={turn} />)}
        </div>
      </div>
      {!atEnd && <IconButton label="跳到最新消息" className="jump-button" onClick={scrollToEnd}><ArrowDown size={16} /></IconButton>}
    </div>
  )
}

const TurnView = memo(function TurnView({ turn }: { turn: Turn }) {
  return (
    <article className="turn">
      <div className="user-message"><div className="user-bubble">{turn.prompt}</div></div>
      <div className="assistant-message">
        <header className="assistant-header">
          <span className="assistant-mark"><BrandMark size={19} /></span>
          <strong>Zlo Agent</strong><span className="tool-mock mono">MOCK</span>
          <span className="turn-status" role="status"><RunBadge status={turn.status} /></span>
        </header>
        <div className="assistant-body">
          {turn.tools.map((tool) => <ToolCard key={tool.id} tool={tool} />)}
          {turn.response && <p className={`message-text ${turn.status === 'running' ? 'is-streaming' : ''}`}>{turn.response}</p>}
          {turn.status === 'running' && !turn.response && <div className="waiting">正在准备模拟回复<span>…</span></div>}
          {turn.status === 'cancelled' && <p className="cancel-note">已停止生成。</p>}
          {turn.error && <div className="error-note" role="alert"><CircleAlert size={16} />{turn.error}</div>}
        </div>
      </div>
    </article>
  )
})
