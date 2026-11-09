import type { WindowApi } from '../electron/window-api'

declare global {
  interface Window {
    desktopWindow?: WindowApi
  }
}
