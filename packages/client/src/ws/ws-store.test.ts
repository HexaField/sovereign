import { describe, it } from 'vitest'

describe('WsStore', () => {
  describe('connection state', () => {
    it.todo('starts as disconnected')
    it.todo('connected returns true when WebSocket is open')
    it.todo('connected returns false when WebSocket closes')
  })

  describe('subscribe/unsubscribe', () => {
    it.todo('sends subscribe message to server')
    it.todo('sends unsubscribe message to server')
    it.todo('re-subscribes to all active channels on reconnect')
  })

  describe('message handling', () => {
    it.todo('on registers handler for message type')
    it.todo('on returns unsubscribe function')
    it.todo('dispatches incoming message to registered handlers')
    it.todo('does not dispatch to removed handlers')
  })

  describe('send', () => {
    it.todo('sends message through WebSocket')
    it.todo('queues message if not connected')
  })
})
