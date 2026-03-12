import { describe, it, expect } from 'vitest'
import { isWsMessage, isWsSubscribe, isWsError, validateMessage } from './protocol.js'

describe('WS Protocol', () => {
  describe('isWsMessage', () => {
    it('returns true for valid message with type field', () => {
      expect(isWsMessage({ type: 'ping' })).toBe(true)
    })
    it('returns false for null', () => {
      expect(isWsMessage(null)).toBe(false)
    })
    it('returns false for object without type', () => {
      expect(isWsMessage({ data: 'hello' })).toBe(false)
    })
    it('returns false for non-object', () => {
      expect(isWsMessage('string')).toBe(false)
      expect(isWsMessage(42)).toBe(false)
    })
  })

  describe('isWsSubscribe', () => {
    it('returns true for valid subscribe message', () => {
      expect(isWsSubscribe({ type: 'subscribe', channels: ['status'] })).toBe(true)
    })
    it('returns false for message with wrong type', () => {
      expect(isWsSubscribe({ type: 'ping', channels: [] })).toBe(false)
    })
    it('returns false for subscribe without channels array', () => {
      expect(isWsSubscribe({ type: 'subscribe' })).toBe(false)
    })
  })

  describe('isWsError', () => {
    it('returns true for valid error message', () => {
      expect(isWsError({ type: 'error', code: 'AUTH_FAIL', message: 'bad token' })).toBe(true)
    })
    it('returns false for error without code', () => {
      expect(isWsError({ type: 'error', message: 'bad' })).toBe(false)
    })
    it('returns false for error without message', () => {
      expect(isWsError({ type: 'error', code: 'X' })).toBe(false)
    })
  })

  describe('validateMessage', () => {
    it('returns valid for well-formed message', () => {
      expect(validateMessage({ type: 'ping' })).toEqual({ valid: true })
    })
    it('returns invalid with error for missing type', () => {
      const r = validateMessage({ data: 'hi' })
      expect(r.valid).toBe(false)
      expect(r.error).toBeDefined()
    })
    it('returns invalid for non-JSON-serializable content', () => {
      const circular: Record<string, unknown> = { type: 'test' }
      circular.self = circular
      const r = validateMessage(circular)
      expect(r.valid).toBe(false)
    })
  })
})
