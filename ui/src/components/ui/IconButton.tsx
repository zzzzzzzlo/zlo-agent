import type { ButtonHTMLAttributes } from 'react'

export function IconButton({
  label, className = '', ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" aria-label={label} title={label} {...props} className={`icon-button ${className}`} />
}
