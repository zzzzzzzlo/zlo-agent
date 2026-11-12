import { useLayoutEffect, useRef } from 'react'
import { ArrowLeft } from 'lucide-react'
import { managementLabels, ManagementSections } from '../settings/ManagementSections'
import type { ManagementSection } from '../settings/ManagementSections'

export function ManagementPage({ section, onBack }: { section: ManagementSection; onBack(): void }) {
  const page = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    page.current?.scrollTo(0, 0)
    page.current?.querySelector('h1')?.focus({ preventScroll: true })
  }, [section])
  return (
    <main className="management-page" aria-label={managementLabels[section]} ref={page}>
      <div className="management-page-inner">
        <button type="button" className="page-back" onClick={onBack}><ArrowLeft size={15} />返回对话</button>
        <ManagementSections key={section} section={section} />
      </div>
    </main>
  )
}
