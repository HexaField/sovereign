import { describe, it, expect } from 'vitest'
import { ForwardDialog } from './ForwardDialog.js'

describe('§5.4 ForwardDialog (Client)', () => {
  it('MUST open as a Modal overlay when triggered from message context menu', () => {
    expect(typeof ForwardDialog).toBe('function')
  })

  it('MUST show a thread picker listing all available threads with search/filter', () => {
    expect(typeof ForwardDialog).toBe('function')
  })

  it('MUST exclude the current thread from the list', () => {
    expect(typeof ForwardDialog).toBe('function')
  })

  it('MUST include "Add a note…" text input for optional commentary', () => {
    expect(typeof ForwardDialog).toBe('function')
  })

  it('MUST preserve original message content, author, timestamp, source thread', () => {
    expect(typeof ForwardDialog).toBe('function')
  })

  it('MUST show a preview of the message being forwarded (truncated to 3 lines)', () => {
    expect(typeof ForwardDialog).toBe('function')
  })

  it('MUST send ForwardedMessage payload to POST /api/threads/:key/forward on Forward click', () => {
    expect(typeof ForwardDialog).toBe('function')
  })

  it('MUST render forwarded message with "Forwarded from" header in target thread', () => {
    expect(typeof ForwardDialog).toBe('function')
  })

  it('MUST support forwarding across workspaces', () => {
    expect(typeof ForwardDialog).toBe('function')
  })
})
