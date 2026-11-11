import {
  badge, el, empty, facts, formatCurrency, formatDuration, formatNumber, formatTime, link, panel, roleLabel, shortId, table,
} from './components.js'

const axes = { completion: '任务完成度', correctness: '结果正确性', quality: '交付质量' }
const activeJobs = new Set(['queued', 'running'])
const finishedTasks = new Set(['succeeded', 'failed', 'blocked', 'stopped', 'needs_reconciliation'])
const finishedNodes = new Set(['succeeded', 'failed'])

function option(value, label, selected = false) {
  return el('option', { text: label, attrs: { value, selected: selected ? '' : null } })
}

function configureNodes(select, task, desiredNode) {
  const choices = (task?.nodes ?? []).filter(node => node.id !== task.rootNodeId && finishedNodes.has(node.status))
  const wholeTask = !task || finishedTasks.has(task.status)
  const defaultNode = desiredNode || (!wholeTask ? choices[0]?.id : undefined)
  select.replaceChildren(...(wholeTask ? [option('', '整个任务')] : []), ...choices.map(node =>
    option(node.id, roleLabel(node.role) + ' ' + shortId(node.id), node.id === defaultNode)))
}

function submission(tasks, route, actions) {
  const eligible = tasks.filter(task => finishedTasks.has(task.status) || (task.nodes ?? []).some(node => finishedNodes.has(node.status)))
  const taskId = route.task && eligible.some(task => task.id === route.task) ? route.task : ''
  const taskSelect = el('select', { attrs: { name: 'taskId', id: 'evaluation-task', required: '' } },
    option('', eligible.length ? '选择任务' : '没有已结束的任务或节点'),
    eligible.map(task => option(task.id, shortId(task.id) + ' · ' + (task.taskRunId ?? task.id), taskId === task.id)))
  const nodeSelect = el('select', { attrs: { name: 'nodeId', id: 'evaluation-node' } })
  const artifactInput = el('textarea', { attrs: { name: 'artifacts', rows: 3, maxlength: 16384,
    placeholder: '例如 src/app.ts' } })
  const useModel = el('input', { attrs: { type: 'checkbox', name: 'useModel' } })
  const submit = el('button', { className: 'button primary', text: '发起评估', attrs: { type: 'submit', disabled: !eligible.length ? '' : null } })
  configureNodes(nodeSelect, eligible.find(task => task.id === taskId), route.node)
  taskSelect.addEventListener('change', () => configureNodes(nodeSelect, eligible.find(task => task.id === taskSelect.value)))
  const form = el('form', { className: 'evaluation-form', attrs: { 'data-form': 'evaluation', id: 'evaluation-form' } },
    el('div', { className: 'field-grid' },
      el('div', { className: 'field-stack' }, el('label', { text: '任务', attrs: { for: 'evaluation-task' } }), taskSelect),
      el('div', { className: 'field-stack' }, el('label', { text: '评估范围', attrs: { for: 'evaluation-node' } }), nodeSelect)),
    el('label', {}, '交付证据（可选，每行一个工作区相对路径）', artifactInput),
    el('label', { className: 'checkbox' }, useModel, '允许将本次任务目标和所选证据发送给已配置的评估模型'),
    el('div', { className: 'inline-actions' }, submit,
      el('span', { className: 'helper', text: '默认使用已有验收与回执。证据不足会保留不确定结论。' })))
  form.addEventListener('submit', async event => {
    event.preventDefault()
    submit.disabled = true
    try {
      const artifacts = artifactInput.value.split(/\r?\n/u).map(value => value.trim()).filter(Boolean)
      await actions.start({ taskId: taskSelect.value, ...(nodeSelect.value ? { nodeId: nodeSelect.value } : {}),
        ...(artifacts.length ? { artifacts } : {}), useModel: useModel.checked })
    } finally { submit.disabled = false }
  })
  return panel('发起评估', form)
}

export function evaluationView(tasks, route, actions) {
  return el('div', { className: 'stack' },
    submission(tasks, route, actions),
    panel('评估设置', el('div', { attrs: { id: 'evaluation-settings' } }, empty('正在读取评估配置。'))),
    panel('评估记录', el('div', { attrs: { id: 'evaluation-results' } }, empty('正在读取评估记录。'))))
}

function autoSettings(config, actions) {
  const automatic = el('input', { attrs: { type: 'checkbox', checked: config.automatic ? '' : null } })
  automatic.addEventListener('change', async () => {
    automatic.disabled = true
    const applied = await actions.setAutomatic(automatic.checked)
    if (!applied) automatic.checked = !automatic.checked
    automatic.disabled = false
  })
  return el('div', { className: 'stack' }, el('label', { className: 'checkbox' }, automatic, '任务结束后自动执行确定性评估'),
    el('p', { className: 'helper', text: config.model ? '可选评估模型 · ' + config.model : '当前未配置评估模型。' }))
}

function resultLabel(result) {
  return result?.method === 'model' ? 'AI 评估' : '确定性评估'
}

function evidenceLinks(job, references, title = '引用证据') {
  if (!references?.length) return null
  return el('div', {},
    el('strong', { className: 'secondary', text: title }),
    el('ul', { className: 'reference-list' }, references.map(ref => el('li', {},
      typeof ref === 'string' && ref.startsWith('operation:')
        ? link(ref, 'traces', { task: job.taskId, receipt: ref.slice('operation:'.length) })
        : el('code', { text: ref })))))
}

function listNotes(title, items) {
  if (!items?.length) return null
  return el('div', {}, el('h3', { text: title }), el('ul', {}, items.map(item => el('li', { text: item }))))
}

function scoreCard(job, name, value) {
  return el('div', { className: 'score-card' }, el('h3', { text: name }),
    el('strong', { text: Number.isFinite(value?.score) ? value.score + ' / 5' : '—' }),
    value?.rationale && el('p', { text: value.rationale }),
    evidenceLinks(job, value?.evidence))
}

function snapshotDetails(snapshot) {
  if (!snapshot) return null
  const files = snapshot.artifacts ?? snapshot.evidence?.artifacts
  return el('details', {}, el('summary', { text: '评估快照' }),
    facts([['采集时间', formatTime(snapshot.capturedAt)], ['事件游标', snapshot.cursor], ['任务目标摘要', snapshot.goalDigest]]),
    Array.isArray(files) && files.length > 0 && table(['文件', '内容摘要', '大小'], files.map(file => [
      el('code', { text: file.path }), el('code', { text: file.digest }), formatNumber(file.bytes) + ' B',
    ])), listNotes('证据范围', snapshot.limitations))
}

function evaluationRecord(job, actions) {
  const result = job.result
  const resultDetails = result && el('div', { className: 'stack' },
    facts([
      ['评估方式', resultLabel(result)], ['评分规则', result.rubricVersion],
      ['评估模型', [result.provider, result.model].filter(Boolean).join(' / ') || '不适用'],
      ['输入 Token', formatNumber(result.usage?.inputTokens)], ['输出 Token', formatNumber(result.usage?.outputTokens)],
      ['评估费用（估算 USD）', formatCurrency(result.usage?.estimatedCostUsd)],
      ['评估耗时', formatDuration(result.durationMs)], ['模型轮次', formatNumber(result.rounds)],
      ['评估状态', badge(result.status).textContent], ['用量覆盖', result.usage?.complete ? '完整' : '不完整'],
    ]),
    el('div', { className: 'score-grid' }, Object.entries(axes).map(([axis, title]) => scoreCard(job, title, result.scores?.[axis]))),
    listNotes('发现的问题', result.issues), listNotes('无法确认', result.unknowns), evidenceLinks(job, result.evidence))
  const cancel = el('button', { className: 'button', text: '取消评估', attrs: { type: 'button' } })
  cancel.addEventListener('click', async () => {
    cancel.disabled = true
    await actions.cancel(job.id)
    cancel.disabled = false
  })
  const reevaluate = el('button', { className: 'button', text: '重新评估', attrs: { type: 'button' } })
  reevaluate.addEventListener('click', () => actions.prepare(job))
  const summary = el('summary', {}, shortId(job.taskId) + (job.nodeId ? ' · 节点 ' + shortId(job.nodeId) : ' · 整个任务'),
    badge(job.status), result && badge(result.verdict), ' · ' + formatTime(job.createdAt ?? result?.startedAt))
  return el('details', { className: 'review', attrs: { 'data-detail': 'evaluation:' + job.id } }, summary,
    el('div', { className: 'details-body stack' },
      el('div', { className: 'inline-actions' }, link('查看原始 Trace', 'traces', { task: job.taskId }),
        activeJobs.has(job.status) ? cancel : reevaluate),
      job.error && empty(job.error), resultDetails, snapshotDetails(job.snapshot)))
}

function snapshotSignature(snapshot) {
  if (!snapshot) return
  const artifacts = (snapshot.artifacts ?? []).map(file => [file.path, file.digest, file.diffDigest]).sort((a, b) => a[0].localeCompare(b[0]))
  return JSON.stringify([snapshot.cursor, snapshot.goalDigest, snapshot.constraintsDigest, snapshot.structureDigest, artifacts])
}

function comparison(jobs, saved) {
  const groups = new Map()
  for (const job of jobs) {
    if (!job.result) continue
    const key = job.taskId + ':' + (job.nodeId ?? '')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(job)
  }
  const comparable = [...groups.values()].filter(group => group.length >= 2)
  if (!comparable.length) return null
  const options = comparable.flat()
  const pick = (label, side) => {
    const select = el('select', { attrs: { 'aria-label': label, 'data-compare': side } }, option('', '选择评估记录'), options.map(job =>
      option(job.id, shortId(job.taskId) + (job.nodeId ? ' / ' + shortId(job.nodeId) : '') + ' · ' +
        formatTime(job.createdAt ?? job.result.startedAt) + ' · ' + resultLabel(job.result) + ' · ' + shortId(job.id))))
    if (saved[side]) select.value = saved[side]
    return [el('label', {}, label, select), select]
  }
  const [leftLabel, left] = pick('评估 A', 'a')
  const [rightLabel, right] = pick('评估 B', 'b')
  const view = el('div', {})
  const show = () => {
    const one = options.find(job => job.id === left.value)
    const two = options.find(job => job.id === right.value)
    if (!one || !two) { view.replaceChildren(); return }
    if (one.id === two.id || one.taskId !== two.taskId || one.nodeId !== two.nodeId) {
      view.replaceChildren(empty('请选择同一任务或节点的两次不同评估。'))
      return
    }
    const first = snapshotSignature(one.snapshot)
    const second = snapshotSignature(two.snapshot)
    const note = !first || !second ? '至少一份记录缺少证据快照。' : first === second ? '两次评估使用了相同版本的证据。' : '两次评估使用了不同版本的证据。'
    view.replaceChildren(el('p', { className: 'helper', text: note }), table(['维度', '评估 A', '评估 B'], [
      ['结论', badge(one.result.verdict), badge(two.result.verdict)],
      ...Object.entries(axes).map(([axis, title]) => [title, formatNumber(one.result.scores?.[axis]?.score), formatNumber(two.result.scores?.[axis]?.score)]),
      ['模型', one.result.model ?? '确定性', two.result.model ?? '确定性'],
      ['规则版本', one.result.rubricVersion, two.result.rubricVersion],
      ['证据游标', one.snapshot?.cursor, two.snapshot?.cursor],
      ['评估费用（估算 USD）', formatCurrency(one.result.usage?.estimatedCostUsd), formatCurrency(two.result.usage?.estimatedCostUsd)],
    ]))
  }
  left.addEventListener('change', show)
  right.addEventListener('change', show)
  show()
  return el('div', { className: 'evaluation-form' }, el('h3', { text: '比较评估' }),
    el('div', { className: 'field-grid' }, leftLabel, rightLabel), view)
}

export function updateEvaluation(data, route, actions) {
  const settings = document.getElementById('evaluation-settings')
  const container = document.getElementById('evaluation-results')
  if (!settings || !container) return
  const config = data.config ?? {}
  const useModel = document.getElementById('evaluation-form')?.elements.useModel
  if (useModel) {
    useModel.disabled = !config.model
    if (useModel.disabled) useModel.checked = false
  }
  const configKey = JSON.stringify(config)
  if (settings.dataset.version !== configKey) {
    settings.replaceChildren(autoSettings(config, actions))
    settings.dataset.version = configKey
  }
  const jobs = (data.evaluations ?? []).filter(job => !route.task || job.taskId === route.task)
    .filter(job => !route.node || job.nodeId === route.node)
  const version = JSON.stringify(jobs)
  if (container.dataset.version === version) return
  container.dataset.version = version
  const opened = new Set([...container.querySelectorAll('details[open][data-detail]')].map(item => item.dataset.detail))
  const compared = Object.fromEntries([...container.querySelectorAll('select[data-compare]')].map(item => [item.dataset.compare, item.value]))
  if (!jobs.length) { container.replaceChildren(empty('当前范围暂无评估记录。')); return }
  const records = jobs.map(job => evaluationRecord(job, actions))
  for (const item of records) item.open = opened.has(item.dataset.detail)
  container.replaceChildren(el('div', { className: 'stack' }, comparison(jobs, compared), el('div', {}, records)))
}
