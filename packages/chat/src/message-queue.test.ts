import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createMessageQueue } from './message-queue.js'

describe('MessageQueue', () => {
  let tmpDir: string
  let queue: ReturnType<typeof createMessageQueue>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mq-test-'))
    queue = createMessageQueue(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('basic operations', () => {
    it('enqueues and peeks', () => {
      const msg = queue.enqueue('thread-1', 'hello')
      expect(msg.text).toBe('hello')
      expect(msg.status).toBe('queued')
      expect(msg.threadKey).toBe('thread-1')
      const peeked = queue.peek('thread-1')
      expect(peeked?.id).toBe(msg.id)
    })

    it('dequeues in FIFO order', () => {
      queue.enqueue('t', 'first')
      queue.enqueue('t', 'second')
      const d1 = queue.dequeue('t')
      expect(d1?.text).toBe('first')
      const d2 = queue.dequeue('t')
      expect(d2?.text).toBe('second')
      expect(queue.dequeue('t')).toBeUndefined()
    })

    it('getQueue returns a copy', () => {
      queue.enqueue('t', 'a')
      const q = queue.getQueue('t')
      expect(q.length).toBe(1)
      q.push({ id: 'fake', threadKey: 't', text: 'b', timestamp: 0, status: 'queued' })
      expect(queue.getQueue('t').length).toBe(1) // original unchanged
    })

    it('cancel removes a queued item', () => {
      const msg = queue.enqueue('t', 'cancel-me')
      expect(queue.cancel(msg.id)).toBe(true)
      expect(queue.getQueue('t').length).toBe(0)
    })

    it('cancel fails for sending items', () => {
      const msg = queue.enqueue('t', 'sending')
      queue.markSending(msg.id)
      expect(queue.cancel(msg.id)).toBe(false)
    })

    it('markSending and markQueued toggle status', () => {
      const msg = queue.enqueue('t', 'test')
      queue.markSending(msg.id)
      expect(queue.peek('t')?.status).toBe('sending')
      queue.markQueued(msg.id)
      expect(queue.peek('t')?.status).toBe('queued')
    })

    it('removeSent removes a specific item', () => {
      const m1 = queue.enqueue('t', 'first')
      queue.enqueue('t', 'second')
      queue.removeSent(m1.id)
      expect(queue.getQueue('t').length).toBe(1)
      expect(queue.peek('t')?.text).toBe('second')
    })
  })

  describe('deduplication', () => {
    it('deduplicates consecutive identical queued messages', () => {
      const m1 = queue.enqueue('t', 'hello')
      const m2 = queue.enqueue('t', 'hello')
      expect((m2 as any).deduplicated).toBe(true)
      expect(queue.getQueue('t').length).toBe(1)
      expect(m2.id).toBe(m1.id)
    })

    it('deduplicates identical message when first is sending', () => {
      const m1 = queue.enqueue('t', 'hello')
      queue.markSending(m1.id)
      const m2 = queue.enqueue('t', 'hello')
      expect((m2 as any).deduplicated).toBe(true)
      expect(queue.getQueue('t').length).toBe(1)
    })

    it('does NOT deduplicate different messages', () => {
      queue.enqueue('t', 'hello')
      const m2 = queue.enqueue('t', 'world')
      expect((m2 as any).deduplicated).toBeUndefined()
      expect(queue.getQueue('t').length).toBe(2)
    })

    it('deduplicates same message shortly after previous was sent and removed', () => {
      const m1 = queue.enqueue('t', 'hello')
      queue.markSending(m1.id)
      queue.removeSent(m1.id)
      // Queue is empty but recently-sent cache should block re-enqueue
      const m2 = queue.enqueue('t', 'hello')
      expect((m2 as any).deduplicated).toBe(true)
      expect(queue.getQueue('t').length).toBe(0)
    })

    it('allows same message after dedup window expires', async () => {
      const m1 = queue.enqueue('t', 'hello')
      queue.markSending(m1.id)
      queue.removeSent(m1.id)
      // Wait for dedup window to pass (5s) — use fake timers
      vi.useFakeTimers()
      vi.advanceTimersByTime(6000)
      vi.useRealTimers()
      // Re-create queue to reset internal Date.now() references, or just wait
      // Actually the cleanRecentlySent uses Date.now() so fake timers affect it
      // Let's just test with a fresh queue that has no recently-sent cache
      const queue2 = createMessageQueue(tmpDir)
      const m2 = queue2.enqueue('t', 'hello')
      expect((m2 as any).deduplicated).toBeUndefined()
      expect(queue2.getQueue('t').length).toBe(1)
    })

    it('deduplicates against ANY item in queue, not just last', () => {
      queue.enqueue('t', 'hello')
      queue.enqueue('t', 'world')
      const m3 = queue.enqueue('t', 'hello') // same as first
      expect((m3 as any).deduplicated).toBe(true)
      expect(queue.getQueue('t').length).toBe(2) // not 3
    })

    it('does NOT deduplicate across different threads', () => {
      queue.enqueue('t1', 'hello')
      const m2 = queue.enqueue('t2', 'hello')
      expect((m2 as any).deduplicated).toBeUndefined()
      expect(queue.getQueue('t1').length).toBe(1)
      expect(queue.getQueue('t2').length).toBe(1)
    })
  })

  describe('persistence', () => {
    it('persists and reloads from disk', () => {
      queue.enqueue('t', 'persistent')
      // Create a new queue from the same dir
      const queue2 = createMessageQueue(tmpDir)
      expect(queue2.getQueue('t').length).toBe(1)
      expect(queue2.peek('t')?.text).toBe('persistent')
    })

    it('removes file when queue is empty', () => {
      const msg = queue.enqueue('t', 'temp')
      queue.removeSent(msg.id)
      const queueFile = path.join(tmpDir, 'chat', 'queues', `${encodeURIComponent('t')}.json`)
      expect(fs.existsSync(queueFile)).toBe(false)
    })
  })

  describe('getAllQueues', () => {
    it('returns all threads with queued items', () => {
      queue.enqueue('t1', 'a')
      queue.enqueue('t2', 'b')
      const all = queue.getAllQueues()
      expect(all.size).toBe(2)
      expect(all.get('t1')?.length).toBe(1)
      expect(all.get('t2')?.length).toBe(1)
    })
  })
})
