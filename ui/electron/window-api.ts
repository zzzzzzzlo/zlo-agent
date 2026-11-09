export const windowChannels = {
  minimize: 'window:minimize',
  toggleMaximize: 'window:toggle-maximize',
  close: 'window:close',
  maximized: 'window:is-maximized',
  changed: 'window:maximized-changed',
} as const

export interface WindowApi {
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  close(): Promise<void>
  isMaximized(): Promise<boolean>
  onMaximizedChange(listener: (maximized: boolean) => void): () => void
}
