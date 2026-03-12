import { describe, it } from 'vitest'

describe('WS Protocol', () => {
  describe('isWsMessage', () => {
    it.todo('returns true for valid message with type field')
    it.todo('returns false for null')
    it.todo('returns false for object without type')
    it.todo('returns false for non-object')
  })

  describe('isWsSubscribe', () => {
    it.todo('returns true for valid subscribe message')
    it.todo('returns false for message with wrong type')
    it.todo('returns false for subscribe without channels array')
  })

  describe('isWsError', () => {
    it.todo('returns true for valid error message')
    it.todo('returns false for error without code')
    it.todo('returns false for error without message')
  })

  describe('validateMessage', () => {
    it.todo('returns valid for well-formed message')
    it.todo('returns invalid with error for missing type')
    it.todo('returns invalid for non-JSON-serializable content')
  })
})
