import { LiquiGlass } from '@liqui-design/glass'
import type { LiquiGlassProps } from '@liqui-design/glass'

type GlassProps = Omit<LiquiGlassProps, 'radius' | 'refraction' | 'bezel'> & {
  variant?: 'panel' | 'dock' | 'popover' | 'control'
}

const geometry = {
  panel: { radius: 0, blur: 3.3, refraction: 38, bezel: 12 },
  dock: { radius: 24, blur: 2.2, refraction: 65, bezel: 20 },
  popover: { radius: 22, blur: 2.4, refraction: 50, bezel: 15 },
  control: { radius: 11, blur: 1.5, refraction: 26, bezel: 9 },
}

export function Glass({ variant = 'dock', className = '', ...props }: GlassProps) {
  return <LiquiGlass {...geometry[variant]} {...props} className={`glass glass-${variant} ${className}`} />
}
