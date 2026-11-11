import { useCallback, useEffect, useRef, useState } from 'react'
import type { ModelRoute } from '../../../../shared/contracts/desktop.ts'
import type { ManagementSnapshot } from '../../../../shared/contracts/management.ts'

export function useManagementSnapshot(ready: boolean, conversationId?: string, live = false, revision?: string) {
  const api = globalThis.window?.agentManagement
  const [state, setState] = useState<{
    conversationId?: string
    snapshot?: ManagementSnapshot
    error?: string
  }>({})
  const request = useRef(0)
  const refresh = useCallback(async () => {
    if (!api || !ready) return
    const id = ++request.current
    try {
      const snapshot = await api.snapshot(conversationId ? { conversationId } : {})
      if (id === request.current) setState({ conversationId, snapshot })
    } catch (error) {
      if (id === request.current) {
        setState({ conversationId, error: managementError(error) })
      }
    }
  }, [api, ready, conversationId])

  useEffect(() => {
    if (ready) void refresh()
    else setState({})
    return () => { request.current++ }
  }, [ready, refresh, revision])

  useEffect(() => {
    if (!live || !ready) return
    let stopped = false
    let timer = setTimeout(poll, 2000)
    async function poll() {
      await refresh()
      if (!stopped) timer = setTimeout(poll, 2000)
    }
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [live, ready, refresh])

  const current = state.conversationId === conversationId ? state : undefined
  return { api, refresh, snapshot: ready ? current?.snapshot : undefined, error: ready ? current?.error : undefined }
}

export function managementError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
  }
  return '桌面管理请求失败，请重试。'
}

export function routeKey(route?: ModelRoute | null): string {
  return route ? route.provider + '/' + route.model : ''
}

export function routeDisplayLabel(route?: ModelRoute | null): string {
  if (!route) return '未设置模型'
  return route.provider.startsWith('chatgpt-') ? 'ChatGPT / ' + route.model : routeKey(route)
}
