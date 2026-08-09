// Running Summary Service — maintains rolling per-thread summaries via
// a local model. Listens to bus events, debounces per thread, calls the
// inference client, and stores the result.

import fs from 'node:fs'
import path from 'node:path'
import type { EventBus, ParsedTurn } from '@sovereign/core'
import { unwrapThreadId } from '@sovereign/core'
import { createInferenceClient, type InferenceClient } from './inference-client.js'

export interface ThreadSummary {
  threadKey: string
  summary: string
  lastEventAt: number
  eventCount: number
  version: number
}

export interface SummaryServiceConfig {
  enabled: boolean
  baseUrl: string
  model: string
  debounceMs: number
  maxSummaryWords: number
}

export interface SummaryServiceDeps {
  bus: EventBus
  dataDir: string
  config: SummaryServiceConfig
}

interface PendingEvent {
  role: string
  content: string
  timestamp: number
}

const SUMMARY_PROMPT_TEMPLATE = `You maintain a running summary of a conversation thread. Update the summary to incorporate the new messages below. Keep the summary under {maxWords} words. Focus on: what the user asked for, what the agent did, current status, any pending items.

## Current Summary
{existingSummary}

## New Activity
{newEvents}

## Updated Summary`

export function createSummaryService(deps: SummaryServiceDeps) {
  const { bus, dataDir, config } = deps
  const summariesDir = path.join(dataDir, 'summaries')
  let client: InferenceClient | null = null
  let unsubscribe: (() => void) | null = null

  // Pending events per thread, accumulated during debounce window
  const pendingEvents = new Map<string, PendingEvent[]>()
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const inFlight = new Set<string>()

  /** Ensure the summaries directory exists. */
  function ensureDir() {
    if (!fs.existsSync(summariesDir)) {
      fs.mkdirSync(summariesDir, { recursive: true })
    }
  }

  /** Read a stored summary, or return a blank one. */
  function readSummary(threadKey: string): ThreadSummary {
    const filePath = path.join(summariesDir, `${sanitizeKey(threadKey)}.json`)
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      return JSON.parse(raw) as ThreadSummary
    } catch {
      return { threadKey, summary: '', lastEventAt: 0, eventCount: 0, version: 0 }
    }
  }

  /** Write a summary to disk. */
  function writeSummary(summary: ThreadSummary): void {
    ensureDir()
    const filePath = path.join(summariesDir, `${sanitizeKey(summary.threadKey)}.json`)
    fs.writeFileSync(filePath, JSON.stringify(summary, null, 2), 'utf-8')
  }

  /** Sanitize a thread key for use as a filename. */
  function sanitizeKey(key: string): string {
    return key.replace(/[^a-zA-Z0-9_-]/g, '_')
  }

  /** Build the prompt for the summary model. */
  function buildPrompt(existing: string, events: PendingEvent[], maxWords: number): string {
    const eventText = events.map((e) => `[${e.role}] ${e.content.slice(0, 500)}`).join('\n\n')

    return SUMMARY_PROMPT_TEMPLATE.replace('{maxWords}', String(maxWords))
      .replace('{existingSummary}', existing || '(no prior summary)')
      .replace('{newEvents}', eventText)
  }

  /** Re-arm the debounce timer for a thread if events are pending and no
   *  timer is currently scheduled — used both by `queueEvent` and to make
   *  sure events queued while an update was in flight don't get stranded. */
  function scheduleFlush(threadKey: string): void {
    if (debounceTimers.has(threadKey)) return
    if (!pendingEvents.get(threadKey)?.length) return
    debounceTimers.set(
      threadKey,
      setTimeout(() => {
        debounceTimers.delete(threadKey)
        updateSummary(threadKey).catch(() => {})
      }, config.debounceMs)
    )
  }

  /** Execute a summary update for one thread. */
  async function updateSummary(threadKey: string): Promise<void> {
    if (!client || inFlight.has(threadKey)) return
    const events = pendingEvents.get(threadKey)
    if (!events?.length) return

    // Move events out of the pending buffer
    pendingEvents.delete(threadKey)
    inFlight.add(threadKey)

    try {
      const current = readSummary(threadKey)
      const prompt = buildPrompt(current.summary, events, config.maxSummaryWords)

      const response = await client.complete([
        {
          role: 'system',
          content: 'You produce concise thread summaries. Respond with only the updated summary text, no preamble.'
        },
        { role: 'user', content: prompt }
      ])

      const newSummaryText = response.choices[0]?.message?.content?.trim() ?? ''
      if (!newSummaryText) return

      const lastEventTime = Math.max(...events.map((e) => e.timestamp))

      const updated: ThreadSummary = {
        threadKey,
        summary: newSummaryText,
        lastEventAt: lastEventTime,
        eventCount: current.eventCount + events.length,
        version: current.version + 1
      }

      writeSummary(updated)

      // Emit on the bus for WS broadcast
      bus.emit({
        type: 'thread.summary',
        timestamp: new Date().toISOString(),
        source: 'summary',
        payload: { threadKey, summary: newSummaryText, version: updated.version }
      })
    } catch (err) {
      // Log but never block — summary generation must remain fire-and-forget
      console.warn(`[summary] update failed for ${threadKey}:`, (err as Error)?.message)
      // Re-queue events so they get picked up next time
      const existing = pendingEvents.get(threadKey) ?? []
      pendingEvents.set(threadKey, [...events, ...existing])
    } finally {
      inFlight.delete(threadKey)
      // Events queued for this thread while the update above was in flight
      // would otherwise sit un-scheduled until an unrelated new event
      // arrived. Re-arm the debounce so they still get flushed.
      scheduleFlush(threadKey)
    }
  }

  /** Queue an event for a thread. Resets the debounce timer. */
  function queueEvent(threadKey: string, role: string, content: string) {
    if (!config.enabled) return

    const events = pendingEvents.get(threadKey) ?? []
    events.push({ role, content, timestamp: Date.now() })
    pendingEvents.set(threadKey, events)

    // Reset debounce timer
    const existing = debounceTimers.get(threadKey)
    if (existing) clearTimeout(existing)
    debounceTimers.delete(threadKey)

    scheduleFlush(threadKey)
  }

  /** Start listening to bus events. */
  function start() {
    if (!config.enabled) return

    ensureDir()
    client = createInferenceClient({
      baseUrl: config.baseUrl,
      model: config.model,
      temperature: 0.1,
      maxTokens: 1024,
      timeoutMs: 30000
    })

    // Listen for completed chat turns — emitted by @sovereign/chat as
    // `{ threadId, turn }` with `threadId` a bare UUID (see
    // packages/core/src/session-key.ts — the legacy `agent:main:thread:<x>`
    // compound-key scheme is retired). `unwrapThreadId` normalizes any
    // stray legacy-format id that might still be in flight.
    unsubscribe = bus.on('chat.turn.completed', (event) => {
      const payload = event.payload as { threadId?: string; turn?: ParsedTurn } | undefined
      const threadId = payload?.threadId
      const turn = payload?.turn
      if (!threadId || !turn?.content) return
      const threadKey = unwrapThreadId(threadId)
      if (threadKey) {
        queueEvent(threadKey, turn.role, turn.content)
      }
    })
  }

  /** Stop the service — flush pending timers. */
  function stop() {
    for (const timer of debounceTimers.values()) clearTimeout(timer)
    debounceTimers.clear()
    pendingEvents.clear()
    inFlight.clear()
    unsubscribe?.()
    unsubscribe = null
    client = null
  }

  /** Get the current summary for a thread. */
  function getSummary(threadKey: string): ThreadSummary | null {
    const summary = readSummary(threadKey)
    return summary.version > 0 ? summary : null
  }

  /** Force a summary update (bypass debounce). */
  async function forceSummary(threadKey: string): Promise<ThreadSummary | null> {
    const timer = debounceTimers.get(threadKey)
    if (timer) {
      clearTimeout(timer)
      debounceTimers.delete(threadKey)
    }
    await updateSummary(threadKey)
    return getSummary(threadKey)
  }

  /** Health check — can we reach the inference server? */
  async function healthCheck(): Promise<boolean> {
    if (!client) return false
    return client.healthCheck()
  }

  /** Update config at runtime. */
  function updateConfig(patch: Partial<SummaryServiceConfig>) {
    Object.assign(config, patch)
    if (client && (patch.baseUrl || patch.model)) {
      client.updateConfig({ baseUrl: config.baseUrl, model: config.model })
    }
  }

  return { start, stop, getSummary, forceSummary, queueEvent, healthCheck, updateConfig }
}

export type SummaryService = ReturnType<typeof createSummaryService>
