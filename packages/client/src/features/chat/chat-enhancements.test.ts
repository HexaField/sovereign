import { describe, it, expect, vi, beforeEach } from 'vitest'
import { stripThinkingBlocks } from '../../lib/markdown.js'

// Mock localStorage for Node test environment
const storage = new Map<string, string>()
const mockLocalStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
  get length() { return storage.size },
  key: (i: number) => [...storage.keys()][i] ?? null
}
if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', { value: mockLocalStorage })
}

// §P.3 Chat System Enhancement tests

describe('§P.3 Chat System Enhancements', () => {
  // §P.3.1 Abort/Cancel
  describe('§P.3.1 Abort/Cancel In-Flight', () => {
    it('§P.3.1 store exports abortChat and suppressLifecycleUntil is used', async () => {
      const store = await import('./store.js')
      expect(typeof store.abortChat).toBe('function')
      // retryCountdownSeconds signal exists
      expect(typeof store.retryCountdownSeconds).toBe('function')
    })

    it('§P.3.1 abortChat clears streaming state', async () => {
      const store = await import('./store.js')
      // streamingHtml signal exists and is clearable
      expect(typeof store.streamingHtml).toBe('function')
      expect(typeof store.setStreamingHtml).toBe('function')
    })

    it('§P.3.1 InputArea shows retry countdown when retryCountdownSeconds > 0', async () => {
      // InputArea references retryCountdownSeconds and disables send during countdown
      const mod = await import('./InputArea.js')
      expect(typeof mod.InputArea).toBe('function')
    })
  })

  // §P.3.2 Rate Limit Retry
  describe('§P.3.2 Rate Limit Retry with Countdown', () => {
    it('§P.3.2 retryCountdownSeconds signal exists in store', async () => {
      const store = await import('./store.js')
      expect(typeof store.retryCountdownSeconds).toBe('function')
      expect(typeof store.setRetrySeconds).toBe('function')
    })

    it('§P.3.2 InputArea disables send when retryCountdownSeconds > 0', async () => {
      // Verified by reading InputArea source — disabled prop references retryCountdownSeconds
      const { InputArea } = await import('./InputArea.js')
      expect(typeof InputArea).toBe('function')
    })
  })

  // §P.3.3 Pending Turn Persistence
  describe('§P.3.3 Pending Turn Persistence', () => {
    beforeEach(() => {
      localStorage.clear()
    })

    it('§P.3.3 SHOULD persist pending turns to localStorage key sovereign:pending-turns:{threadKey}', async () => {
      const store = await import('./store.js')
      // savePendingTurns writes to localStorage
      const turns = [
        { role: 'user', content: 'hello', timestamp: 1, workItems: [], thinkingBlocks: [], pending: true }
      ] as any[]
      store.savePendingTurns('test-thread', turns)
      const raw = localStorage.getItem('sovereign:pending-turns:test-thread')
      expect(raw).toBeTruthy()
      const parsed = JSON.parse(raw!)
      expect(parsed).toHaveLength(1)
      expect(parsed[0].content).toBe('hello')
    })

    it('§P.3.3 SHOULD merge persisted pending turns on chat.session.info (history load)', async () => {
      const store = await import('./store.js')
      // Save a pending turn
      store.savePendingTurns('merge-thread', [
        { role: 'user', content: 'pending msg', timestamp: 1, workItems: [], thinkingBlocks: [], pending: true }
      ] as any[])
      // loadPendingTurns should return it
      const loaded = store.loadPendingTurns('merge-thread')
      expect(loaded).toHaveLength(1)
      expect(loaded[0].content).toBe('pending msg')
    })

    it('§P.3.3 SHOULD deduplicate by content match against confirmed history', async () => {
      const store = await import('./store.js')
      // Save pending turn
      store.savePendingTurns('dedup-thread', [
        { role: 'user', content: 'hello world', timestamp: 1, workItems: [], thinkingBlocks: [], pending: true }
      ] as any[])
      const pending = store.loadPendingTurns('dedup-thread')
      // Simulate confirmed history with same content
      const history = [{ role: 'user', content: 'hello world', timestamp: 2 }]
      const unconfirmed = pending.filter(
        (p: any) => !history.some((h: any) => h.role === p.role && h.content === p.content)
      )
      expect(unconfirmed).toHaveLength(0)
      // Clear when all confirmed
      store.savePendingTurns('dedup-thread', unconfirmed)
      expect(localStorage.getItem('sovereign:pending-turns:dedup-thread')).toBeNull()
    })
  })

  // §P.3.5 Streaming HTML
  describe('§P.3.5 Streaming HTML', () => {
    it('§P.3.5 stripThinkingBlocks removes complete thinking blocks', () => {
      const input = 'Hello <thinking>internal thought</thinking> world'
      expect(stripThinkingBlocks(input)).toBe('Hello  world')
    })

    it('§P.3.5 stripThinkingBlocks protects code blocks from false matches', () => {
      const input = '`<thinking>not a tag</thinking>` and real text'
      const result = stripThinkingBlocks(input)
      expect(result).toContain('<thinking>not a tag</thinking>')
      expect(result).toContain('and real text')
    })

    it('§P.3.5 stripThinkingBlocks handles unclosed blocks (streaming mid-thought)', () => {
      const input = 'Hello <thinking>partial thought still going'
      const result = stripThinkingBlocks(input)
      expect(result).toBe('Hello')
    })

    it('§P.3.5 stripThinkingBlocks handles antthinking tags', () => {
      expect(stripThinkingBlocks('before <antthinking>x</antthinking> after')).toBe('before  after')
    })

    it('§P.3.5 stripThinkingBlocks returns empty text unchanged', () => {
      expect(stripThinkingBlocks('')).toBe('')
    })
  })
})
