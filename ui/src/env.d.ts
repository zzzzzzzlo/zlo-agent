import type { WindowApi } from '../electron/window-api'
import type { DesktopHostApi } from '../../host/src/contracts/desktop.ts'

declare global {
  interface Window {
    desktopWindow?: WindowApi
    agentHost?: DesktopHostApi
  }
}
