import { ArrowUpRight, Boxes, FileText, FlaskConical } from 'lucide-react'
import { Glass } from '../glass/Glass'
import { BrandMark } from '../ui/BrandMark'

const examples = [
  { icon: FileText, title: '梳理一项任务', description: '把想法拆成行动步骤', prompt: '帮我把个人项目拆成几个可以执行的步骤。' },
  { icon: Boxes, title: '预览工具执行', description: '查看工具状态变化', prompt: '演示一次工具调用和状态变化。' },
  { icon: FlaskConical, title: '体验错误状态', description: '看看失败如何显示', prompt: '演示错误状态' },
]

export function Welcome({ onPrompt }: { onPrompt: (text: string) => void }) {
  return (
    <div className="welcome">
      <div className="welcome-orbit">
        <Glass variant="dock" className="orbit-tile" contentClassName="orbit-mark"><BrandMark size={57} /></Glass>
      </div>
      <div className="welcome-copy">
        <div className="eyebrow"><i className="live-dot" />个人工作区</div>
        <h1>今天想做什么？</h1>
        <p>从一个想法、一项任务，或一段对话开始。</p>
      </div>
      <div className="examples">
        <div className="examples-caption"><span>试试这些示例</span><span className="mono">QUICK START</span></div>
        <div className="example-grid">
          {examples.map(({ icon: Icon, title, description, prompt }) => (
            <button key={title} className="example" onClick={() => onPrompt(prompt)}>
              <span className="example-icon"><Icon size={17} strokeWidth={1.65} /></span>
              <ArrowUpRight className="example-arrow" size={14} />
              <strong>{title}</strong>
              <small>{description}</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
