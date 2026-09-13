// TaskDigest — structured accumulator replacing PresenceDigest.
//
// Listens on task.* bus events instead of chat.turn.completed. Formats
// entries directly from TaskEventPayload — no text extraction, no
// markdown stripping, no 120-char truncation.
//
// Same shape as PresenceDigest (take/peek/dispose) for backward
// compatibility with the chat module's ChatPresenceHook interface.

import fs from 'node:fs'
import path from 'node:path'
import type { EventBus } from '@sovereign/core'
import type { TaskEventPayload } from './types.js'

export interface TaskDigestEntry {
  threadId: string
  threadLabel: string
  summary: string
  at: number
}

export interface TaskDigest {
  /** Returns accumulated task activity as a formatted block. Clears the
   *  buffer atomically. Returns null when empty. */
  take(): string | null
  /** Peek without clearing. */
  peek(): TaskDigestEntry[]
  /** Stop listening. Idempotent. */
  dispose(): void
}

interface TaskDigestDeps {
  bus: EventBus
  /** Resolve a thread id to a display label. */
  resolveLabel(threadId: string): string | undefined
  /** Persist buffer to this file across restarts. */
  persistFile?: string
  /** Max entries in the buffer. Defaults to 50. */
  maxEntries?: number
}

const DEFAULT_MAX_ENTRIES = 50

export function createTaskDigest(deps: TaskDigestDeps): TaskDigest {
  const maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES
  const buffer: TaskDigestEntry[] = []

  // Restore from disk
  if (deps.persistFile) {
    try {
      const raw = fs.readFileSync(deps.persistFile, 'utf-8')
      const parsed = JSON.parse(raw) as TaskDigestEntry[]
      if (Array.isArray(parsed)) {
        buffer.push(...parsed.slice(-maxEntries))
      }
    } catch {
      /* empty / corrupt — start fresh */
    }
  }

  let writeTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleWrite(): void {
    if (!deps.persistFile) return
    if (writeTimer) return
    writeTimer = setTimeout(() => {
      writeTimer = null
      flushNow()
    }, 500)
  }
  function flushNow(): void {
    if (!deps.persistFile) return
    try {
      fs.mkdirSync(path.dirname(deps.persistFile), { recursive: true })
      const tmp = deps.persistFile + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(buffer))
      fs.renameSync(tmp, deps.persistFile)
    } catch (err) {
      console.warn('[tasks] digest persist failed:', (err as Error)?.message)
    }
  }

  function append(entry: TaskDigestEntry): void {
    buffer.push(entry)
    while (buffer.length > maxEntries) buffer.shift()
    scheduleWrite()
  }

  function labelFor(threadId: string | null | undefined): string {
    if (!threadId) return '?'
    return deps.resolveLabel(threadId) ?? threadId.slice(0, 8)
  }

  // ── Bus listeners ─────────────────────────────────────────────────────

  const unsubs: Array<() => void> = []

  unsubs.push(
    deps.bus.on('task.created', (event) => {
      const p = event.payload as TaskEventPayload
      const assignmentNote = p.threadId ? `, assigned to ${labelFor(p.threadId)}` : ''
      append({
        threadId: p.sourceThreadId,
        threadLabel: labelFor(p.sourceThreadId),
        summary: `"${p.taskName}": created${assignmentNote}`,
        at: Date.now()
      })
    })
  )

  unsubs.push(
    deps.bus.on('task.state_changed', (event) => {
      const p = event.payload as TaskEventPayload
      append({
        threadId: p.sourceThreadId,
        threadLabel: labelFor(p.sourceThreadId),
        summary: `"${p.taskName}": ${p.oldState} → ${p.newState}`,
        at: Date.now()
      })
    })
  )

  unsubs.push(
    deps.bus.on('task.reassigned', (event) => {
      const p = event.payload as TaskEventPayload
      const target = p.newThreadId ? labelFor(p.newThreadId) : 'unassigned'
      append({
        threadId: p.sourceThreadId,
        threadLabel: labelFor(p.sourceThreadId),
        summary: `"${p.taskName}" → assigned to ${target}`,
        at: Date.now()
      })
    })
  )

  unsubs.push(
    deps.bus.on('task.transient_updated', (event) => {
      const p = event.payload as TaskEventPayload
      if (p.transientState) {
        append({
          threadId: p.sourceThreadId,
          threadLabel: labelFor(p.sourceThreadId),
          summary: `"${p.taskName}": ${p.transientState}`,
          at: Date.now()
        })
      }
    })
  )

  // ── Formatting ────────────────────────────────────────────────────────

  function formatAgo(ms: number): string {
    if (ms < 60_000) return 'just now'
    const mins = Math.round(ms / 60_000)
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.round(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.round(hrs / 24)}d ago`
  }

  let disposed = false
  return {
    take() {
      if (buffer.length === 0) return null
      const lines = ['[Task activity since last interaction]']
      const now = Date.now()
      for (const e of buffer) {
        lines.push(`- ${e.threadLabel} (${formatAgo(now - e.at)}): ${e.summary}`)
      }
      lines.push('[End task activity]')
      buffer.length = 0
      scheduleWrite()
      return lines.join('\n')
    },
    peek() {
      return [...buffer]
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const unsub of unsubs) unsub()
      unsubs.length = 0
      if (writeTimer) {
        clearTimeout(writeTimer)
        writeTimer = null
      }
      flushNow()
    }
  }
}
