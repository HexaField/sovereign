// Recording storage service — §8.4

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { EventBus } from '@sovereign/core'
import type { TranscriptionProvider } from './transcription.js'

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

function orgDir(dataDir: string, orgId: string): string {
  return path.join(dataDir, 'recordings', orgId)
}

function metaPath(dataDir: string, orgId: string, id: string): string {
  return path.join(orgDir(dataDir, orgId), `${id}.json`)
}

function audioPath(dataDir: string, orgId: string, id: string): string {
  return path.join(orgDir(dataDir, orgId), `${id}.webm`)
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + '.tmp.' + crypto.randomUUID()
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, filePath)
}

/** Original signature for backward compatibility */
export function createRecordingsService(dataDir: string): RecordingsService
/** Enhanced signature with bus and provider */
export function createRecordingsService(
  busOrDataDir: string | EventBus,
  dataDirOrProvider?: string,
  provider?: TranscriptionProvider
): RecordingsService
export function createRecordingsService(
  busOrDataDir: string | EventBus,
  dataDirOrProvider?: string,
  provider?: TranscriptionProvider
): RecordingsService {
  let bus: EventBus | null = null
  let dataDir: string
  let transcriptionProvider: TranscriptionProvider | null = null
  let autoTranscribe = true
  let maxSizeBytes = 100 * 1024 * 1024 // 100MB

  if (typeof busOrDataDir === 'string') {
    dataDir = busOrDataDir
  } else {
    bus = busOrDataDir
    dataDir = dataDirOrProvider!
    transcriptionProvider = provider ?? null
  }

  // Listen for config changes
  if (bus) {
    bus.on('config.changed', (event) => {
      const p = event.payload as Record<string, unknown>
      if (p.autoTranscribe !== undefined) autoTranscribe = p.autoTranscribe as boolean
      if (p.maxSizeBytes !== undefined) maxSizeBytes = p.maxSizeBytes as number
    })
  }

  const ensureDir = (orgId: string): void => {
    fs.mkdirSync(orgDir(dataDir, orgId), { recursive: true })
  }

  const list = async (orgId: string): Promise<RecordingMeta[]> => {
    const dir = orgDir(dataDir, orgId)
    if (!fs.existsSync(dir)) return []
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    return files
      .map((f) => {
        const raw = fs.readFileSync(path.join(dir, f), 'utf-8')
        return JSON.parse(raw) as RecordingMeta
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }

  const get = async (orgId: string, id: string): Promise<RecordingMeta | null> => {
    const mp = metaPath(dataDir, orgId, id)
    if (!fs.existsSync(mp)) return null
    return JSON.parse(fs.readFileSync(mp, 'utf-8'))
  }

  const create = async (
    orgId: string,
    data: { name: string; mimeType: string; audio: Buffer; meetingId?: string; threadKey?: string; duration?: number }
  ): Promise<RecordingMeta> => {
    if (data.audio.length > maxSizeBytes) {
      const err = new Error('File too large') as Error & { status?: number }
      err.status = 413
      throw err
    }

    ensureDir(orgId)
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const meta: RecordingMeta = {
      id,
      orgId,
      meetingId: data.meetingId,
      name: data.name,
      duration: data.duration ?? 0,
      sizeBytes: data.audio.length,
      mimeType: data.mimeType,
      createdAt: now,
      updatedAt: now,
      threadKey: data.threadKey,
      transcriptStatus: 'none'
    }
    fs.writeFileSync(audioPath(dataDir, orgId, id), data.audio)

    // Auto-transcribe if configured and provider available
    if (autoTranscribe && transcriptionProvider?.available()) {
      meta.transcriptStatus = 'pending'
    }

    atomicWrite(metaPath(dataDir, orgId, id), JSON.stringify(meta, null, 2))

    if (bus) {
      bus.emit({
        type: 'recording.created',
        timestamp: now,
        source: 'recordings',
        payload: { ...meta }
      })
    }

    if (autoTranscribe && transcriptionProvider?.available()) {
      // Transcription runs async
      transcriptionProvider.transcribe(data.audio, data.mimeType).then(
        (result) => {
          meta.transcriptStatus = 'completed'
          meta.transcript = result.text
          atomicWrite(metaPath(dataDir, orgId, id), JSON.stringify(meta, null, 2))
        },
        () => {
          meta.transcriptStatus = 'failed'
          atomicWrite(metaPath(dataDir, orgId, id), JSON.stringify(meta, null, 2))
        }
      )
    }

    return meta
  }

  const del = async (orgId: string, id: string): Promise<void> => {
    const ap = audioPath(dataDir, orgId, id)
    const mp = metaPath(dataDir, orgId, id)
    if (fs.existsSync(ap)) fs.unlinkSync(ap)
    if (fs.existsSync(mp)) fs.unlinkSync(mp)

    if (bus) {
      bus.emit({
        type: 'recording.deleted',
        timestamp: new Date().toISOString(),
        source: 'recordings',
        payload: { orgId, id }
      })
    }
  }

  const getAudioPath = (orgId: string, id: string): string => audioPath(dataDir, orgId, id)

  const getTranscript = async (orgId: string, id: string): Promise<string | null> => {
    const meta = await get(orgId, id)
    return meta?.transcript ?? null
  }

  const transcribe = async (orgId: string, id: string): Promise<void> => {
    const meta = await get(orgId, id)
    if (!meta) throw new Error('Recording not found')
    if (transcriptionProvider?.available()) {
      meta.transcriptStatus = 'processing'
      meta.transcriptionProgress = 0
      meta.updatedAt = new Date().toISOString()
      atomicWrite(metaPath(dataDir, orgId, id), JSON.stringify(meta, null, 2))

      // Simulate progress updates (provider doesn't expose real progress)
      const progressInterval = setInterval(() => {
        if (meta.transcriptionProgress != null && meta.transcriptionProgress < 90) {
          meta.transcriptionProgress = Math.min(meta.transcriptionProgress + 10, 90)
          meta.updatedAt = new Date().toISOString()
          atomicWrite(metaPath(dataDir, orgId, id), JSON.stringify(meta, null, 2))
        }
      }, 1000)

      try {
        const audio = fs.readFileSync(audioPath(dataDir, orgId, id))
        const result = await transcriptionProvider.transcribe(audio, meta.mimeType)
        meta.transcript = result.text
        meta.transcriptStatus = 'completed'
        meta.transcriptionProgress = 100
      } catch (err: any) {
        meta.transcriptStatus = 'failed'
        meta.transcriptionProgress = undefined
      } finally {
        clearInterval(progressInterval)
      }
    } else {
      meta.transcript = '[Transcription pending — STT service not configured]'
    }
    meta.updatedAt = new Date().toISOString()
    atomicWrite(metaPath(dataDir, orgId, id), JSON.stringify(meta, null, 2))
  }

  return { list, get, create, delete: del, getAudioPath, getTranscript, transcribe }
}
