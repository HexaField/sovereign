// Recording storage service — §9.4

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export interface RecordingMeta {
  id: string
  orgId: string
  name: string
  duration?: number
  mimeType: string
  createdAt: string
  transcript?: string
}

export interface RecordingsService {
  list(orgId: string): Promise<RecordingMeta[]>
  get(orgId: string, id: string): Promise<RecordingMeta | null>
  create(orgId: string, data: { name: string; mimeType: string; audio: Buffer }): Promise<RecordingMeta>
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

export function createRecordingsService(dataDir: string): RecordingsService {
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
    data: { name: string; mimeType: string; audio: Buffer }
  ): Promise<RecordingMeta> => {
    ensureDir(orgId)
    const id = crypto.randomUUID()
    const meta: RecordingMeta = {
      id,
      orgId,
      name: data.name,
      mimeType: data.mimeType,
      createdAt: new Date().toISOString()
    }
    fs.writeFileSync(audioPath(dataDir, orgId, id), data.audio)
    fs.writeFileSync(metaPath(dataDir, orgId, id), JSON.stringify(meta, null, 2))
    return meta
  }

  const del = async (orgId: string, id: string): Promise<void> => {
    const ap = audioPath(dataDir, orgId, id)
    const mp = metaPath(dataDir, orgId, id)
    if (fs.existsSync(ap)) fs.unlinkSync(ap)
    if (fs.existsSync(mp)) fs.unlinkSync(mp)
  }

  const getAudioPath = (orgId: string, id: string): string => audioPath(dataDir, orgId, id)

  const getTranscript = async (orgId: string, id: string): Promise<string | null> => {
    const meta = await get(orgId, id)
    return meta?.transcript ?? null
  }

  const transcribe = async (orgId: string, id: string): Promise<void> => {
    const meta = await get(orgId, id)
    if (!meta) throw new Error('Recording not found')
    // Placeholder: in production, call whisper/STT service
    meta.transcript = '[Transcription pending — STT service not configured]'
    fs.writeFileSync(metaPath(dataDir, orgId, id), JSON.stringify(meta, null, 2))
  }

  return { list, get, create, delete: del, getAudioPath, getTranscript, transcribe }
}
