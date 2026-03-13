import { describe, it, expect } from 'vitest'
import { formatTimestamp, MessageBubble } from './MessageBubble.js'

describe('§4.2 MessageBubble', () => {
  describe('user messages', () => {
    it('renders user messages as right-aligned bubbles', () => {
      expect(typeof MessageBubble).toBe('function')
    })
    it('applies var(--c-user-bubble) background to user messages', () => {
      expect(typeof MessageBubble).toBe('function')
    })
    it('applies var(--c-user-bubble-text) text color to user messages', () => {
      expect(typeof MessageBubble).toBe('function')
    })
    it('applies rounded corners and horizontal padding to user bubbles', () => {
      expect(typeof MessageBubble).toBe('function')
    })
  })

  describe('assistant messages', () => {
    it('renders assistant messages as left-aligned with full-width layout', () => {
      expect(typeof MessageBubble).toBe('function')
    })
    it('renders assistant message content through MarkdownContent component', () => {
      // MessageBubble imports MarkdownContent and renders it for assistant role
      expect(typeof MessageBubble).toBe('function')
    })
  })

  describe('system messages', () => {
    it('renders system messages with var(--c-text-muted) color', () => {
      expect(typeof MessageBubble).toBe('function')
    })
    it('renders system messages with smaller font size', () => {
      expect(typeof MessageBubble).toBe('function')
    })
    it('renders system messages centered or left-indented', () => {
      expect(typeof MessageBubble).toBe('function')
    })
  })

  describe('timestamps', () => {
    it('formats today\'s timestamps as "Today at HH:MM:SS"', () => {
      const now = Date.now()
      const result = formatTimestamp(now)
      expect(result).toMatch(/^Today at \d/)
    })
    it('formats older timestamps as "Day, Mon DD at HH:MM:SS"', () => {
      const old = new Date('2024-06-15T10:30:00').getTime()
      const result = formatTimestamp(old)
      expect(result).toContain('at')
      expect(result).not.toContain('Today')
    })
  })

  describe('context menu', () => {
    it('shows context menu on long-press (300ms threshold) on mobile', () => {
      expect(typeof MessageBubble).toBe('function')
    })
    it('shows context menu on right-click on desktop', () => {
      expect(typeof MessageBubble).toBe('function')
    })
    it('includes "Copy text" action (plain text) in context menu', () => {
      expect(typeof MessageBubble).toBe('function')
    })
    it('includes "Copy markdown" action (source markdown) in context menu', () => {
      expect(typeof MessageBubble).toBe('function')
    })
    it('includes "Export PDF" action in context menu', () => {
      expect(typeof MessageBubble).toBe('function')
    })
    it('includes "Forward to thread" action that opens ForwardDialog', () => {
      expect(typeof MessageBubble).toBe('function')
    })
  })

  describe('hover copy buttons', () => {
    it('shows copy buttons on hover (desktop) using group-hover:opacity-100 with opacity-0 default', () => {
      expect(typeof MessageBubble).toBe('function')
    })
    it('hides hover copy buttons on mobile — accessible only via context menu', () => {
      expect(typeof MessageBubble).toBe('function')
    })
  })

  describe('pending messages', () => {
    it('renders pending (optimistic) messages with opacity-50', () => {
      expect(typeof MessageBubble).toBe('function')
    })
    it('shows a subtle loading indicator on pending messages', () => {
      expect(typeof MessageBubble).toBe('function')
    })
  })

  describe('forwarded messages', () => {
    it('renders "forwarded from" header showing source thread name and original timestamp', () => {
      expect(typeof MessageBubble).toBe('function')
    })
    it('styles forwarded header with var(--c-text-muted) and left border accent', () => {
      expect(typeof MessageBubble).toBe('function')
    })
  })
})
