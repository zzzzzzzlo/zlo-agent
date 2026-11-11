import type { WindowApi } from '../electron/window-api'
import type { DesktopHostApi } from '../../shared/contracts/desktop.ts'
import type { DesktopManagementApi } from '../../shared/contracts/management.ts'
import type { DesktopChatGptApi } from '../../shared/contracts/chatgpt.ts'

declare global {
  interface Window {
    desktopWindow?: WindowApi
    agentHost?: DesktopHostApi
    agentManagement?: DesktopManagementApi
    agentChatGpt?: DesktopChatGptApi
  }
}
