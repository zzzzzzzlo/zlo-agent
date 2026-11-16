export const DEFAULT_USD_TO_CNY_RATE = 7.2

const cnyFormatter = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
})

const cnyShortFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
})

export function resolveUsdToCnyRate(env?: Record<string, string | undefined>): number {
  const source = env ?? (typeof process !== 'undefined' ? process.env : undefined)
  const raw = source?.ZLO_USD_TO_CNY_RATE
  if (!raw) return DEFAULT_USD_TO_CNY_RATE
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? parsed : DEFAULT_USD_TO_CNY_RATE
}

export function usdToCny(usd: number, rate = DEFAULT_USD_TO_CNY_RATE): number {
  if (!Number.isFinite(usd) || usd < 0 || !Number.isFinite(rate) || rate <= 0) return 0
  return Number((usd * rate).toFixed(10))
}

export function formatCny(cny: number): string {
  return Number.isFinite(cny) ? cnyFormatter.format(cny) : '—'
}

export function formatCnyValue(cny: number): string {
  return Number.isFinite(cny) ? cnyShortFormatter.format(cny) : '—'
}

export function formatUsdAsCny(usd: number, rate = DEFAULT_USD_TO_CNY_RATE): string {
  return Number.isFinite(usd) ? formatCny(usdToCny(usd, rate)) : '—'
}

export function cnyRateNote(rate = DEFAULT_USD_TO_CNY_RATE): string {
  return `按目录美元价折算，参考汇率 1 USD ≈ ${rate} CNY`
}
