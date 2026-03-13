import { describe, it } from 'vitest'

describe('§2.4 Chat Module (Server)', () => {
  it.todo('MUST register WS channel chat on the Phase 3 WS protocol')
  it.todo('MUST proxy chat.send to backend.sendMessage(sessionKey, text, attachments)')
  it.todo('MUST proxy chat.abort to backend.abort(sessionKey)')
  it.todo('MUST proxy chat.history to backend.getHistory(sessionKey) and respond with chat.session.info')
  it.todo('MUST proxy chat.session.switch to backend.switchSession(sessionKey)')
  it.todo('MUST proxy chat.session.create to backend.createSession(label)')
  it.todo('MUST proxy chat.stream events to subscribed clients via WS')
  it.todo('MUST proxy chat.turn events to subscribed clients via WS')
  it.todo('MUST proxy chat.status events to subscribed clients via WS')
  it.todo('MUST proxy chat.work events to subscribed clients via WS')
  it.todo('MUST proxy chat.compacting events to subscribed clients via WS')
  it.todo('MUST proxy chat.error events to subscribed clients via WS')
  it.todo('MUST proxy chat.session.info events to subscribed clients via WS')
  it.todo(
    'MUST respect Phase 3 WS scoping — client subscribed with threadKey scope only receives events for that thread'
  )
  it.todo('MUST emit chat.message.sent bus event when a user sends a message')
  it.todo('MUST emit chat.turn.completed bus event when the agent completes a turn')
  it.todo('MUST create a corresponding backend session when a new thread is created')
  it.todo('MUST look up backend session key for given thread key on chat.session.switch')
  it.todo('MUST persist session mapping to {dataDir}/chat/session-map.json using atomic write')
  it.todo('MUST restore session mapping from disk on server restart')
})
