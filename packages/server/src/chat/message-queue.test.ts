import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createMessageQueue } from './message-queue.js'
import type { MessageQueue } from './message-queue.js'

describe('MessageQueue', () => {
  let dataDir: string
  let queue: MessageQueue

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mq-test-'))
    queue = createMessageQueue(dataDir)
  })

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  describe('enqueue', () => {
    it('should create a message with unique ID and queued status', () => {
      const msg = queue.enqueue('thread-1', 'hello')
      expect(msg.id).toBeTruthy()
      expect(msg.threadKey).toBe('thread-1')
      expect(msg.text).toBe('hello')
      expect(msg.status).toBe('queued')
      expect(msg.timestamp).toBeGreaterThan(0)
    })

    it('should persist to disk immediately', () => {
      queue.enqueue('thread-1', 'hello')
      const filePath = path.join(dataDir, 'chat', 'queues', 'thread-1.json')
      expect(fs.existsSync(filePath)).toBe(true)
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      expect(data).toHaveLength(1)
      expect(data[0].text).toBe('hello')
    })

    it('should append to existing queue for same thread', () => {
      queue.enqueue('thread-1', 'first')
      queue.enqueue('thread-1', 'second')
      const items = queue.getQueue('thread-1')
      expect(items).toHaveLength(2)
      expect(items[0].text).toBe('first')
      expect(items[1].text).toBe('second')
    })

    it('should maintain FIFO order', () => {
      queue.enqueue('t', 'a')
      queue.enqueue('t', 'b')
      queue.enqueue('t', 'c')
      const items = queue.getQueue('t')
      expect(items.map((m) => m.text)).toEqual(['a', 'b', 'c'])
    })

    it('should handle concurrent enqueues to different threads', () => {
      queue.enqueue('t1', 'msg1')
      queue.enqueue('t2', 'msg2')
      expect(queue.getQueue('t1')).toHaveLength(1)
      expect(queue.getQueue('t2')).toHaveLength(1)
    })
  })

  describe('dequeue', () => {
    it('should return undefined for empty queue', () => {
      expect(queue.dequeue('empty')).toBeUndefined()
    })

    it('should return and remove the first item', () => {
      queue.enqueue('t', 'first')
      queue.enqueue('t', 'second')
      const msg = queue.dequeue('t')
      expect(msg?.text).toBe('first')
      expect(queue.getQueue('t')).toHaveLength(1)
    })

    it('should persist after dequeue', () => {
      queue.enqueue('t', 'first')
      queue.enqueue('t', 'second')
      queue.dequeue('t')
      const filePath = path.join(dataDir, 'chat', 'queues', 't.json')
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      expect(data).toHaveLength(1)
      expect(data[0].text).toBe('second')
    })

    it('should not affect other threads', () => {
      queue.enqueue('t1', 'a')
      queue.enqueue('t2', 'b')
      queue.dequeue('t1')
      expect(queue.getQueue('t2')).toHaveLength(1)
    })
  })

  describe('cancel', () => {
    it('should remove a queued message by ID and return true', () => {
      const msg = queue.enqueue('t', 'hello')
      expect(queue.cancel(msg.id)).toBe(true)
      expect(queue.getQueue('t')).toHaveLength(0)
    })

    it('should return false for non-existent ID', () => {
      expect(queue.cancel('nonexistent')).toBe(false)
    })

    it('should return false for message with sending status', () => {
      const msg = queue.enqueue('t', 'hello')
      queue.markSending(msg.id)
      expect(queue.cancel(msg.id)).toBe(false)
    })

    it('should persist after cancel', () => {
      const msg = queue.enqueue('t', 'hello')
      queue.enqueue('t', 'world')
      queue.cancel(msg.id)
      const filePath = path.join(dataDir, 'chat', 'queues', 't.json')
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      expect(data).toHaveLength(1)
      expect(data[0].text).toBe('world')
    })

    it('should not affect other messages in queue', () => {
      queue.enqueue('t', 'a')
      const msg = queue.enqueue('t', 'b')
      queue.enqueue('t', 'c')
      queue.cancel(msg.id)
      expect(queue.getQueue('t').map((m) => m.text)).toEqual(['a', 'c'])
    })
  })

  describe('peek', () => {
    it('should return the first item without removing it', () => {
      queue.enqueue('t', 'first')
      queue.enqueue('t', 'second')
      const msg = queue.peek('t')
      expect(msg?.text).toBe('first')
      expect(queue.getQueue('t')).toHaveLength(2)
    })

    it('should return undefined for empty queue', () => {
      expect(queue.peek('empty')).toBeUndefined()
    })
  })

  describe('markSending', () => {
    it('should change status from queued to sending', () => {
      const msg = queue.enqueue('t', 'hello')
      expect(queue.markSending(msg.id)).toBe(true)
      expect(queue.getQueue('t')[0].status).toBe('sending')
    })

    it('should return false for non-existent ID', () => {
      expect(queue.markSending('nonexistent')).toBe(false)
    })

    it('should persist after status change', () => {
      const msg = queue.enqueue('t', 'hello')
      queue.markSending(msg.id)
      const filePath = path.join(dataDir, 'chat', 'queues', 't.json')
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      expect(data[0].status).toBe('sending')
    })
  })

  describe('markQueued', () => {
    it('should change status back to queued', () => {
      const msg = queue.enqueue('t', 'hello')
      queue.markSending(msg.id)
      expect(queue.markQueued(msg.id)).toBe(true)
      expect(queue.getQueue('t')[0].status).toBe('queued')
    })

    it('should return false for non-existent ID', () => {
      expect(queue.markQueued('missing')).toBe(false)
    })
  })

  describe('removeSent', () => {
    it('should remove a message regardless of status', () => {
      const msg = queue.enqueue('t', 'hello')
      queue.markSending(msg.id)
      queue.removeSent(msg.id)
      expect(queue.getQueue('t')).toHaveLength(0)
    })

    it('should persist after removal', () => {
      const msg = queue.enqueue('t', 'hello')
      queue.removeSent(msg.id)
      const filePath = path.join(dataDir, 'chat', 'queues', 't.json')
      expect(fs.existsSync(filePath)).toBe(false)
    })
  })

  describe('persistence', () => {
    it('should load queues from disk on creation', () => {
      queue.enqueue('t', 'persisted')
      const queue2 = createMessageQueue(dataDir)
      expect(queue2.getQueue('t')).toHaveLength(1)
      expect(queue2.getQueue('t')[0].text).toBe('persisted')
    })

    it('should survive recreation with same dataDir', () => {
      queue.enqueue('t1', 'a')
      queue.enqueue('t2', 'b')
      const queue2 = createMessageQueue(dataDir)
      expect(queue2.getQueue('t1')[0].text).toBe('a')
      expect(queue2.getQueue('t2')[0].text).toBe('b')
    })

    it('should handle corrupt/missing files gracefully', () => {
      const queueDir = path.join(dataDir, 'chat', 'queues')
      fs.writeFileSync(path.join(queueDir, 'bad.json'), 'not json')
      const queue2 = createMessageQueue(dataDir)
      expect(queue2.getQueue('bad')).toEqual([])
    })

    it('should clean up empty queue files', () => {
      queue.enqueue('t', 'hello')
      queue.dequeue('t')
      const filePath = path.join(dataDir, 'chat', 'queues', 't.json')
      expect(fs.existsSync(filePath)).toBe(false)
    })
  })

  describe('getQueue', () => {
    it('should return empty array for unknown thread', () => {
      expect(queue.getQueue('unknown')).toEqual([])
    })

    it('should return all items for a thread in order', () => {
      queue.enqueue('t', 'a')
      queue.enqueue('t', 'b')
      queue.enqueue('t', 'c')
      const items = queue.getQueue('t')
      expect(items.map((m) => m.text)).toEqual(['a', 'b', 'c'])
    })
  })
})
