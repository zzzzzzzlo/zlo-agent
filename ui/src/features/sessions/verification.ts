import { verificationVerdict } from '../../../../shared/contracts/domain.ts'
import type { VerificationResult } from '../../../../shared/contracts/domain.ts'

const labels = {
  verified: '验收通过',
  unverified: '目标尚未验证',
  failed: '验收未通过',
  not_applicable: '无需目标验收',
}

export function verificationLabel(result: VerificationResult): string {
  return labels[verificationVerdict(result)]
}
