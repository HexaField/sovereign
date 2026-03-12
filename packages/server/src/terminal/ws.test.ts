import { describe, it } from 'vitest'

describe('Terminal WS Channel', () => {
  describe('channel registration', () => {
    it.todo('registers terminal channel with correct server message types')
    it.todo('registers terminal channel with correct client message types')
    it.todo('registers terminal channel with binary support')
  })

  describe('bus → WS bridge', () => {
    it.todo('bridges terminal.created bus event to terminal.created WS message')
    it.todo('bridges terminal.closed bus event to terminal.closed WS message')
    it.todo('terminal data bypasses bus — direct binary push')
  })

  describe('client → server', () => {
    it.todo('handles terminal.input binary frames')
    it.todo('handles terminal.resize message')
  })

  describe('subscription scoping', () => {
    it.todo('scopes messages by sessionId')
    it.todo('onSubscribe attaches client to terminal session')
  })

  describe('disconnect', () => {
    it.todo('onUnsubscribe detaches client from terminal session')
    it.todo('onDisconnect starts grace period close')
  })

  describe('binary frames', () => {
    it.todo('sends terminal output as binary frame with channel ID prefix')
    it.todo('receives terminal input as binary frame')
    it.todo('binary round-trip preserves data')
  })
})
