import { memo, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, CircleAlert } from 'lucide-react'
import { useWorkspace, activeSession } from '../../stores/workspace'
import type { Turn } from '../../features/sessions/model'
import { isBusy } from '../../integrations/agent/conversationProjection'
import { BrandMark } from '../ui/BrandMark'
import { IconButton } from '../ui/IconButton'
import { RunBadge, ToolCard } from './ToolCard'
import { Welcome } from './Welcome'

export function ChatSurface() {
  const session = useWorkspace(activeSession)
  const id = session?.id ?? null
  const turns = session?.turns
  const setDraft = useWorkspace((state) => state.setDraft)
  const loadOlder = useWorkspace((state) => state.loadOlder)
  const pending = useWorkspace((state) => state.pending)
  const mock = useWorkspace((state) => state.mock)
  const viewport = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const olderAnchor = useRef<{ height: number; top: number } | undefined>(undefined)
  const [atEnd, setAtEnd] = useState(true)

  function scrollToEnd() {
    const element = viewport.current
    if (element) element.scrollTop = element.scrollHeight
    following.current = true
    setAtEnd(true)
  }

  useLayoutEffect(() => {
    olderAnchor.current = undefined
    scrollToEnd()
  }, [id])
  useLayoutEffect(() => {
    const anchor = olderAnchor.current
    if (anchor && viewport.current) {
      viewport.current.scrollTop = anchor.top + viewport.current.scrollHeight - anchor.height
      olderAnchor.current = undefined
    } else if (following.current) scrollToEnd()
  }, [turns])

  function older() {
    if (!viewport.current) return
    olderAnchor.current = { height: viewport.current.scrollHeight, top: viewport.current.scrollTop }
    void loadOlder().then((loaded) => { if (!loaded) olderAnchor.current = undefined })
  }

  if (session && !session.loaded && !turns?.length) {
    return <div className="welcome-viewport"><p className="waiting chat-width" role="status">正在加载会话历史…</p></div>
  }

  if (!turns?.length) return (
    <div className="welcome-viewport">
      <Welcome mock={mock} onPrompt={(prompt) => {
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
          <div className="thread-marker"><span />{mock ? '本地演示会话' : '本地会话'}<span /></div>
          {session?.nextBefore !== undefined && <button className="load-older button-neutral" disabled={pending} onClick={older}>加载较早消息</button>}
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
      {turn.instructions?.map((instruction) => (
        <div className="user-message" key={instruction.id}>
          <div className="user-bubble"><small className="instruction-label">追加指令</small>{instruction.text}</div>
        </div>
      ))}
      <div className="assistant-message">
        <header className="assistant-header">
          <span className="assistant-mark"><BrandMark size={19} /></span>
          <strong>Zlo Agent</strong>
          <span className="turn-status" role="status"><RunBadge status={turn.status} /></span>
        </header>
        <div className="assistant-body">
          {turn.tools.map((tool) => <ToolCard key={tool.id} tool={tool} />)}
          {turn.response && <p className={`message-text ${turn.status === 'running' ? 'is-streaming' : ''}`}>{turn.response}</p>}
          {isBusy(turn.status) && !turn.response && <div className="waiting">
            {turn.status === 'queued' ? '等待执行' : turn.status === 'verifying' ? '正在验收' : turn.status === 'stopping' ? '正在停止' : '正在准备回复'}<span>…</span>
          </div>}
          {(turn.status === 'cancelled' || turn.status === 'stopped') && <p className="cancel-note">已停止，已生成内容会保留。</p>}
          {turn.verification && <p className="verification-note">验收{turn.verification.passed ? '通过' : '未通过'}</p>}
          {turn.error && <div className="error-note" role="alert"><CircleAlert size={16} />{turn.error}</div>}
        </div>
      </div>
    </article>
  )
})
