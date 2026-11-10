import type { WindowApi } from '../electron/window-api'
import type { DesktopHostApi } from '../../shared/contracts/desktop.ts'

declare global {
  interface Window {
    desktopWindow?: WindowApi
    agentHost?: DesktopHostApi
  }
}
