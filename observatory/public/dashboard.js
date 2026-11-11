import { domainView, el, empty, formatTime, link, overviewView, panel, routeHash, traceList, viewTitles } from './components.js'
import { traceView } from './trace-view.js'
import { evaluationView, updateEvaluation } from './evaluation-view.js'

const view = document.getElementById('view')
const title = document.getElementById('page-title')
const status = document.getElementById('connection')
const notice = document.getElementById('notice')
const filters = document.getElementById('filters')
const reloadButton = document.getElementById('refresh')
const navigation = document.getElementById('navigation')
const tokenKey = 'zlo-observatory-access'
const tokenPattern = /^[A-Za-z0-9_-]{32,128}$/u
const routeFields = ['task', 'node', 'event', 'agent', 'receipt', 'page', 'spanPage']

let token = ''
let route = { view: 'overview' }
let query = new URLSearchParams()
let rollingHours
let controller
let rendered = ''
let evaluationTasks = ''
let noticeTimeout

function sessionToken() {
  try { return sessionStorage.getItem(tokenKey) ?? '' } catch { return '' }
}
function rememberToken(value) {
  token = value
  try {
    if (value) sessionStorage.setItem(tokenKey, value)
    else sessionStorage.removeItem(tokenKey)
  } catch {}
}

function routeFromLocation() {
  const raw = location.hash.slice(1)
  const params = new URLSearchParams(raw)
  const incoming = params.get('token') ?? (tokenPattern.test(raw) ? raw : null)
  if (incoming != null) {
    if (tokenPattern.test(incoming)) rememberToken(incoming)
    history.replaceState(null, '', location.pathname + '#overview')
    return { view: 'overview' }
  }
  const index = raw.indexOf('?')
  const name = index < 0 ? raw : raw.slice(0, index)
  const fields = index < 0 ? new URLSearchParams() : new URLSearchParams(raw.slice(index + 1))
  const next = { view: Object.hasOwn(viewTitles, name) ? name : 'overview' }
  for (const field of routeFields) {
    const value = fields.get(field)
    if (value && value.length <= 128) next[field] = value
  }
  return next
}

function message(text, tone = 'warning', transient = false) {
  clearTimeout(noticeTimeout)
  notice.hidden = !text
  notice.textContent = text ?? ''
  notice.dataset.tone = tone
  if (text && transient) noticeTimeout = setTimeout(() => message(), 4500)
}

function state(label, tone, detail = '') {
  status.textContent = label
  status.dataset.tone = tone
  status.title = detail
}
function collectorState(health) {
  const when = health?.lastSuccess ? '上次同步 ' + formatTime(health.lastSuccess) : ''
  switch (health?.state) {
    case 'online':
    case 'live':
    case 'streaming':
    case 'connected':
    case 'ready': state('Host 已连接', 'good', when); break
    case 'offline':
    case 'disconnected':
    case 'retrying':
    case 'error': state('Host 离线 · 本地历史', 'warning', when); break
    case 'degraded':
    case 'gap': state('采集有缺口', 'warning', when); break
    case 'catching_up': state('正在回放事件', 'waiting', when); break
    default: state('等待 Host', 'waiting', when)
  }
}

class RequestError extends Error {
  constructor(statusCode) { super('Request failed'); this.statusCode = statusCode }
}

async function request(path, { body, signal } = {}) {
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
  })
  if (!response.ok) throw new RequestError(response.status)
  return response.json()
}

function renderAccess(invalid = false) {
  filters.hidden = true
  reloadButton.disabled = true
  state(invalid ? '访问已拒绝' : '需要访问令牌', 'warning')
  const input = el('input', { attrs: { type: 'password', name: 'token', autocomplete: 'off', maxlength: 256,
    required: '', spellcheck: 'false' } })
  const form = el('form', {}, el('label', {}, '本机访问令牌', input),
    el('button', { className: 'button primary', attrs: { type: 'submit' }, text: '连接' }))
  form.addEventListener('submit', event => {
    event.preventDefault()
    if (!tokenPattern.test(input.value)) {
      message('请使用中台启动时提供的访问令牌。', 'bad')
      return
    }
    rememberToken(input.value)
    input.value = ''
    reloadButton.disabled = false
    void refresh({ forced: true })
  })
  view.replaceChildren(el('div', { className: 'access' },
    panel('连接到本机中台', el('div', {},
      el('p', { text: '打开中台启动时提供的本机链接，或输入其中的访问令牌。' }), form))))
}

function datalist(id, values) {
  const options = [...new Set(values.filter(value => typeof value === 'string' && value))].slice(0, 300)
  const target = document.getElementById(id)
  const prior = target.dataset.values
  const next = JSON.stringify(options)
  if (prior !== next) {
    target.replaceChildren(...options.map(value => el('option', { attrs: { value } })))
    target.dataset.values = next
  }
}

function fillFilters(data) {
  const routes = [...data.tasks.map(task => task.route), ...(data.metrics?.models ?? [])]
  datalist('task-ids', data.tasks.map(task => task.id))
  datalist('providers', routes.map(route => route?.provider))
  datalist('model-ids', routes.map(route => route?.model))
}

function showError(error, action) {
  if (error?.statusCode === 401 || error?.statusCode === 403) {
    rememberToken('')
    message('访问令牌无效或已更换。', 'bad')
    renderAccess(true)
    return
  }
  let detail = '请确认本机中台仍在运行，然后重试。'
  if (error?.statusCode === 400) detail = '请检查筛选条件或证据路径。'
  if (error?.statusCode === 404) detail = '当前本机历史中没有对应记录。'
  if (error?.statusCode === 409) detail = '任务或评估状态已变化，请刷新后重试。'
  if (error?.statusCode === 429) detail = '评估队列已满，请稍后重试。'
  message(action + '失败。' + detail, 'bad')
}

const actions = {
  prepare(job) {
    const form = document.getElementById('evaluation-form')
    const task = form?.elements.taskId
    if (!task || ![...task.options].some(option => option.value === job.taskId)) {
      message('任务或节点尚未结束，无法重新评估。', 'warning')
      return
    }
    task.value = job.taskId
    task.dispatchEvent(new Event('change'))
    const node = form.elements.nodeId
    const nodeId = job.nodeId ?? ''
    if (![...node.options].some(option => option.value === nodeId)) {
      message('该节点已不在当前的可评估范围。', 'warning')
      return
    }
    node.value = nodeId
    form.elements.artifacts.value = (job.snapshot?.artifacts ?? []).map(file => file.path).join('\n')
    form.elements.useModel.checked = false
    task.focus()
    message('已带入上次的评估范围和文件路径。请检查后发起新评估。', 'good', true)
  },
  async start(input) {
    try {
      await request('/api/evaluations', { body: input })
      message('评估已加入队列。', 'good', true)
      void refresh({ forced: true })
    } catch (error) { showError(error, '发起评估') }
  },
  async cancel(id) {
    try {
      await request('/api/evaluations/' + encodeURIComponent(id) + '/cancel', { body: {} })
      message('已请求取消评估。', 'good', true)
      void refresh({ forced: true })
    } catch (error) { showError(error, '取消评估') }
  },
  async setAutomatic(automatic) {
    try {
      await request('/api/evaluation-settings', { body: { automatic } })
      message(automatic ? '已启用自动确定性评估。' : '已关闭自动评估。', 'good', true)
      void refresh({ forced: true })
      return true
    } catch (error) { showError(error, '更新评估设置'); return false }
  },
}

function evaluationFormValues() {
  const form = document.getElementById('evaluation-form')
  if (!form) return
  return {
    taskId: form.elements.taskId.value, nodeId: form.elements.nodeId.value,
    artifacts: form.elements.artifacts.value, useModel: form.elements.useModel.checked,
  }
}
function renderEvaluation(overview, data, current) {
  const taskChoices = overview.tasks.map(task => [task.id, task.status, (task.nodes ?? []).map(node => [node.id, node.status])])
  const choices = JSON.stringify(taskChoices)
  if (rendered !== 'evaluation' || evaluationTasks !== choices) {
    const old = rendered === 'evaluation' ? evaluationFormValues() : undefined
    view.replaceChildren(evaluationView(overview.tasks, { ...current, ...(old ? { task: old.taskId, node: old.nodeId } : {}) }, actions))
    const form = document.getElementById('evaluation-form')
    if (form && old) {
      form.elements.artifacts.value = old.artifacts
      form.elements.useModel.checked = old.useModel
    }
    rendered = 'evaluation'
    evaluationTasks = choices
  }
  updateEvaluation(data, current, actions)
}

function swap(content, key) {
  if (rendered === key) return false
  const opened = new Set([...view.querySelectorAll('details[open][data-detail]')].map(item => item.dataset.detail))
  const focused = document.activeElement?.closest('details[data-detail]')?.dataset.detail
  view.replaceChildren(content)
  rendered = key
  for (const item of view.querySelectorAll('details[data-detail]')) {
    item.open = opened.has(item.dataset.detail)
    if (item.dataset.detail === focused) item.querySelector('summary')?.focus({ preventScroll: true })
  }
  return true
}

async function receiptEventId(trace, receipt) {
  const receipts = trace.events.filter(event => event.type === 'tool.finished' && typeof event.payload?.id === 'string')
  const direct = receipts.find(event => event.payload.id === receipt)
  if (direct) return direct.id
  if (!/^sha256:[0-9a-f]{64}$/u.test(receipt) || !crypto.subtle) return
  const encoder = new TextEncoder()
  for (const event of receipts) {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(event.payload.id))
    const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    if ('sha256:' + hex === receipt) return event.id
  }
}

function reveal(current, moved) {
  const anchor = current.event ? 'event-' + current.event : current.agent ? 'agent-' + current.agent : ''
  const target = anchor ? document.getElementById(anchor) : null
  if (target && moved) {
    target.open = true
    target.scrollIntoView({ block: 'nearest' })
  }
}
function display(data, trace, evaluations, current, moved) {
  const { view: section } = current
  if (section === 'evaluation') { renderEvaluation(data, evaluations, current); return }
  if (section === 'traces' && current.task) {
    if (!trace) {
      const key = 'trace-missing:' + current.task
      if (rendered !== key) swap(panel('找不到任务', empty('此任务尚未采集到本机中台。'), link('返回任务列表', 'traces')), key)
      return
    }
    const liveTime = trace.timing?.liveWallClockMs
    const key = 'trace:' + JSON.stringify([trace.task, trace.coverage, trace.events.at(-1)?.id, liveTime && Math.floor(liveTime / 1000), current])
    if (rendered !== key) {
      swap(traceView(trace, current), key)
      reveal(current, moved)
    }
    return
  }
  const key = section + ':' + JSON.stringify([data.metrics, data.tasks])
  if (rendered === key) return
  const next = section === 'overview' ? overviewView(data) : section === 'traces' ? traceList(data) : domainView(section, data)
  swap(next, key)
}

async function refresh({ forced = false, moved = false } = {}) {
  if (!token) { renderAccess(); return }
  if (controller && !forced) return
  controller?.abort()
  const current = route
  const active = new AbortController()
  controller = active
  reloadButton.disabled = true
  filters.hidden = current.view === 'evaluation' || (current.view === 'traces' && !!current.task)
  const options = { signal: active.signal }
  const overviewQuery = new URLSearchParams(current.view === 'evaluation' ? undefined
    : current.view === 'traces' && current.task ? { taskId: current.task } : query)
  if (rollingHours && current.view !== 'evaluation' && !(current.view === 'traces' && current.task)) {
    const now = Date.now()
    overviewQuery.set('from', new Date(now - rollingHours * 3600000).toISOString())
    overviewQuery.set('to', new Date(now).toISOString())
  }
  try {
    const trace = current.view === 'traces' && current.task
      ? request('/api/tasks/' + encodeURIComponent(current.task), options).catch(error => {
        if (error?.statusCode === 404) return null
        throw error
      })
      : null
    const evaluations = current.view === 'evaluation' ? request('/api/evaluations', options) : null
    const suffix = overviewQuery.toString()
    const [data, taskTrace, evaluation] = await Promise.all([
      request('/api/overview' + (suffix ? '?' + suffix : ''), options), trace, evaluations,
    ])
    const resolved = taskTrace && current.receipt && !current.event
      ? { ...current, event: await receiptEventId(taskTrace, current.receipt) } : current
    if (active.signal.aborted) return
    data.tasks ??= []
    collectorState(data.health)
    if (!filters.hidden) fillFilters(data)
    display(data, taskTrace, evaluation, resolved, moved)
  } catch (error) {
    if (active.signal.aborted) return
    if (error?.statusCode !== 401 && error?.statusCode !== 403) state('中台暂不可用', 'bad')
    showError(error, '读取中台数据')
  } finally {
    if (controller === active) {
      controller = undefined
      reloadButton.disabled = !token
    }
  }
}

function navigate() {
  route = routeFromLocation()
  title.textContent = viewTitles[route.view]
  for (const item of navigation.querySelectorAll('[data-view]')) {
    if (item.dataset.view === route.view) item.setAttribute('aria-current', 'page')
    else item.removeAttribute('aria-current')
  }
  message()
  rendered = ''
  view.replaceChildren(empty('正在读取本机记录。'))
  void refresh({ forced: true, moved: true })
}

function filterTimes(data) {
  const period = data.get('period')
  if (period === 'custom') {
    const from = data.get('from')
    const to = data.get('to')
    if (from && to && new Date(from) > new Date(to)) throw new Error('invalid range')
    return { from: from ? new Date(from).toISOString() : '', to: to ? new Date(to).toISOString() : '' }
  }
  return {}
}
function showCustomTime() {
  for (const label of filters.querySelectorAll('.custom-time')) label.hidden = filters.elements.period.value !== 'custom'
}
filters.elements.period.addEventListener('change', showCustomTime)
filters.addEventListener('submit', event => {
  event.preventDefault()
  const data = new FormData(filters)
  let times
  try { times = filterTimes(data) } catch { message('请选择有效的开始与结束时间。', 'bad'); return }
  const next = new URLSearchParams()
  for (const [key, value] of Object.entries(times)) if (value) next.set(key, value)
  for (const key of ['taskId', 'role', 'provider', 'model', 'status']) {
    const value = String(data.get(key) ?? '').trim()
    if (value) next.set(key, value)
  }
  query = next
  rollingHours = Number(data.get('period')) || undefined
  message()
  void refresh({ forced: true })
})
filters.addEventListener('reset', () => {
  query = new URLSearchParams()
  rollingHours = undefined
  message()
  queueMicrotask(showCustomTime)
  void refresh({ forced: true })
})
document.querySelector('.skip-link').addEventListener('click', event => {
  event.preventDefault()
  document.getElementById('content').focus()
})
reloadButton.addEventListener('click', () => { message(); void refresh({ forced: true }) })
window.addEventListener('hashchange', navigate)
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh() })
setInterval(() => { if (!document.hidden) void refresh() }, 5000)
const saved = sessionToken()
if (tokenPattern.test(saved)) token = saved
navigate()
