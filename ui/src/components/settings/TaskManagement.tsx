import { useState } from 'react'
import type { TaskStatus } from '../../../../shared/contracts/desktop.ts'
import type { DesktopManagementApi, ManagedOperation, ManagedTask, ManagementSnapshot } from '../../../../shared/contracts/management.ts'
import { workspaceAccessLabels } from '../../features/sessions/model'
import { verificationExplanation, verificationLabel } from '../../features/sessions/verification'
import { routeDisplayLabel } from './managementData'
import type { PerformManagement } from './ModelManagement'

const roles = { root: 'Root', team: 'Team', worker: 'Worker' }
const statuses: Record<TaskStatus, string> = {
  ready: '排队中',
  running: '运行中',
  verifying: '验收中',
  succeeded: '执行完成',
  failed: '失败',
  blocked: '已阻塞',
  stop_requested: '正在请求停止',
  stopping: '停止中',
  stopped: '已停止',
  needs_reconciliation: '待人工核对',
}
const nodeStates: Record<string, string> = {
  ...statuses, active: '运行中', completed: '执行完成', pending: '等待依赖',
  interrupted: '已中断', waiting: '等待中', skipped: '已跳过', planned: '已计划',
}
const operations: Record<string, string> = {
  started: '已开始', succeeded: '执行完成', confirmed: '已确认', failed: '失败', interrupted: '已中断',
  unknown: '结果未知', unknown_effect: '结果未知',
}
const probeLabels: Record<string, string> = {
  isolated_worktree_requires_manual_review: '此操作发生在独立工作树，需要人工检查。',
  git_status_observed_without_expected_revision: '已读取 Git 状态，缺少原操作的预期版本。',
  git_status_unavailable: '无法读取 Git 状态。',
  original_process_identity_not_available: '已无法确认原进程身份与执行结果。',
  recorded_pid_exists_identity_unconfirmed: '记录的进程号仍存在，无法确认是否为原进程。',
  recorded_pid_absent_effect_unconfirmed: '记录的进程号已不存在，执行效果仍无法确认。',
  recorded_pid_status_unavailable: '系统无法确认记录的进程状态。',
  no_read_only_probe_available: '此操作暂无可用的只读核对方式。',
  workspace_identity_changed: '工作区身份已变化。',
  file_observed_without_expected_digest: '已读取文件，缺少原操作的预期内容记录。',
  file_content_differs: '文件内容与原操作的预期记录不符。',
  file_content_matches_recorded_postcondition: '当前文件内容与操作前保存的预期摘要一致。',
  file_missing_or_unreadable: '未找到文件或无法读取。',
}

export function TaskManagement({ snapshot, busy, perform }: {
  snapshot: ManagementSnapshot
  busy: boolean
  perform: PerformManagement
}) {
  const [selected, setSelected] = useState<string>()
  const conversation = snapshot.conversation
  const latest = conversation?.latestTaskId
  const task = snapshot.tasks.find((entry) => entry.taskId === selected)
    ?? snapshot.tasks.find((entry) => entry.taskId === latest)
    ?? snapshot.tasks[0]
  if (!conversation) return <p className="management-note">请选择一个会话。</p>
  if (!task) return <p className="management-note">此会话暂无任务。</p>
  const running = task.status === 'ready' || task.status === 'running' || task.status === 'verifying'
  const resumable = task.status === 'stopped' || task.status === 'blocked'
  const control = globalThis.window?.agentHost
  const taskLabels = new Map(task.nodes.map((node) => [node.id, node.goal || roles[node.role]]))
  const agentLabels = new Map(task.agents.map((agent) => [agent.id, taskLabels.get(agent.nodeId) ?? roles[agent.role]]))
  const agentsById = new Map(task.agents.map((agent) => [agent.id, agent]))

  function indent(agent: ManagedTask['agents'][number]) {
    let parent = agent.parentId
    let depth = 0
    while (parent && depth < 4) {
      depth++
      parent = agentsById.get(parent)?.parentId
    }
    return depth * 12
  }

  function command(action: 'stopConversation' | 'resumeConversation') {
    if (!control || !conversation || !task) return
    perform(async () => {
      const result = await control[action]({
        conversationId: conversation.id, taskId: task.taskId, requestId: crypto.randomUUID(),
      })
      if (!result.accepted) throw new Error('任务状态已更新，请刷新后重试。')
    })
  }

  return (
    <div className="management-stack">
      <section className="management-group">
        <label className="field-label">
          任务历史
          <select value={task.taskId} onChange={(event) => setSelected(event.target.value)}>
            {snapshot.tasks.map((entry) => (
              <option key={entry.taskId} value={entry.taskId}>
                {entry.nodes.find((node) => node.id === entry.rootNodeId)?.goal.slice(0, 70) || entry.taskId}
                {' · '}{statuses[entry.status]}
              </option>
            ))}
          </select>
        </label>
        <p className="management-note">{statuses[task.status]}{task.verification && ' · ' + verificationLabel(task.verification)}</p>
        {task.verification && verificationExplanation(task.verification) && <p className="management-note">{verificationExplanation(task.verification)}</p>}
        {task.taskId === latest && control && (running || resumable) && (
          <div className="management-actions">
            {running && <button type="button" className="button-neutral" disabled={busy} onClick={() => command('stopConversation')}>停止任务</button>}
            {resumable && <button type="button" className="button-primary" disabled={busy} onClick={() => command('resumeConversation')}>恢复任务</button>}
          </div>
        )}
        {task.status === 'needs_reconciliation' && <p className="management-note">请在「用量与诊断」中检查相关操作。</p>}
      </section>
      <section className="management-group">
        <h4>任务 DAG</h4>
        {!task.nodes.length && <p className="management-note">此任务暂无节点记录。</p>}
        {task.nodes.map((node) => (
          <details key={node.id} className="management-detail">
            <summary><strong>{roles[node.role]} · {node.goal || '任务节点'}</strong><span>{nodeStates[node.status] ?? node.status}</span></summary>
            <div className="management-detail-content">
              <dl className="management-metadata">
                {node.parentNodeId && <div><dt>父节点</dt><dd>{taskLabels.get(node.parentNodeId) ?? node.parentNodeId}</dd></div>}
                <div><dt>依赖</dt><dd>{node.dependencies.map((id) => taskLabels.get(id) ?? id).join('、') || '无'}</dd></div>
                <div><dt>有效权限</dt><dd>{workspaceAccessLabels[node.access]}</dd></div>
                {node.scopePath && <div><dt>范围</dt><dd>{node.scopePath}</dd></div>}
                {node.route && <div><dt>模型</dt><dd>{routeDisplayLabel(node.route)}</dd></div>}
                {node.verification && <div><dt>验收</dt><dd>{verificationLabel(node.verification)}</dd></div>}
                {node.tools?.length ? <div><dt>工具调用</dt><dd>{node.tools.join('、')}</dd></div> : null}
                {node.result && <div><dt>交付</dt><dd>{node.result}</dd></div>}
              </dl>
              {task.operations.filter((operation) => operation.status !== 'approval_only' &&
                (operation.nodeId ?? task.rootNodeId) === node.id).map((operation) => (
                  <div className="management-row" key={operation.id}>
                    <div><strong>{operation.tool}</strong>{operation.target && <small>{operation.target}</small>}</div>
                    <span>{operations[operation.status] ?? operation.status}</span>
                  </div>
                ))}
            </div>
          </details>
        ))}
      </section>
      <section className="management-group">
        <h4>Agent Tree</h4>
        {!task.agents.length && <p className="management-note">此任务暂无 Agent 运行记录。</p>}
        {task.agents.map((agent) => (
          <div className="management-row" key={agent.id} style={{ marginInlineStart: indent(agent) }}>
            <div>
              <strong>{roles[agent.role]} · {taskLabels.get(agent.nodeId) ?? agent.nodeId}</strong>
              <small>{agent.parentId ? '上级 · ' + (agentLabels.get(agent.parentId) ?? agent.parentId) : '根 Agent'}</small>
              {agent.route && <small>{routeDisplayLabel(agent.route)}</small>}
            </div>
            <span>{nodeStates[agent.status] ?? agent.status}</span>
          </div>
        ))}
      </section>
    </div>
  )
}

export function approvalRows(tasks: ManagedTask[]) {
  return tasks.flatMap((task) => task.operations.filter((item) => item.approval)
    .map((item) => ({ ...item, taskId: task.taskId })))
}

export function OperationReview({ snapshot, busy, api, perform }: {
  snapshot: ManagementSnapshot
  busy: boolean
  api: DesktopManagementApi
  perform: PerformManagement
}) {
  const [results, setResults] = useState<Record<string, ManagedOperation>>({})
  const conversationId = snapshot.conversation?.id
  const pending = snapshot.tasks.flatMap((task) => task.operations
    .filter((operation) => operation.reconciliation || ['unknown', 'unknown_effect', 'needs_reconciliation'].includes(operation.status))
    .map((operation) => ({ taskId: task.taskId, operation })))
  const blocked = snapshot.tasks.filter(task => task.status === 'needs_reconciliation' &&
    !pending.some(item => item.taskId === task.taskId && item.operation.status === 'unknown_effect'))
  return (
    <section className="management-group">
      <h4>异常核对</h4>
      {!pending.length && !blocked.length && <p className="management-note">{conversationId ? '此会话暂无待核对的操作。' : '请选择一个会话查看异常操作。'}</p>}
      {blocked.map(task => <p key={task.taskId} className="management-note">
        任务 {task.taskId.slice(0, 8)} 仍需人工核对。{task.reason === 'checkpoint_error' ? '会话检查点不可用。'
          : task.reason === 'stop_timeout' ? '先前的停止操作超时。' : '缺少可自动核对的回执。'}
      </p>)}
      {pending.map(({ taskId, operation }) => {
        const key = taskId + '/' + operation.id
        const result = operation.reconciliation?.status === 'verified' ? operation : results[key] ?? operation
        const verified = result.reconciliation?.status === 'verified'
        return (
          <div className="management-row" key={key}>
            <div>
              <strong>{operation.tool}</strong>
              {operation.target && <small>{operation.target}</small>}
              <small>{verified ? '状态核对通过' : (operations[operation.status] ?? operation.status)}</small>
              {result.reconciliation && <small>{probeLabels[result.reconciliation.evidence] ?? result.reconciliation.evidence}</small>}
              {result.reconciliation?.changedEntries !== undefined && (
                <small>Git 变更 {result.reconciliation.changedEntries} 项{result.reconciliation.truncated && '（输出已截断）'}</small>
              )}
            </div>
            <button type="button" className="button-neutral" disabled={busy || !conversationId || verified} onClick={() => {
              if (!conversationId) return
              perform(async () => {
                const checked = await api.reconcile({ conversationId, taskId, operationId: operation.id })
                setResults((previous) => ({ ...previous, [key]: checked }))
              })
            }}>核对实际状态</button>
          </div>
        )
      })}
    </section>
  )
}
