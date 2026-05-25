// Transcription queue implementation — §8.1
// Provider/result types live in @sovereign/core so callers (e.g. voice,
// meetings) don't have to import from this package.

import type {
  TranscriptionProvider,
  TranscriptionResult,
  TranscriptionPriority,
  TranscriptionQueue
} from '@sovereign/core'

export type { TranscriptionProvider, TranscriptionResult, TranscriptionPriority, TranscriptionQueue }
export type { TranscriptSegment, SpeakerMap } from '@sovereign/core'

interface QueueItem {
  recordingId: string
  priority: TranscriptionPriority
  enqueuedAt: number
}

export function createTranscriptionQueue(
  provider: TranscriptionProvider,
  maxConcurrent: number = 2
): TranscriptionQueue {
  const pending: QueueItem[] = []
  let active = 0
  let completeHandler: ((id: string, result: TranscriptionResult) => void) | null = null
  let errorHandler: ((id: string, error: Error) => void) | null = null
  let getAudioFn: ((id: string) => Promise<{ buffer: Buffer; mimeType: string }>) | null = null
  let drainResolve: (() => void) | null = null
  const AVG_TRANSCRIPTION_MS = 5000

  function tryProcess(): void {
    while (active < maxConcurrent && pending.length > 0) {
      const item = pending.shift()!
      active++
      processItem(item)
    }
    if (active === 0 && pending.length === 0 && drainResolve) {
      const resolve = drainResolve
      drainResolve = null
      resolve()
    }
  }

  async function processItem(item: QueueItem): Promise<void> {
    try {
      if (!getAudioFn) throw new Error('No audio getter configured — call process() first')
      const { buffer, mimeType } = await getAudioFn(item.recordingId)
      const diarize = provider.capabilities.diarization
      const result = await provider.transcribe(buffer, mimeType, { diarize })
      if (completeHandler) completeHandler(item.recordingId, result)
    } catch (err) {
      if (errorHandler) errorHandler(item.recordingId, err instanceof Error ? err : new Error(String(err)))
    } finally {
      active--
      tryProcess()
    }
  }

  return {
    enqueue(recordingId: string, priority: TranscriptionPriority = 'normal'): void {
      const item: QueueItem = { recordingId, priority, enqueuedAt: Date.now() }
      if (priority === 'high') {
        // Insert before all normal-priority items
        const idx = pending.findIndex((i) => i.priority === 'normal')
        if (idx === -1) pending.push(item)
        else pending.splice(idx, 0, item)
      } else {
        pending.push(item)
      }
      tryProcess()
    },
    status() {
      return {
        pending: pending.length,
        active,
        estimatedWaitMs: pending.length * AVG_TRANSCRIPTION_MS
      }
    },
    onComplete(handler) {
      completeHandler = handler
    },
    onError(handler) {
      errorHandler = handler
    },
    process(getter) {
      getAudioFn = getter
    },
    async drain() {
      if (active === 0 && pending.length === 0) return
      return new Promise<void>((resolve) => {
        drainResolve = resolve
      })
    }
  }
}
