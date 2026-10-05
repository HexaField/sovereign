// Voice Response Module — automatic TTS for voice-originated messages.
//
// Two pipelines:
//   1. ACK — on voice message, immediately generate a brief contextual
//      acknowledgment via local-llm, synthesize via TTS, push audio to
//      the originating device.
//   2. SUMMARY — when the assistant response arrives, summarize it into
//      spoken natural language via local-llm, synthesize, push audio.
//
// Both pipelines fire only when `config.voice.autoTts` is true and a
// TTS URL is configured.  Dependency-injected — no cross-package imports.

import path from 'node:path'
import type { EventBus } from '@sovereign/core'
import { createWriteThroughFile, type WriteThroughFile } from '@sovereign/primitives'

// ── Types ──────────────────────────────────────────────────────────────

export interface VoiceResponseConfig {
  autoTts: boolean
  ttsUrl: string
  ackDelayMs: number
  /** System prompt for acknowledgment generation. When empty, uses a
   *  built-in generic default. */
  ackSystemPrompt: string
  /** System prompt for spoken summary generation. When empty, uses a
   *  built-in generic default. */
  summarySystemPrompt: string
}

export interface LlmCompleter {
  complete(messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>): Promise<{
    choices: Array<{ message: { content: string | null } }>
  }>
  /** Optional streaming variant. When present, the summary pipeline
   *  streams LLM output token-by-token → sentence-splits → feeds each
   *  sentence to TTS as it completes. First audio plays after one
   *  sentence, not after the entire summary finishes generating. */
  stream?(messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>): AsyncGenerator<{
    choices: Array<{ delta: { content?: string | null } }>
  }>
}

/** A single audio chunk from sentence-level TTS streaming. */
export interface TtsStreamChunk {
  index: number
  total: number
  sentence: string
  audio: Buffer
  durationMs: number
  done: boolean
}

export interface VoiceResponseDeps {
  bus: EventBus
  synthesize: (text: string) => Promise<{ audio: Buffer; durationMs: number }>
  /** Stream TTS as sentence-level audio chunks. When provided, the
   *  summary pipeline streams each sentence to the client as it
   *  finishes synthesizing — first audio arrives after one sentence,
   *  not after the full text completes. Falls back to single
   *  synthesize() when absent. */
  synthesizeStream?: (
    text: string,
    onChunk: (chunk: TtsStreamChunk) => void,
    options?: { signal?: AbortSignal }
  ) => Promise<void>
  /** Lightweight LLM for ack/summary generation (local-llm inference client). */
  llm: LlmCompleter
  /** Fetch the last N turns for a thread. */
  getRecentTurns: (threadId: string, limit: number) => Promise<Array<{ role: string; content: string }>>
  /** Push a JSON message to the connections announced under a device name.
   *  The name persists across reconnects, so it reaches the right tab after
   *  a page refresh mints a fresh deviceId. A message carrying `audio` plays
   *  on ONE of those connections: the first live one in `speakers`, else one
   *  the transport elects. Returns the deviceId that got the audio. */
  sendToDeviceName: (deviceName: string, msg: Record<string, unknown>, speakers?: string[]) => string | void
  /** Resolve a live connection's announced device name from its deviceId. */
  getDeviceName: (deviceId: string) => string | undefined
  /** Current config (called per-event so hot-reload works). */
  config: () => VoiceResponseConfig
  /** Data directory for persisting state across restarts. */
  dataDir: string
}

// ── Prompt defaults ───────────────────────────────────────────────────
// Generic, personality-free fallbacks. Production deployments override
// these via config.json → voice.prompts.ackSystem / summarySystem.

const DEFAULT_ACK_SYSTEM = `You generate brief spoken acknowledgments for a voice assistant.
Given the user's message and recent conversation context, produce a single short sentence
confirming you received the request and will work on it. Include a tiny amount of context
from the request so the user knows you understood.

Rules:
- One sentence only, under 20 words.
- Never use markdown, code, or special formatting.
- Speak naturally as a calm, competent assistant.

Examples:
- "Looking into the build logs now."
- "Running that analysis for you now."
- "Checking on the deployment status."
- "On it — pulling up the test results now."`

export const DEFAULT_SUMMARY_SYSTEM = `You summarize assistant responses into brief spoken language for a voice assistant.
Convert the assistant's written response into a concise spoken summary suitable for text-to-speech.

Rules:
- If the response is already brief and conversational (a short acknowledgment, greeting, or simple confirmation that adds no value when read aloud after the initial voice acknowledgment), respond with exactly "SKIP" and nothing else.
- Keep it under 3 sentences for short responses, under 5 for longer ones.
- Strip ALL markdown, code blocks, URLs, file paths, and technical formatting.
- Rephrase code-heavy content as plain descriptions of what happened.
- Speak naturally — this gets read aloud.
- If the response contains a list of items, mention the count and highlight the most important ones.
- For error reports, state what failed and what to do next.`

/** Sentinel the summary LLM returns when the response needs no TTS. */
const SKIP_SENTINEL = 'SKIP'

// ── Module ─────────────────────────────────────────────────────────────

/** Tracks which threads have a pending voice interaction so the summary
 *  pipeline knows to fire when the assistant turn arrives. Keys TTS
 *  routing off deviceName rather than deviceId, so a page refresh mid-turn
 *  — which mints a fresh deviceId — still finds the originating tab. */
interface VoiceOrigin {
  deviceName: string
  /** The connection the voice request came from, when known: it speaks the reply. */
  deviceId?: string
  threadId: string
  timestamp: number
}

export function createVoiceResponse(deps: VoiceResponseDeps) {
  const { bus, synthesize, synthesizeStream, llm, getRecentTurns, sendToDeviceName, getDeviceName, config, dataDir } =
    deps

  type TtsOverrideRecord = Record<string, { deviceName: string }>
  type PendingVoiceRecord = Record<string, VoiceOrigin>

  const overrideFile: WriteThroughFile<TtsOverrideRecord> = createWriteThroughFile<TtsOverrideRecord>({
    filePath: path.join(dataDir, 'voice', 'tts-override.json'),
    version: 1,
    defaultValue: {},
    debounceMs: 0,
    label: 'tts-override'
  })

  const pendingFile: WriteThroughFile<PendingVoiceRecord> = createWriteThroughFile<PendingVoiceRecord>({
    filePath: path.join(dataDir, 'voice', 'pending-voice.json'),
    version: 1,
    defaultValue: {},
    debounceMs: 0,
    label: 'pending-voice'
  })

  function emitVoiceError(stage: string, message: string, threadId?: string): void {
    bus.emit({
      type: 'voice.error',
      timestamp: new Date().toISOString(),
      source: 'voice-response',
      payload: { stage, message, threadId }
    })
  }

  // In-flight ack abort controllers — so we can cancel TTS synthesis
  // if the real response arrives before the ack finishes.
  const ackAbort = new Map<string, AbortController>()

  // The connection speaking each thread's current chunked reply. Later
  // chunks follow the one that spoke before them, so a reply never splits
  // across tabs; `preferred` (the origin) backs it up if that one drops.
  // The entry lives only for the length of one reply.
  const speakerOf = new Map<string, string>()

  function speak(deviceName: string, msg: Record<string, unknown> & { threadId: string }, preferred?: string): void {
    const chunk = msg.chunk as { index: number; done: boolean } | undefined
    if (!chunk || chunk.index === 0) speakerOf.delete(msg.threadId)
    const pinned = speakerOf.get(msg.threadId)
    const speaker = sendToDeviceName(
      deviceName,
      msg,
      [pinned, preferred].filter((id): id is string => !!id)
    )
    if (speaker && chunk && !chunk.done) speakerOf.set(msg.threadId, speaker)
    else speakerOf.delete(msg.threadId)
  }

  // ── ACK pipeline ───────────────────────────────────────────────────

  async function generateAck(
    threadId: string,
    userText: string,
    deviceName: string,
    preferred?: string
  ): Promise<void> {
    const cfg = config()
    if (!cfg.autoTts || !cfg.ttsUrl) return

    const controller = new AbortController()
    ackAbort.set(threadId, controller)

    try {
      // Fetch recent context (last 4 turns)
      let context: Array<{ role: string; content: string }> = []
      try {
        context = await getRecentTurns(threadId, 4)
      } catch {
        // No history yet — proceed without context
      }

      if (controller.signal.aborted) return

      // Build the prompt — config override takes precedence, then fallback
      const ackPrompt = cfg.ackSystemPrompt || DEFAULT_ACK_SYSTEM
      type Role = 'system' | 'user' | 'assistant' | 'tool'
      const messages: Array<{ role: Role; content: string }> = [{ role: 'system', content: ackPrompt }]

      // Add recent context as condensed history
      if (context.length > 0) {
        const summary = context.map((t) => `${t.role}: ${t.content?.slice(0, 200) ?? ''}`).join('\n')
        messages.push({
          role: 'user',
          content: `Recent conversation:\n${summary}\n\nNew user message: "${userText}"\n\nGenerate a brief spoken acknowledgment.`
        })
      } else {
        messages.push({
          role: 'user',
          content: `New user message: "${userText}"\n\nGenerate a brief spoken acknowledgment.`
        })
      }

      // Generate ack text via local-llm
      const completion = await llm.complete(messages)
      const ackText = completion.choices?.[0]?.message?.content?.trim()

      if (!ackText || controller.signal.aborted) return

      // Notify client that ack audio is coming
      sendToDeviceName(deviceName, { type: 'voice.ack.pending', threadId, text: ackText })

      // Synthesize audio
      const { audio, durationMs } = await synthesize(ackText)

      if (controller.signal.aborted) {
        // Real response arrived before TTS finished — skip playback
        console.log(`[voice-response] ack cancelled for ${threadId} (response arrived first)`)
        return
      }

      // Push audio as base64-encoded JSON; one connection under the name plays it
      speak(
        deviceName,
        { type: 'voice.tts.audio', threadId, text: ackText, audio: audio.toString('base64'), kind: 'ack' },
        preferred
      )
      console.log(
        `[voice-response] ack delivered to ${deviceName}: "${ackText}" (${durationMs}ms TTS, ${audio.length}B)`
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[voice-response] ack generation failed for ${threadId}: ${msg}`)
      emitVoiceError('ack-generation', msg, threadId)
    } finally {
      ackAbort.delete(threadId)
    }
  }

  // ── SUMMARY pipeline ──────────────────────────────────────────────

  // ── Sentence boundary detection for streaming LLM → TTS ───────────

  /** Detect if the accumulated text ends at a sentence boundary.
   *  Returns the index past the last complete sentence, or -1. */
  function findSentenceEnd(text: string): number {
    // Match sentence-ending punctuation followed by whitespace or end-of-string.
    // Handles . ! ? and common abbreviations like "Mr." by requiring a space after.
    const pattern = /[.!?](?:\s|$)/g
    let lastEnd = -1
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      lastEnd = match.index + 1 // position after the punctuation
    }
    return lastEnd
  }

  /** Stream LLM tokens → split into sentences → synthesise each via TTS
   *  sequentially. Returns the joined summary text so the caller can emit
   *  `presence.reply` with the real content (not a placeholder).
   *
   *  Two phases:
   *    1. Collect — stream LLM tokens, split into sentences
   *    2. Deliver — call `onTextReady` with the full text, then synthesise
   *       and send each sentence's audio in order */
  async function streamSummaryToTts(
    messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>,
    threadId: string,
    deviceName: string,
    onTextReady: (summaryText: string) => void,
    preferred?: string
  ): Promise<string> {
    if (!llm.stream || !synthesizeStream) return ''

    let accumulated = ''
    // Collect sentences as they split out of the LLM stream, then
    // synthesise + deliver them sequentially after streaming ends.
    // This ensures chunks arrive at the client in order.
    const sentences: string[] = []

    // Phase 1: stream LLM tokens — split into sentences as they arrive
    for await (const chunk of llm.stream(messages)) {
      const delta = chunk.choices?.[0]?.delta?.content
      if (!delta) continue
      accumulated += delta

      // Check for complete sentences
      const sentenceEnd = findSentenceEnd(accumulated)
      if (sentenceEnd > 0) {
        const completeSentence = accumulated.slice(0, sentenceEnd).trim()
        accumulated = accumulated.slice(sentenceEnd).trimStart()
        if (completeSentence) sentences.push(completeSentence)
      }
    }

    // Flush remaining text
    const remaining = accumulated.trim()
    if (remaining) sentences.push(remaining)

    if (sentences.length === 0) return ''

    const summaryText = sentences.join(' ')

    // LLM decided this response needs no spoken delivery
    if (summaryText.trim() === SKIP_SENTINEL) {
      console.log(`[voice-response] LLM returned SKIP — no TTS for this turn`)
      return ''
    }

    // Notify the caller with the real summary text (between LLM
    // collection and TTS synthesis — cancels the deferred raw turn
    // in the simple conversation store before the grace window expires).
    onTextReady(summaryText)

    // Phase 2: synthesise and deliver each sentence sequentially
    const total = sentences.length
    for (let idx = 0; idx < total; idx++) {
      const sentence = sentences[idx]
      const isFinal = idx === total - 1
      try {
        const { audio, durationMs } = await synthesize(sentence)
        speak(
          deviceName,
          {
            type: 'voice.tts.audio',
            threadId,
            text: sentence,
            audio: audio.toString('base64'),
            kind: 'summary',
            chunk: { index: idx, total, done: isFinal }
          },
          preferred
        )
        console.log(
          `[voice-response] streaming summary [${idx + 1}/${total}] to ${deviceName}: "${sentence.slice(0, 40)}…" (${durationMs}ms TTS)`
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[voice-response] TTS failed for sentence ${idx}:`, msg)
        emitVoiceError('tts-synthesis', msg, threadId)
      }
    }

    console.log(`[voice-response] streaming summary complete: ${total} sentence(s) to ${deviceName}`)
    return summaryText
  }

  async function generateSummary(
    threadId: string,
    responseText: string,
    deviceName: string,
    preferred?: string
  ): Promise<void> {
    const cfg = config()
    if (!cfg.ttsUrl) return

    try {
      // Cancel any in-flight ack for this thread
      const ackCtrl = ackAbort.get(threadId)
      if (ackCtrl) {
        ackCtrl.abort()
        ackAbort.delete(threadId)
      }

      // Skip empty or very short responses
      if (!responseText || responseText.trim().length < 5) return

      // Build the summary prompt — config override takes precedence
      const summaryPrompt = cfg.summarySystemPrompt || DEFAULT_SUMMARY_SYSTEM
      type Role = 'system' | 'user' | 'assistant' | 'tool'
      const messages: Array<{ role: Role; content: string }> = [
        { role: 'system', content: summaryPrompt },
        {
          role: 'user',
          content: `Summarize this assistant response for spoken delivery:\n\n${responseText.slice(0, 4000)}`
        }
      ]

      // ── Streaming path: LLM tokens → sentence split → TTS per sentence
      // When the LLM supports streaming, each sentence gets synthesised
      // and delivered as it completes — first audio after ~1 sentence.
      if (llm.stream && synthesizeStream) {
        await streamSummaryToTts(
          messages,
          threadId,
          deviceName,
          (summaryText) => {
            // Fires after LLM collection but before TTS synthesis —
            // emits real summary text into the simple conversation and
            // cancels the deferred raw-turn timer.
            sendToDeviceName(deviceName, { type: 'voice.summary.pending', threadId, text: summaryText })
            bus.emit({
              type: 'presence.reply',
              timestamp: new Date().toISOString(),
              source: 'voice-response',
              payload: { modality: 'voice', text: summaryText, threadId }
            })
          },
          preferred
        )
        return
      }

      // ── Batch path: generate full summary, then synthesise ──────────
      const completion = await llm.complete(messages)
      const summaryText = completion.choices?.[0]?.message?.content?.trim()

      if (!summaryText) return

      // LLM decided this response needs no spoken delivery
      if (summaryText === SKIP_SENTINEL) {
        console.log(`[voice-response] LLM returned SKIP — no TTS for this turn`)
        return
      }

      // Feed the simple conversation log — Hex's spoken response.
      bus.emit({
        type: 'presence.reply',
        timestamp: new Date().toISOString(),
        source: 'voice-response',
        payload: { modality: 'voice', text: summaryText, threadId }
      })

      // Notify client that summary audio is coming
      sendToDeviceName(deviceName, { type: 'voice.summary.pending', threadId, text: summaryText })

      // Use streaming TTS when available — the client receives each sentence's
      // audio as it finishes synthesizing, cutting perceived latency from
      // "full text time" to "one sentence time".
      if (synthesizeStream) {
        let chunkCount = 0
        await synthesizeStream(summaryText, (chunk) => {
          chunkCount++
          speak(
            deviceName,
            {
              type: 'voice.tts.audio',
              threadId,
              text: chunk.sentence,
              audio: chunk.audio.toString('base64'),
              kind: 'summary',
              chunk: { index: chunk.index, total: chunk.total, done: chunk.done }
            },
            preferred
          )
          console.log(
            `[voice-response] summary chunk [${chunk.index + 1}/${chunk.total}] delivered to ${deviceName}: "${chunk.sentence.slice(0, 40)}…" (${chunk.durationMs}ms TTS)`
          )
        })
        console.log(`[voice-response] summary stream complete for ${deviceName}: ${chunkCount} chunk(s)`)
      } else {
        // Fallback: single-shot synthesis
        const { audio, durationMs } = await synthesize(summaryText)
        speak(
          deviceName,
          { type: 'voice.tts.audio', threadId, text: summaryText, audio: audio.toString('base64'), kind: 'summary' },
          preferred
        )
        console.log(
          `[voice-response] summary delivered to ${deviceName}: "${summaryText.slice(0, 60)}…" (${durationMs}ms TTS, ${audio.length}B)`
        )
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[voice-response] summary generation failed for ${threadId}: ${msg}`)
      emitVoiceError('summary-generation', msg, threadId)
    }
  }

  // ── Event subscriptions ───────────────────────────────────────────

  // Listen for TTS override toggle from the client
  bus.on('voice.tts-override', (event) => {
    const payload = event.payload as {
      threadId?: string
      enabled?: boolean
      deviceName?: string
    }
    if (!payload?.threadId) return

    if (payload.enabled && payload.deviceName) {
      overrideFile.updateSync((prev) => ({ ...prev, [payload.threadId!]: { deviceName: payload.deviceName! } }))
      console.log(`[voice-response] TTS override ON for ${payload.threadId} → ${payload.deviceName}`)
    } else {
      overrideFile.updateSync((prev) => {
        const next = { ...prev }
        delete next[payload.threadId!]
        return next
      })
      console.log(`[voice-response] TTS override OFF for ${payload.threadId}`)
    }

    const current = overrideFile.read()
    bus.emit({
      type: 'voice.tts-override.state',
      timestamp: new Date().toISOString(),
      source: 'voice-response',
      payload: {
        threadId: payload.threadId,
        enabled: payload.threadId in current,
        deviceName: current[payload.threadId]?.deviceName ?? null
      }
    })
  })

  // Listen for voice-originated messages entering the chat pipeline
  bus.on('chat.message.sent', (event) => {
    const payload = event.payload as {
      threadId?: string
      text?: string
      origin?: { modality?: string; deviceId?: string; deviceName?: string }
    }
    if (!payload?.threadId || !payload?.text) return
    if (payload.origin?.modality !== 'voice') return

    const deviceName =
      (payload.origin?.deviceId && getDeviceName(payload.origin.deviceId)) || payload.origin?.deviceName
    if (!deviceName) {
      console.warn('[voice-response] voice message carries no device name — TTS audio has nowhere to route')
      return
    }

    const cfg = config()
    if (!cfg.autoTts || !cfg.ttsUrl) return

    const { threadId, text } = payload

    const deviceId = payload.origin?.deviceId
    pendingFile.updateSync((prev) => ({
      ...prev,
      [threadId]: { deviceName, ...(deviceId ? { deviceId } : {}), threadId, timestamp: Date.now() }
    }))

    void generateAck(threadId, text, deviceName, deviceId)
  })

  // Listen for assistant turns completing
  bus.on('chat.turn.completed', (event) => {
    const payload = event.payload as {
      threadId?: string
      turn?: { role?: string; content?: string }
    }
    if (!payload?.threadId) return
    if (payload.turn?.role !== 'assistant') return

    const responseText = payload.turn?.content ?? ''
    if (!responseText) return

    const pending = pendingFile.read()
    const origin = pending[payload.threadId]
    const override = overrideFile.read()[payload.threadId]
    console.log(
      `[voice-response] chat.turn.completed: thread=${payload.threadId} pending=${!!origin} override=${!!override} contentLen=${responseText.length}`
    )

    if (origin) {
      pendingFile.updateSync((prev) => {
        const next = { ...prev }
        delete next[payload.threadId!]
        return next
      })
      void generateSummary(payload.threadId, responseText, origin.deviceName, origin.deviceId)
      return
    }

    if (override) {
      const cfg = config()
      if (!cfg.ttsUrl) return
      void generateSummary(payload.threadId, responseText, override.deviceName)
    }
  })

  // Expire stale voice origins (safety valve — 5 minutes)
  const EXPIRE_MS = 5 * 60 * 1000

  function expireStale(): void {
    const now = Date.now()
    const current = pendingFile.read()
    let changed = false
    const next = { ...current }
    for (const [threadId, origin] of Object.entries(next)) {
      if (now - origin.timestamp > EXPIRE_MS) {
        delete next[threadId]
        changed = true
      }
    }
    if (changed) pendingFile.writeSync(next)
  }

  // Expire on boot and periodically
  expireStale()
  const expiryTimer = setInterval(expireStale, 60_000)

  return {
    getTtsOverride(threadId: string): { enabled: boolean; deviceName: string | null } {
      const entry = overrideFile.read()[threadId]
      return { enabled: !!entry, deviceName: entry?.deviceName ?? null }
    },
    shutdown() {
      clearInterval(expiryTimer)
      for (const ctrl of ackAbort.values()) ctrl.abort()
      ackAbort.clear()
      overrideFile.flush()
      pendingFile.flush()
    }
  }
}
