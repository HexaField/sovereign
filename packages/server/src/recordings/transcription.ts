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

export interface TranscriptionQueue {
  enqueue(recordingId: string, priority?: 'normal' | 'high'): void
  status(): { pending: number; active: number; estimatedWaitMs: number }
}

export function createTranscriptionQueue(
  _provider: TranscriptionProvider,
  _maxConcurrent?: number
): TranscriptionQueue {
  throw new Error('Not implemented')
}
