import { verificationVerdict } from '../../../../shared/contracts/domain.ts'
import type { VerificationResult } from '../../../../shared/contracts/domain.ts'

const labels = {
  verified: '验收通过',
  unverified: '未自动验收',
  failed: '验收未通过',
  not_applicable: '无需目标验收',
}

export function verificationLabel(result: VerificationResult): string {
  return labels[verificationVerdict(result)]
}

export function verificationExplanation(result: VerificationResult): string | undefined {
  if (verificationVerdict(result) === 'unverified') return '执行已结束，系统没有足够的自动检查证据来判断是否达成目标。'
}
