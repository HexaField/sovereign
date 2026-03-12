import { describe, it, expect } from 'vitest'
import { encodeBinaryFrame, decodeBinaryFrame } from './binary.js'

describe('Binary Frames', () => {
  it('encodes channel ID as 1-byte prefix', () => {
    const frame = encodeBinaryFrame(42, Buffer.from('hello'))
    expect(frame[0]).toBe(42)
    expect(frame.length).toBe(6)
  })

  it('decodes channel ID from first byte', () => {
    const frame = encodeBinaryFrame(7, Buffer.from('data'))
    const { channelId } = decodeBinaryFrame(frame)
    expect(channelId).toBe(7)
  })

  it('preserves payload through encode/decode round-trip', () => {
    const payload = Buffer.from([1, 2, 3, 4, 5])
    const frame = encodeBinaryFrame(1, payload)
    const decoded = decodeBinaryFrame(frame)
    expect(Buffer.compare(decoded.payload, payload)).toBe(0)
  })

  it('handles empty payload', () => {
    const frame = encodeBinaryFrame(1, Buffer.alloc(0))
    const decoded = decodeBinaryFrame(frame)
    expect(decoded.payload.length).toBe(0)
    expect(decoded.channelId).toBe(1)
  })

  it('handles max channel ID (255)', () => {
    const frame = encodeBinaryFrame(255, Buffer.from('x'))
    const decoded = decodeBinaryFrame(frame)
    expect(decoded.channelId).toBe(255)
  })
})
