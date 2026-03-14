// Transcription provider & queue — §8.1

export interface TranscriptionProvider {
  name: string
  capabilities: {
    diarization: boolean
    timestamps: boolean
    languages: string[]
  }
  transcribe(
    audioBuffer: Buffer,
    mimeType: string,
    options?: { language?: string; diarize?: boolean; signal?: AbortSignal }
  ): Promise<TranscriptionResult>
  available(): boolean
}

export interface TranscriptionResult {
  text: string
  segments: TranscriptSegment[]
  speakers?: SpeakerMap
  durationMs: number
  language?: string
}

export interface TranscriptSegment {
  start: number
  end: number
  text: string
  speaker?: string
  confidence?: number
}

export interface SpeakerMap {
  [speakerId: string]: {
    label?: string
    segments: number[]
    totalDurationMs: number
  }
}

export type TranscriptionPriority = 'normal' | 'high'

export interface QueueItem {
  recordingId: string
  priority: TranscriptionPriority
  enqueuedAt: number
}

export interface TranscriptionQueue {
  enqueue(recordingId: string, priority?: TranscriptionPriority): void
  status(): { pending: number; active: number; estimatedWaitMs: number }
  onComplete(handler: (recordingId: string, result: TranscriptionResult) => void): void
  onError(handler: (recordingId: string, error: Error) => void): void
  process(getAudio: (recordingId: string) => Promise<{ buffer: Buffer; mimeType: string }>): void
  drain(): Promise<void>
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
