import { describe, it } from 'vitest'

describe('Phase 3 Integration', () => {
  describe('config → module integration', () => {
    it.todo('config change via API → module picks up new value')
    it.todo('change terminal.shell → terminal module uses new shell on next session')
  })

  describe('WebSocket end-to-end', () => {
    it.todo('channel registration → subscribe → bus event → client receives typed message')
    it.todo('rejects connection without valid auth token')
    it.todo('subscribe to unregistered channel returns error')
    it.todo('client message with unregistered type returns error')
  })

  describe('terminal binary', () => {
    it.todo('client sends binary input → terminal processes → binary output received')
  })

  describe('disconnect callbacks', () => {
    it.todo('terminal client disconnects → onDisconnect fires → grace period starts')
  })

  describe('REST auth', () => {
    it.todo('GET /api/config requires auth')
    it.todo('PATCH /api/config requires auth')
    it.todo('GET /api/config/schema requires auth')
    it.todo('GET /api/config/history requires auth')
    it.todo('POST /api/config/export requires auth')
    it.todo('POST /api/config/import requires auth')
  })
})
