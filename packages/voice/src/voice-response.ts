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

import type { EventBus } from '@sovereign/core'

// ── Types ──────────────────────────────────────────────────────────────

export interface VoiceResponseConfig {
  autoTts: boolean
  ttsUrl: string
  ackDelayMs: number
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
  /** Push a JSON message to every connection announced under a device name
   *  (includes audio as base64). Reaches the right tab even after a page
   *  refresh mints a fresh deviceId, because the announced name persists
   *  across reconnects. */
  sendToDeviceName: (deviceName: string, msg: Record<string, unknown>) => void
  /** Resolve a live connection's announced device name from its deviceId. */
  getDeviceName: (deviceId: string) => string | undefined
  /** Current config (called per-event so hot-reload works). */
  config: () => VoiceResponseConfig
}

// ── Prompts ────────────────────────────────────────────────────────────

const ACK_SYSTEM = `You generate brief spoken acknowledgments for a voice assistant named Hex.
Given the user's message and recent conversation context, produce a single short sentence
confirming you received the request and will work on it. Include a tiny amount of context
from the request so the user knows you understood.

Rules:
- One sentence only, under 20 words.
- Never use markdown, code, or special formatting.
- Speak naturally as a calm, competent assistant.
- Address the user as "sir" when appropriate.
- Never use any form of the verb "to be" (is, are, was, were, am, be, been, being).
- Use active verbs instead.

Examples:
- "Looking into the build logs now, sir."
- "Running that analysis for you now."
- "Checking on the deployment status, sir."
- "On it — pulling up the test results now."`

const SUMMARY_SYSTEM = `You summarize assistant responses into brief spoken language for a voice assistant named Hex.
Convert the assistant's written response into a concise spoken summary suitable for text-to-speech.

Rules:
- Keep it under 3 sentences for short responses, under 5 for longer ones.
- Strip ALL markdown, code blocks, URLs, file paths, and technical formatting.
- Rephrase code-heavy content as plain descriptions of what happened.
- Never use any form of the verb "to be" (is, are, was, were, am, be, been, being).
- Use active verbs instead.
- Speak naturally — this gets read aloud.
- Address the user as "sir" when appropriate.
- If the response contains a list of items, mention the count and highlight the most important ones.
- For error reports, state what failed and what to do next.`

// ── Module ─────────────────────────────────────────────────────────────

/** Tracks which threads have a pending voice interaction so the summary
 *  pipeline knows to fire when the assistant turn arrives. Keys TTS
 *  routing off deviceName rather than deviceId, so a page refresh mid-turn
 *  — which mints a fresh deviceId — still finds the originating tab. */
interface VoiceOrigin {
  deviceName: string
  threadId: string
  timestamp: number
}

export function createVoiceResponse(deps: VoiceResponseDeps) {
  const { bus, synthesize, synthesizeStream, llm, getRecentTurns, sendToDeviceName, getDeviceName, config } = deps

  // Active voice origins — maps threadId → origin info.
  // Set when a voice message enters the queue; consumed when the
  // assistant turn completes.
  const pendingVoice = new Map<string, VoiceOrigin>()

  // In-flight ack abort controllers — so we can cancel TTS synthesis
  // if the real response arrives before the ack finishes.
  const ackAbort = new Map<string, AbortController>()

  // ── ACK pipeline ───────────────────────────────────────────────────

  async function generateAck(threadId: string, userText: string, deviceName: string): Promise<void> {
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

      // Build the prompt
      type Role = 'system' | 'user' | 'assistant' | 'tool'
      const messages: Array<{ role: Role; content: string }> = [{ role: 'system', content: ACK_SYSTEM }]

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

      // Push audio as base64-encoded JSON to every tab announcing this device name
      const audioBase64 = audio.toString('base64')
      sendToDeviceName(deviceName, {
        type: 'voice.tts.audio',
        threadId,
        text: ackText,
        audio: audioBase64,
        kind: 'ack'
      })
      console.log(
        `[voice-response] ack delivered to ${deviceName}: "${ackText}" (${durationMs}ms TTS, ${audio.length}B)`
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[voice-response] ack generation failed for ${threadId}: ${msg}`)
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
    onTextReady: (summaryText: string) => void
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

    // Notify the caller with the real summary text (between LLM
    // collection and TTS synthesis — cancels the deferred raw turn
    // in the simple conversation store before the grace window expires).
    const summaryText = sentences.join(' ')
    onTextReady(summaryText)

    // Phase 2: synthesise and deliver each sentence sequentially
    const total = sentences.length
    for (let idx = 0; idx < total; idx++) {
      const sentence = sentences[idx]
      const isFinal = idx === total - 1
      try {
        const { audio, durationMs } = await synthesize(sentence)
        const audioBase64 = audio.toString('base64')
        sendToDeviceName(deviceName, {
          type: 'voice.tts.audio',
          threadId,
          text: sentence,
          audio: audioBase64,
          kind: 'summary',
          chunk: { index: idx, total, done: isFinal }
        })
        console.log(
          `[voice-response] streaming summary [${idx + 1}/${total}] to ${deviceName}: "${sentence.slice(0, 40)}…" (${durationMs}ms TTS)`
        )
      } catch (err) {
        console.error(`[voice-response] TTS failed for sentence ${idx}:`, err)
      }
    }

    console.log(`[voice-response] streaming summary complete: ${total} sentence(s) to ${deviceName}`)
    return summaryText
  }

  async function generateSummary(threadId: string, responseText: string, deviceName: string): Promise<void> {
    const cfg = config()
    if (!cfg.autoTts || !cfg.ttsUrl) return

    try {
      // Cancel any in-flight ack for this thread
      const ackCtrl = ackAbort.get(threadId)
      if (ackCtrl) {
        ackCtrl.abort()
        ackAbort.delete(threadId)
      }

      // Skip empty or very short responses
      if (!responseText || responseText.trim().length < 5) return

      // Build the summary prompt
      type Role = 'system' | 'user' | 'assistant' | 'tool'
      const messages: Array<{ role: Role; content: string }> = [
        { role: 'system', content: SUMMARY_SYSTEM },
        {
          role: 'user',
          content: `Summarize this assistant response for spoken delivery:\n\n${responseText.slice(0, 4000)}`
        }
      ]

      // ── Streaming path: LLM tokens → sentence split → TTS per sentence
      // When the LLM supports streaming, each sentence gets synthesised
      // and delivered as it completes — first audio after ~1 sentence.
      if (llm.stream && synthesizeStream) {
        await streamSummaryToTts(messages, threadId, deviceName, (summaryText) => {
          // Fires after LLM collection but before TTS synthesis —
          // emits real summary text into the simple conversation and
          // cancels the deferred raw-turn timer.
          sendToDeviceName(deviceName, { type: 'voice.summary.pending', threadId, text: summaryText })
          bus.emit({
            type: 'presence.reply',
            timestamp: new Date().toISOString(),
            source: 'voice-response',
            payload: { modality: 'voice', text: summaryText }
          })
        })
        return
      }

      // ── Batch path: generate full summary, then synthesise ──────────
      const completion = await llm.complete(messages)
      const summaryText = completion.choices?.[0]?.message?.content?.trim()

      if (!summaryText) return

      // Feed the simple conversation log — Hex's spoken response.
      bus.emit({
        type: 'presence.reply',
        timestamp: new Date().toISOString(),
        source: 'voice-response',
        payload: { modality: 'voice', text: summaryText }
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
          const audioBase64 = chunk.audio.toString('base64')
          sendToDeviceName(deviceName, {
            type: 'voice.tts.audio',
            threadId,
            text: chunk.sentence,
            audio: audioBase64,
            kind: 'summary',
            chunk: { index: chunk.index, total: chunk.total, done: chunk.done }
          })
          console.log(
            `[voice-response] summary chunk [${chunk.index + 1}/${chunk.total}] delivered to ${deviceName}: "${chunk.sentence.slice(0, 40)}…" (${chunk.durationMs}ms TTS)`
          )
        })
        console.log(`[voice-response] summary stream complete for ${deviceName}: ${chunkCount} chunk(s)`)
      } else {
        // Fallback: single-shot synthesis
        const { audio, durationMs } = await synthesize(summaryText)
        const audioBase64 = audio.toString('base64')
        sendToDeviceName(deviceName, {
          type: 'voice.tts.audio',
          threadId,
          text: summaryText,
          audio: audioBase64,
          kind: 'summary'
        })
        console.log(
          `[voice-response] summary delivered to ${deviceName}: "${summaryText.slice(0, 60)}…" (${durationMs}ms TTS, ${audio.length}B)`
        )
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[voice-response] summary generation failed for ${threadId}: ${msg}`)
    }
  }

  // ── Event subscriptions ───────────────────────────────────────────

  // Listen for voice-originated messages entering the chat pipeline
  bus.on('chat.message.sent', (event) => {
    const payload = event.payload as {
      threadId?: string
      text?: string
      origin?: { modality?: string; deviceId?: string; deviceName?: string }
    }
    if (!payload?.threadId || !payload?.text) return
    if (payload.origin?.modality !== 'voice') return

    // The live connection's announced name beats the one carried on the
    // origin payload — it reflects current state, while origin.deviceName
    // only captures a snapshot taken when the message entered the queue.
    // The fallback covers the race where that snapshot arrives before the
    // ws.device-name announcement lands on this exact connection.
    const deviceName =
      (payload.origin?.deviceId && getDeviceName(payload.origin.deviceId)) || payload.origin?.deviceName
    if (!deviceName) {
      console.warn('[voice-response] voice message carries no device name — TTS audio has nowhere to route')
      return
    }

    const cfg = config()
    if (!cfg.autoTts || !cfg.ttsUrl) return

    const { threadId, text } = payload

    // Track this thread as voice-originated for the summary pipeline
    pendingVoice.set(threadId, { deviceName, threadId, timestamp: Date.now() })

    // Fire the ack pipeline (non-blocking)
    void generateAck(threadId, text, deviceName)
  })

  // Listen for assistant turns completing
  bus.on('chat.turn.completed', (event) => {
    const payload = event.payload as {
      threadId?: string
      turn?: { role?: string; content?: string }
    }
    if (!payload?.threadId) return
    if (payload.turn?.role !== 'assistant') return

    const origin = pendingVoice.get(payload.threadId)
    if (!origin) return // Not a voice-originated thread

    // Clear the voice origin — one-shot per message
    pendingVoice.delete(payload.threadId)

    const responseText = payload.turn?.content ?? ''
    if (!responseText) return

    // Fire the summary pipeline (non-blocking)
    void generateSummary(payload.threadId, responseText, origin.deviceName)
  })

  // Expire stale voice origins (safety valve — 5 minutes)
  const EXPIRE_MS = 5 * 60 * 1000
  const expiryTimer = setInterval(() => {
    const now = Date.now()
    for (const [threadId, origin] of pendingVoice) {
      if (now - origin.timestamp > EXPIRE_MS) {
        pendingVoice.delete(threadId)
      }
    }
  }, 60_000)

  return {
    /** Cleanup — clear timers. */
    shutdown() {
      clearInterval(expiryTimer)
      for (const ctrl of ackAbort.values()) ctrl.abort()
      ackAbort.clear()
      pendingVoice.clear()
    }
  }
}
