import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { QueuedMessage } from '@sovereign/core'
import { initChatStore, messageQueue, setMessageQueue, sendMessage, cancelMessage, _resetState } from './store.js'

function createMockWs() {
  const handlers = new Map<string, Set<(msg: any) => void>>()
  return {
    connected: () => true,
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    on(type: string, handler: (msg: any) => void) {
      if (!handlers.has(type)) handlers.set(type, new Set())
      handlers.get(type)!.add(handler)
      return () => {
        handlers.get(type)?.delete(handler)
      }
    },
    send: vi.fn(),
    close: vi.fn(),
    _emit(type: string, msg: any) {
      handlers.get(type)?.forEach((h) => h(msg))
    }
  }
}

describe('Chat Queue Client', () => {
  let ws: ReturnType<typeof createMockWs>
  let cleanup: (() => void) | void

  beforeEach(() => {
    _resetState()
    ws = createMockWs()
    ;(globalThis as any).document = {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
    cleanup = initChatStore(() => 'main', ws as any)
  })

  afterEach(() => {
    if (cleanup) cleanup()
  })

  describe('queue signal', () => {
    it('should update messageQueue signal on queue setter', () => {
      const queue: QueuedMessage[] = [
        { id: '1', threadKey: 'main', text: 'hello', timestamp: 1, status: 'queued' }
      ]
      setMessageQueue(queue)
      expect(messageQueue()).toHaveLength(1)
      expect(messageQueue()[0].text).toBe('hello')
    })

    it('should clear queue for thread on thread switch', () => {
      setMessageQueue([
        { id: '1', threadKey: 'main', text: 'hello', timestamp: 1, status: 'queued' }
      ])
      expect(messageQueue()).toHaveLength(1)
      _resetState()
      expect(messageQueue()).toHaveLength(0)
    })
  })

  describe('sendMessage', () => {
    it('should send chat.send via WS without creating optimistic turn', () => {
      sendMessage('hello')
      expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.send', text: 'hello' }))
    })
  })

  describe('cancelMessage', () => {
    it('should send chat.cancel with message ID via WS', () => {
      cancelMessage('msg-1')
      expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.cancel', id: 'msg-1' }))
    })
  })
})
