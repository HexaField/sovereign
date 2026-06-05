// Server-side FIFO message queue per thread
// In-memory for speed, persisted to disk for durability
//
// This is the canonical place a user's outbound chat message lives between
// "user pressed send" and "agent acknowledged". Adapters never see it; they
// receive a single direct call from the dispatch loop in chat.ts.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { QueuedMessage } from '@sovereign/core'

export type { QueuedMessage }

export type QueueChangeReason = 'enqueued' | 'sending' | 'sent' | 'failed' | 'requeued' | 'cancelled'

export interface QueueChange {
  threadId: string
  reason: QueueChangeReason
  item?: QueuedMessage
}

export type QueueChangeListener = (change: QueueChange) => void

export interface MessageQueue {
  enqueue(threadId: string, text: string): QueuedMessage & { deduplicated?: boolean }
  dequeue(threadId: string): QueuedMessage | undefined
  cancel(id: string): boolean
  peek(threadId: string): QueuedMessage | undefined
  getQueue(threadId: string): QueuedMessage[]
  markSending(id: string): boolean
  markQueued(id: string): boolean
  markFailed(id: string, error: string): boolean
  removeSent(id: string): void
  getAllQueues(): Map<string, QueuedMessage[]>
  /** Snapshot of one thread's queue (always a fresh array). */
  snapshot(threadId: string): QueuedMessage[]
  /** Subscribe to queue-change notifications. Returns unsubscribe. */
  onChange(listener: QueueChangeListener): () => void
}

export function createMessageQueue(dataDir: string): MessageQueue {
  const queueDir = path.join(dataDir, 'chat', 'queues')
  fs.mkdirSync(queueDir, { recursive: true })

  const queues = new Map<string, QueuedMessage[]>()
  const listeners = new Set<QueueChangeListener>()

  function notify(change: QueueChange): void {
    for (const fn of listeners) {
      try {
        fn(change)
      } catch (err) {
        console.error('[message-queue] listener error:', err)
      }
    }
  }

  // Track recently sent messages to prevent re-enqueue of identical text after removal
  // Key: `${threadId}\0${text}`, Value: timestamp when sent
  const recentlySent = new Map<string, number>()
  const DEDUP_WINDOW_MS = 5_000 // 5 seconds

  function cleanRecentlySent(): void {
    const cutoff = Date.now() - DEDUP_WINDOW_MS
    for (const [key, ts] of recentlySent) {
      if (ts < cutoff) recentlySent.delete(key)
    }
  }

  // Load from disk on startup
  try {
    const files = fs.readdirSync(queueDir)
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const filePath = path.join(queueDir, file)
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        if (Array.isArray(data) && data.length > 0) {
          const threadId = decodeURIComponent(file.replace(/\.json$/, ''))
          queues.set(threadId, data)
        }
      } catch {
        // Corrupt file — skip
      }
    }
  } catch {
    // No directory yet — fine
  }

  function persist(threadId: string): void {
    const items = queues.get(threadId) ?? []
    const filePath = path.join(queueDir, `${encodeURIComponent(threadId)}.json`)
    if (items.length === 0) {
      try {
        fs.unlinkSync(filePath)
      } catch {
        /* ignore */
      }
      queues.delete(threadId)
      return
    }
    const tmp = filePath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(items))
    fs.renameSync(tmp, filePath)
  }

  function findById(id: string): { threadId: string; index: number } | undefined {
    for (const [threadId, items] of queues) {
      const index = items.findIndex((m) => m.id === id)
      if (index >= 0) return { threadId, index }
    }
    return undefined
  }

  return {
    enqueue(threadId: string, text: string): QueuedMessage & { deduplicated?: boolean } {
      const items = queues.get(threadId) ?? []

      // Deduplicate: skip if ANY queued/sending message has identical text
      for (const item of items) {
        if (item.text === text && (item.status === 'queued' || item.status === 'sending')) {
          return { ...item, deduplicated: true }
        }
      }

      // Deduplicate: skip if same text was recently sent (prevents re-enqueue after removeSent)
      cleanRecentlySent()
      const dedupKey = `${threadId}\0${text}`
      if (recentlySent.has(dedupKey)) {
        return {
          id: 'dedup-recent',
          threadId,
          text,
          timestamp: Date.now(),
          status: 'sending' as const,
          deduplicated: true
        }
      }

      const msg: QueuedMessage = {
        id: crypto.randomUUID(),
        threadId,
        text,
        timestamp: Date.now(),
        status: 'queued',
        attempts: 0
      }
      items.push(msg)
      queues.set(threadId, items)
      persist(threadId)
      notify({ threadId, reason: 'enqueued', item: { ...msg } })
      return msg
    },

    dequeue(threadId: string): QueuedMessage | undefined {
      const items = queues.get(threadId)
      if (!items || items.length === 0) return undefined
      const msg = items.shift()!
      persist(threadId)
      return msg
    },

    cancel(id: string): boolean {
      const found = findById(id)
      if (!found) return false
      const items = queues.get(found.threadId)!
      const msg = items[found.index]
      // Allow cancelling queued OR failed messages; never tear out an in-flight send.
      if (msg.status === 'sending') return false
      items.splice(found.index, 1)
      persist(found.threadId)
      notify({ threadId: found.threadId, reason: 'cancelled', item: { ...msg } })
      return true
    },

    peek(threadId: string): QueuedMessage | undefined {
      const items = queues.get(threadId)
      return items?.[0]
    },

    getQueue(threadId: string): QueuedMessage[] {
      return [...(queues.get(threadId) ?? [])]
    },

    markSending(id: string): boolean {
      const found = findById(id)
      if (!found) return false
      const items = queues.get(found.threadId)!
      const msg = items[found.index]
      msg.status = 'sending'
      msg.attempts = (msg.attempts ?? 0) + 1
      delete msg.error
      persist(found.threadId)
      notify({ threadId: found.threadId, reason: 'sending', item: { ...msg } })
      return true
    },

    markQueued(id: string): boolean {
      const found = findById(id)
      if (!found) return false
      const items = queues.get(found.threadId)!
      const msg = items[found.index]
      msg.status = 'queued'
      delete msg.error
      persist(found.threadId)
      notify({ threadId: found.threadId, reason: 'requeued', item: { ...msg } })
      return true
    },

    markFailed(id: string, error: string): boolean {
      const found = findById(id)
      if (!found) return false
      const items = queues.get(found.threadId)!
      const msg = items[found.index]
      msg.status = 'failed'
      msg.error = error
      persist(found.threadId)
      notify({ threadId: found.threadId, reason: 'failed', item: { ...msg } })
      return true
    },

    removeSent(id: string): void {
      const found = findById(id)
      if (!found) return
      const items = queues.get(found.threadId)!
      const msg = items[found.index]
      // Record in recently-sent cache to prevent immediate re-enqueue of same text
      recentlySent.set(`${found.threadId}\0${msg.text}`, Date.now())
      items.splice(found.index, 1)
      persist(found.threadId)
      notify({ threadId: found.threadId, reason: 'sent', item: { ...msg } })
    },

    getAllQueues(): Map<string, QueuedMessage[]> {
      const result = new Map<string, QueuedMessage[]>()
      for (const [k, v] of queues) {
        result.set(k, [...v])
      }
      return result
    },

    snapshot(threadId: string): QueuedMessage[] {
      return (queues.get(threadId) ?? []).map((m) => ({ ...m }))
    },

    onChange(listener: QueueChangeListener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
