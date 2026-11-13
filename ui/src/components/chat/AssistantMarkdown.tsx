import { memo } from 'react'
import Markdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const components: Components = {
  table: ({ children }) => <div className="markdown-table" tabIndex={0} role="region" aria-label="回复表格"><table>{children}</table></div>,
  img: ({ alt }) => <span>{alt || '图片'}</span>,
  a: ({ href, children }) => href && window.desktopWindow?.openExternalLink
    ? <a href={href} onClick={event => {
        event.preventDefault()
        void window.desktopWindow?.openExternalLink(href).catch(() => {})
      }}>{children}</a>
    : <span>{children}</span>,
}

export const AssistantMarkdown = memo(function AssistantMarkdown({ text, streaming }: { text: string; streaming: boolean }) {
  return <div className={`message-markdown${streaming ? ' is-streaming' : ''}`}>
    <Markdown skipHtml remarkPlugins={[remarkGfm]} components={components}
      urlTransform={(url, key) => key === 'href' && /^https?:\/\//iu.test(url) ? url : undefined}>{text}</Markdown>
  </div>
})
