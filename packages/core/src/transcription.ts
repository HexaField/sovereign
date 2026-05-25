// Transcription provider interface — implementations live in voice/recordings
// modules. Defined in core so consumers depend on the interface, not the
// concrete provider.

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

/**
 * Recording metadata as exposed by the recordings service.
 */
export interface RecordingMeta {
  id: string
  orgId: string
  meetingId?: string
  name: string
  duration: number
  sizeBytes: number
  mimeType: string
  createdAt: string
  updatedAt: string
  threadKey?: string
  entities?: unknown[]
  transcriptStatus: 'none' | 'pending' | 'processing' | 'completed' | 'failed'
  transcriptionProgress?: number
  tags?: string[]
  transcript?: string
}

/**
 * Public surface of the recordings service. Defined in core so callers
 * (e.g. meetings) can depend on the interface without importing the
 * concrete implementation.
 */
export interface RecordingsService {
  list(orgId: string): Promise<RecordingMeta[]>
  get(orgId: string, id: string): Promise<RecordingMeta | null>
  create(
    orgId: string,
    data: {
      name: string
      mimeType: string
      audio: Buffer
      meetingId?: string
      threadKey?: string
      duration?: number
    }
  ): Promise<RecordingMeta>
  delete(orgId: string, id: string): Promise<void>
  getAudioPath(orgId: string, id: string): string
  getTranscript(orgId: string, id: string): Promise<string | null>
  transcribe(orgId: string, id: string): Promise<void>
}

export interface TranscriptionQueue {
  enqueue(recordingId: string, priority?: TranscriptionPriority): void
  status(): { pending: number; active: number; estimatedWaitMs: number }
  onComplete(handler: (recordingId: string, result: TranscriptionResult) => void): void
  onError(handler: (recordingId: string, error: Error) => void): void
  process(getAudio: (recordingId: string) => Promise<{ buffer: Buffer; mimeType: string }>): void
  drain(): Promise<void>
}
