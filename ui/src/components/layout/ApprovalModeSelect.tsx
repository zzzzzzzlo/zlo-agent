import type { ToolApprovalMode } from '../../../../shared/contracts/tool-approval.ts'

const descriptions: Record<ToolApprovalMode, { label: string; detail: string }> = {
  ask: { label: '逐项确认', detail: '公开网页访问、任意 Shell、删除、Git 修改和导出等操作会请求确认。' },
  routine: { label: '按风险确认', detail: '通过检查的公开网页读取直接运行。搜索词、带查询参数的链接和其他需批准的操作交给你确认。' },
  unattended: { label: '无人值守', detail: '通过检查的公开网页读取直接运行。需要确认的操作会被拒绝，Agent 可以换用已授权的工具。' },
}

export function ApprovalModeSelect({ value, onChange, disabled }: {
  value: ToolApprovalMode
  onChange(value: ToolApprovalMode): void
  disabled?: boolean
}) {
  return (
    <div className="approval-mode-field">
      <label className="field-label">
        工具审批模式
        <select value={value} onChange={event => onChange(event.target.value as ToolApprovalMode)} disabled={disabled}>
          {Object.entries(descriptions).map(([id, { label }]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </label>
      <p className="settings-hint">{descriptions[value].detail}</p>
    </div>
  )
}
