// Client → server presence emitter. Tells the server which thread this tab
// currently has focused so it can suppress push notifications + decide
// whether to bump unreadCount on a finished turn.
//
// Lifecycle:
//   - threadKey signal changes → thread.focus { threadId }
//   - document hidden → thread.blur
//   - document visible again → thread.focus (current threadKey)
//   - window close → server-side ws.disconnected fires → presence clears
//
// We also re-send focus on every WS reconnect so the server's in-memory
// presence map survives daemon restarts.

import { createEffect } from 'solid-js'
import type { Accessor } from 'solid-js'
import type { WsStore } from '../../ws/ws-store.js'
import { dismissThreadNotification } from '../../lib/push.js'

export function initPresence(threadKey: Accessor<string>, ws: WsStore): () => void {
  let lastSent = ''

  const send = (msg: { type: 'thread.focus' | 'thread.blur'; threadId?: string }): void => {
    ws.send(msg as any)
  }

  const announceFocus = (): void => {
    const id = threadKey()
    if (!id || id === lastSent) return
    send({ type: 'thread.focus', threadId: id })
    lastSent = id
    dismissThreadNotification(id)
  }

  const announceBlur = (): void => {
    send({ type: 'thread.blur' })
    lastSent = ''
  }

  // Subscribe to the presence channel so the server accepts our messages.
  ws.subscribe(['presence'])

  // 1. Track threadKey changes
  createEffect(() => {
    const id = threadKey()
    if (id && id !== lastSent) {
      send({ type: 'thread.focus', threadId: id })
      lastSent = id
      dismissThreadNotification(id)
    }
  })

  // 2. Track tab visibility — losing focus = blur, regaining = re-focus
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') announceFocus()
    else announceBlur()
  }
  document.addEventListener('visibilitychange', onVisibility)

  // 3. Track window focus loss explicitly (covers tab-switch without
  // visibility change on some platforms)
  const onWindowBlur = (): void => announceBlur()
  const onWindowFocus = (): void => announceFocus()
  window.addEventListener('blur', onWindowBlur)
  window.addEventListener('focus', onWindowFocus)

  // 4. WS reconnect: re-declare focus. The server clears presence on
  // ws.disconnected, so a reconnect needs a fresh focus message.
  // resubscribe() in ws-store already replays channel subscriptions;
  // we only need to re-send the focus message.
  const offReconnect = ws.on('ws.reconnected', () => {
    lastSent = ''
    const id = threadKey()
    if (id) send({ type: 'thread.focus', threadId: id })
  })

  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('blur', onWindowBlur)
    window.removeEventListener('focus', onWindowFocus)
    offReconnect()
  }
}
