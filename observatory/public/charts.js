const svgNs = 'http://www.w3.org/2000/svg'
const numFmt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })
const rmbFmt = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 6 })

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(svgNs, tag)
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, String(v))
  for (const child of children.flat()) if (child != null && typeof child !== 'boolean') node.append(child)
  return node
}

function el(tag, { className, text, attrs } = {}, ...children) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = String(text)
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, String(v))
  for (const child of children.flat()) if (child != null && typeof child !== 'boolean') node.append(child)
  return node
}

function metricMap(metrics) {
  const map = new Map()
  for (const list of Object.values(metrics?.domains ?? {})) {
    for (const item of list) map.set(item.id, item)
  }
  return map
}

function fmtPct(val) {
  return typeof val === 'number' && Number.isFinite(val) ? numFmt.format(val) + '%' : '—'
}

function fmtRmb(val) {
  return typeof val === 'number' && Number.isFinite(val) ? rmbFmt.format(val) : '—'
}

function ringGauge(value, { label, subtitle, tone = 'good' }) {
  const valid = typeof value === 'number' && Number.isFinite(value)
  const clamped = valid ? Math.max(0, Math.min(100, value)) : 0
  const r = 30
  const circumference = 2 * Math.PI * r
  const strokeDashoffset = circumference * (1 - clamped / 100)
  const chart = svg('svg', { viewBox: '0 0 80 80', class: 'viz-ring', role: 'img', 'aria-label': `${label} ${fmtPct(value)}` },
    svg('circle', { cx: 40, cy: 40, r, class: 'viz-ring-track' }),
    svg('circle', {
      cx: 40, cy: 40, r,
      class: 'viz-ring-fill',
      'data-tone': tone,
      'stroke-dasharray': circumference.toFixed(2),
      'stroke-dashoffset': valid ? strokeDashoffset.toFixed(2) : circumference.toFixed(2),
    }),
    svg('text', { x: 40, y: 44, 'text-anchor': 'middle', class: 'viz-ring-value' }, valid ? numFmt.format(clamped) + '%' : '—'),
  )
  return el('div', { className: 'viz-gauge' }, chart,
    el('div', { className: 'viz-gauge-meta' }, el('strong', { text: label }), el('small', { text: subtitle })))
}

function stackedBar(segments, emptyText = '暂无样本') {
  const total = segments.reduce((sum, seg) => sum + (seg.value || 0), 0)
  if (!total) {
    return el('div', { className: 'viz-stack-empty', text: emptyText })
  }
  const track = el('div', { className: 'viz-stack-bar', attrs: { role: 'img', 'aria-label': segments.map(s => `${s.label} ${numFmt.format(s.value)}`).join('，') } },
    segments.filter(s => s.value > 0).map(seg => {
      const piece = el('span', { className: 'viz-stack-seg', attrs: { title: `${seg.label}: ${numFmt.format(seg.value)} (${numFmt.format(100 * seg.value / total)}%)`, 'data-color': seg.color } })
      piece.style.width = (100 * seg.value / total) + '%'
      return piece
    }))
  const legend = el('div', { className: 'viz-legend' }, segments.map(seg =>
    el('span', { className: 'viz-legend-item' },
      el('i', { attrs: { 'data-color': seg.color } }),
      el('span', { text: `${seg.label} ` }),
      el('strong', { text: numFmt.format(seg.value) }))))
  return el('div', { className: 'viz-stack-wrap' }, track, legend)
}

function progressRow(label, value, total, tone = 'good', displayValue) {
  const ratio = total > 0 && typeof value === 'number' ? Math.max(0, Math.min(100, (value / total) * 100)) : 0
  const fill = el('span', { className: 'viz-bar-fill', attrs: { 'data-tone': tone } })
  fill.style.width = ratio + '%'
  return el('div', { className: 'viz-bar-row' },
    el('div', { className: 'viz-bar-head' }, el('span', { text: label }), el('strong', { text: displayValue ?? fmtPct(ratio) })),
    el('div', { className: 'viz-bar-track' }, fill))
}

export function overviewVisualCockpit(data) {
  const byId = metricMap(data.metrics)
  const get = id => byId.get(id)?.value
  const rate = data.usdToCnyRate ?? data.metrics?.usdToCnyRate ?? 7.2

  const completionCard = el('article', { className: 'viz-card' },
    el('h3', { text: '任务完成度漏斗与自愈力' }),
    el('div', { className: 'viz-gauges' },
      ringGauge(get('task.verified_rate'), { label: '确定性验收率', subtitle: '通过真实检查 / 已结束', tone: 'good' }),
      ringGauge(get('task.first_pass_verified_rate'), { label: '首轮 Pass@1', subtitle: '零重规划且零干预一次通过', tone: 'blue' }),
    ),
    el('div', { className: 'viz-bars' },
      progressRow('执行抵达验收阶段', get('task.execution_rate') ?? 0, 100, 'blue', fmtPct(get('task.execution_rate'))),
      progressRow('强证据验证率 (T3+T2)', get('task.strong_verified_rate') ?? 0, 100, 'good', fmtPct(get('task.strong_verified_rate'))),
      progressRow('挫败自主修复率', get('task.self_repair_rate') ?? 0, 100, 'purple', fmtPct(get('task.self_repair_rate'))),
      progressRow('人工干预介入率', get('task.steering_rate') ?? 0, 100, 'warning', fmtPct(get('task.steering_rate'))),
    ),
  )

  const rigorCard = el('article', { className: 'viz-card' },
    el('h3', { text: '验收证据强度分级 (T0-T3)' }),
    stackedBar([
      { label: 'T3 命令验证', value: get('task.rigor_command') ?? 0, color: 'good' },
      { label: 'T2 视觉零错', value: get('task.rigor_visual') ?? 0, color: 'blue' },
      { label: 'T1 路径检查', value: get('task.rigor_path') ?? 0, color: 'purple' },
      { label: 'T0 未自动验收', value: get('task.unverified') ?? 0, color: 'warning' },
      { label: '验收失败', value: get('task.verification_failed') ?? 0, color: 'bad' },
    ], '暂无已结束任务'),
    el('div', { className: 'viz-kpis-inline' },
      el('div', {}, el('span', { text: '子目标达成率' }), el('strong', { text: fmtPct(get('dag.node_completion_rate')) })),
      el('div', {}, el('span', { text: 'Agent 运行重叠倍数' }), el('strong', { text: typeof get('agents.parallel_speedup') === 'number' ? numFmt.format(get('agents.parallel_speedup')) + 'x' : '—' })),
      el('div', {}, el('span', { text: '独立评估通过率' }), el('strong', { text: fmtPct(get('eval.pass_rate')) })),
    ),
  )

  const costCard = el('article', { className: 'viz-card' },
    el('h3', { text: 'Token 构成与人民币价值' }),
    stackedBar([
      { label: '未缓存输入', value: get('model.input') ?? 0, color: 'blue' },
      { label: '缓存读取', value: get('model.cache_read') ?? 0, color: 'good' },
      { label: '缓存写入', value: get('model.cache_write') ?? 0, color: 'purple' },
      { label: '模型输出', value: get('model.output') ?? 0, color: 'warning' },
    ], '暂无 Token 用量报告'),
    el('div', { className: 'viz-bars' },
      progressRow('提示词缓存命中率', get('model.cache_hit_rate') ?? 0, 100, 'good', fmtPct(get('model.cache_hit_rate'))),
      progressRow('返工重试 Token 损耗率', get('task.rework_token_share') ?? 0, 100, 'bad', fmtPct(get('task.rework_token_share'))),
    ),
    el('div', { className: 'viz-kpis-inline' },
      el('div', {}, el('span', { text: '估算模型成本' }), el('strong', { text: fmtRmb(get('model.cost')) })),
      el('div', {}, el('span', { text: '单次达标成本' }), el('strong', { text: fmtRmb(get('model.cost_per_verified_task')) })),
    ),
    el('p', { className: 'helper', text: `参考折算汇率：1 USD ≈ ${rate} CNY` }),
  )

  const qualityCard = el('article', { className: 'viz-card' },
    el('h3', { text: '编辑效率、视觉与独立评分' }),
    el('div', { className: 'viz-bars' },
      progressRow('独立评估：完成度均分', (get('eval.completion_score') ?? 0) * 20, 100, 'good', typeof get('eval.completion_score') === 'number' ? numFmt.format(get('eval.completion_score')) + ' / 5' : '—'),
      progressRow('独立评估：正确性均分', (get('eval.correctness_score') ?? 0) * 20, 100, 'blue', typeof get('eval.correctness_score') === 'number' ? numFmt.format(get('eval.correctness_score')) + ' / 5' : '—'),
      progressRow('独立评估：交付质量均分', (get('eval.quality_score') ?? 0) * 20, 100, 'purple', typeof get('eval.quality_score') === 'number' ? numFmt.format(get('eval.quality_score')) + ' / 5' : '—'),
    ),
    el('div', { className: 'viz-kpis-inline' },
      el('div', {}, el('span', { text: '文件修改折腾指数' }), el('strong', { text: typeof get('tool.edit_churn_ratio') === 'number' ? numFmt.format(get('tool.edit_churn_ratio')) + ' 次/文件' : '—' })),
      el('div', {}, el('span', { text: '视觉首轮零错率' }), el('strong', { text: fmtPct(get('tool.visual_clean_rate')) })),
      el('div', {}, el('span', { text: '事件缺口' }), el('strong', { text: numFmt.format(get('reliability.missing_events') ?? 0) })),
    ),
  )

  return el('div', { className: 'viz-grid' }, completionCard, rigorCard, costCard, qualityCard)
}

export function domainVisualChart(view, data) {
  const metrics = data.metrics ?? {}
  if (view === 'models') {
    const groups = (metrics.models ?? []).map(group => {
      const m = new Map(group.metrics.map(item => [item.id, item.value]))
      return {
        label: group.label + (group.role ? ` (${group.role})` : ''),
        tokens: m.get('model.tokens') ?? 0,
        cost: m.get('model.cost'),
        hitRate: m.get('model.cache_hit_rate'),
        latency: m.get('model.mean_latency'),
      }
    }).sort((a, b) => b.tokens - a.tokens)
    if (!groups.length) return null
    const maxTokens = Math.max(1, ...groups.map(g => g.tokens))
    return el('div', { className: 'viz-bars' }, groups.slice(0, 10).map(item => {
      const detail = `${numFmt.format(item.tokens)} Token · ${fmtRmb(item.cost)} · 缓存命中 ${fmtPct(item.hitRate)}`
      return progressRow(item.label, item.tokens, maxTokens, 'blue', detail)
    }))
  }

  if (view === 'tools') {
    const rows = (metrics.tools ?? []).map(group => {
      const m = new Map(group.metrics.map(item => [item.id, item.value]))
      return { name: group.label, calls: m.get('tool.calls') ?? 0, failRate: m.get('tool.failure_rate') ?? 0 }
    }).sort((a, b) => b.calls - a.calls)
    if (!rows.length) return null
    const maxCalls = Math.max(1, ...rows.map(r => r.calls))
    return el('div', { className: 'viz-bars' }, rows.slice(0, 12).map(item => {
      const tone = item.failRate >= 50 ? 'bad' : item.failRate > 0 ? 'warning' : 'good'
      return progressRow(item.name, item.calls, maxCalls, tone, `${numFmt.format(item.calls)} 次 · 失败率 ${fmtPct(item.failRate)}`)
    }))
  }

  if (view === 'judgment') {
    const groups = (metrics.judgments ?? []).map(group => {
      const m = new Map(group.metrics.map(item => [item.id, item.value]))
      return {
        name: group.point ?? group.label,
        mode: group.mode ?? 'off',
        decisions: m.get('judgment.decisions') ?? 0,
        disagreement: m.get('judgment.shadow_disagreement'),
        fallback: m.get('judgment.fallback_rate'),
      }
    })
    const active = groups.filter(g => g.decisions > 0)
    if (!active.length) return null
    return el('div', { className: 'viz-bars' }, active.map(item =>
      el('div', { className: 'viz-judge-row' },
        progressRow(`${item.name} [${item.mode}]`, item.disagreement ?? 0, 100, 'blue',
          `调用 ${numFmt.format(item.decisions)} · 分歧 ${fmtPct(item.disagreement)} · 回退 ${fmtPct(item.fallback)}`),
      )))
  }
  return null
}
