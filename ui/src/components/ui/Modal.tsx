import { useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { Glass } from '../glass/Glass'
import { IconButton } from './IconButton'

export function Modal({ title, subtitle, onClose, children, className = '' }: {
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
  className?: string
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => { dialog.current?.showModal() }, [])

  return (
    <dialog
      ref={dialog}
      className={`modal ${className}`}
      aria-labelledby="modal-title"
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <Glass variant="popover" elevated className="modal-glass">
        <header className="modal-header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <IconButton label="关闭弹窗" onClick={onClose}><X size={17} /></IconButton>
        </header>
        {children}
      </Glass>
    </dialog>
  )
}
