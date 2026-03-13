import { describe, it, expect } from 'vitest'
import { REUSED_COMPONENTS, threadWsChannel, forwardMessage } from './ChatThreadTab.js'

describe('ChatThreadTab', () => {
  describe('§3.5 — Chat Thread Tab', () => {
    it('§3.5 — reuses existing ChatView, InputArea, MessageBubble, MarkdownContent, WorkSection', () => {
      expect(REUSED_COMPONENTS).toEqual(['ChatView', 'InputArea', 'MessageBubble', 'MarkdownContent', 'WorkSection'])
    })

    it('§3.5 — subscribes to chat WS channel scoped to active thread key', () => {
      expect(threadWsChannel('main')).toBe('chat:thread:main')
      expect(threadWsChannel('feature-123')).toBe('chat:thread:feature-123')
    })

    it('§3.5 — supports message forwarding', () => {
      const result = forwardMessage('msg-1', 'thread-a', 'thread-b')
      expect(result).toEqual({
        sourceChannel: 'chat:thread:thread-a',
        targetChannel: 'chat:thread:thread-b',
        messageId: 'msg-1'
      })
    })
  })
})
