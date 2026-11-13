export const windowChannels = {
  minimize: 'window:minimize',
  toggleMaximize: 'window:toggle-maximize',
  close: 'window:close',
  maximized: 'window:is-maximized',
  changed: 'window:maximized-changed',
  openExternalLink: 'window:open-external-link',
} as const

export interface WindowApi {
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  close(): Promise<void>
  isMaximized(): Promise<boolean>
  openExternalLink(url: string): Promise<void>
  onMaximizedChange(listener: (maximized: boolean) => void): () => void
}
