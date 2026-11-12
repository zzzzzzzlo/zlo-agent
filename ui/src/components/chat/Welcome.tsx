import { ArrowRight, Boxes, FileCode2, FileText, FlaskConical } from 'lucide-react'
import { BrandMark } from '../ui/BrandMark'

const demoExamples = [
  { icon: FileText, title: '梳理一项任务', description: '把想法拆成可以执行的步骤', prompt: '帮我把个人项目拆成几个可以执行的步骤。' },
  { icon: Boxes, title: '预览工具执行', description: '查看工具调用的状态变化', prompt: '演示一次工具调用和状态变化。' },
  { icon: FlaskConical, title: '体验错误状态', description: '了解失败与恢复如何呈现', prompt: '演示错误状态' },
]

const examples = [
  demoExamples[0],
  { icon: Boxes, title: '了解工作区', description: '查看目录并梳理项目文件', prompt: '请列出工作区文件，并概述它们的用途。' },
  { icon: FileCode2, title: '构思登录页面', description: '准备实现结构与验收步骤', prompt: '帮我设计一个简单登录页面的结构与验收步骤。' },
]

export function Welcome({ onPrompt, mock }: { onPrompt: (text: string) => void; mock: boolean }) {
  return (
    <div className="welcome">
      <div className="welcome-copy">
        <span className="welcome-symbol"><BrandMark size={32} /></span>
        <div className="eyebrow"><i className="live-dot" />本地个人工作区</div>
        <h1>今天想完成什么？</h1>
        <p>描述一个目标，从对话、代码到验证，过程都清晰可见。</p>
      </div>
      <div className="examples">
        <div className="examples-caption"><span>从一个示例开始</span><span>{mock ? '演示模式' : '本地运行'}</span></div>
        <div className="example-grid">
          {(mock ? demoExamples : examples).map(({ icon: Icon, title, description, prompt }) => (
            <button key={title} className="example" onClick={() => onPrompt(prompt)}>
              <span className="example-icon"><Icon size={17} strokeWidth={1.7} /></span>
              <span className="example-copy"><strong>{title}</strong><small>{description}</small></span>
              <ArrowRight className="example-arrow" size={15} />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
