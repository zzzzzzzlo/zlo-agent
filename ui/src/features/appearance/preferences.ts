import { defaultGlassTheme } from '@liqui-design/glass'

export type Theme = 'dark' | 'light'
export type GlassStrength = 'soft' | 'balanced' | 'vivid'
export const optics = {
  soft: { ...defaultGlassTheme, material: 'frost', frost: 0.34, specular: 0.32, blurScale: 0.8, dispersion: 0, saturation: 1 },
  balanced: { ...defaultGlassTheme, material: 'auto', frost: 0.18, specular: 0.55, refractionScale: 1, dispersion: 0, saturation: 1 },
  vivid: { ...defaultGlassTheme, material: 'auto', frost: 0.15, specular: 0.82, refractionScale: 1.65, dispersion: 0, saturation: 1 },
} as const
