// Server-side FIFO message queue per thread
// In-memory for speed, persisted to disk for durability

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { QueuedMessage } from '@sovereign/core'

export type { QueuedMessage }

export interface MessageQueue {
  enqueue(threadKey: string, text: string): QueuedMessage
  dequeue(threadKey: string): QueuedMessage | undefined
  cancel(id: string): boolean
  peek(threadKey: string): QueuedMessage | undefined
  getQueue(threadKey: string): QueuedMessage[]
  markSending(id: string): boolean
  markQueued(id: string): boolean
  removeSent(id: string): void
  getAllQueues(): Map<string, QueuedMessage[]>
}

export function createMessageQueue(dataDir: string): MessageQueue {
  const queueDir = path.join(dataDir, 'chat', 'queues')
  fs.mkdirSync(queueDir, { recursive: true })

  const queues = new Map<string, QueuedMessage[]>()

  // Load from disk on startup
  try {
    const files = fs.readdirSync(queueDir)
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const filePath = path.join(queueDir, file)
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        if (Array.isArray(data) && data.length > 0) {
          const threadKey = decodeURIComponent(file.replace(/\.json$/, ''))
          queues.set(threadKey, data)
        }
      } catch {
        // Corrupt file — skip
      }
    }
  } catch {
    // No directory yet — fine
  }

  function persist(threadKey: string): void {
    const items = queues.get(threadKey) ?? []
    const filePath = path.join(queueDir, `${encodeURIComponent(threadKey)}.json`)
    if (items.length === 0) {
      try { fs.unlinkSync(filePath) } catch { /* ignore */ }
      queues.delete(threadKey)
      return
    }
    const tmp = filePath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(items))
    fs.renameSync(tmp, filePath)
  }

  function findById(id: string): { threadKey: string; index: number } | undefined {
    for (const [threadKey, items] of queues) {
      const index = items.findIndex((m) => m.id === id)
      if (index >= 0) return { threadKey, index }
    }
    return undefined
  }

  return {
    enqueue(threadKey: string, text: string): QueuedMessage {
      const msg: QueuedMessage = {
        id: crypto.randomUUID(),
        threadKey,
        text,
        timestamp: Date.now(),
        status: 'queued'
      }
      const items = queues.get(threadKey) ?? []
      items.push(msg)
      queues.set(threadKey, items)
      persist(threadKey)
      return msg
    },

    dequeue(threadKey: string): QueuedMessage | undefined {
      const items = queues.get(threadKey)
      if (!items || items.length === 0) return undefined
      const msg = items.shift()!
      persist(threadKey)
      return msg
    },

    cancel(id: string): boolean {
      const found = findById(id)
      if (!found) return false
      const items = queues.get(found.threadKey)!
      if (items[found.index].status !== 'queued') return false
      items.splice(found.index, 1)
      persist(found.threadKey)
      return true
    },

    peek(threadKey: string): QueuedMessage | undefined {
      const items = queues.get(threadKey)
      return items?.[0]
    },

    getQueue(threadKey: string): QueuedMessage[] {
      return [...(queues.get(threadKey) ?? [])]
    },

    markSending(id: string): boolean {
      const found = findById(id)
      if (!found) return false
      const items = queues.get(found.threadKey)!
      items[found.index].status = 'sending'
      persist(found.threadKey)
      return true
    },

    markQueued(id: string): boolean {
      const found = findById(id)
      if (!found) return false
      const items = queues.get(found.threadKey)!
      items[found.index].status = 'queued'
      persist(found.threadKey)
      return true
    },

    removeSent(id: string): void {
      const found = findById(id)
      if (!found) return
      const items = queues.get(found.threadKey)!
      items.splice(found.index, 1)
      persist(found.threadKey)
    },

    getAllQueues(): Map<string, QueuedMessage[]> {
      const result = new Map<string, QueuedMessage[]>()
      for (const [k, v] of queues) {
        result.set(k, [...v])
      }
      return result
    }
  }
}
