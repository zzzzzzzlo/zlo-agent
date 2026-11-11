import type { ModelCatalogEntry } from './domain.ts'

/** Private credential hand-off between Electron Main and the bundled Host. */
export interface ChatGptSession {
  profileId: string
  accessToken: string
  expiresAt: number
  models: string[]
}

/** Private Main-to-Host DTO. Excluded from the desktop API below. */
export interface ChatGptSession {
  profileId: string
  accessToken: string
  expiresAt: number
  models: string[]
}

export interface ChatGptStatus {
  available: true
  state: 'signed_out' | 'connected' | 'reauthorization_required'
  profiles: { id: string; label: string }[]
  activeProfileId?: string
  models: ModelCatalogEntry[]
  remoteRevocationConfirmed?: boolean
}

export interface DesktopChatGptApi {
  status(): Promise<ChatGptStatus>
  signIn(input: { profileId?: string }): Promise<ChatGptStatus>
  cancelSignIn(): Promise<void>
  signOut(): Promise<ChatGptStatus>
}
