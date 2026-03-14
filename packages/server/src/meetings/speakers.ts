// Speaker label management — §8.2.3

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export interface SpeakerLabels {
  [speakerId: string]: string
}

export interface SpeakerService {
  getLabels(orgId: string): Promise<SpeakerLabels>
  setLabels(orgId: string, meetingId: string, labels: SpeakerLabels): Promise<void>
  getOrgHistory(orgId: string): Promise<SpeakerLabels>
}

function speakersPath(dataDir: string, orgId: string): string {
  return path.join(dataDir, 'meetings', orgId, 'speakers.json')
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + '.tmp.' + crypto.randomUUID()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, filePath)
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
}

export function createSpeakerService(dataDir: string): SpeakerService {
  return {
    async getLabels(orgId: string): Promise<SpeakerLabels> {
      return readJson(speakersPath(dataDir, orgId), {})
    },

    async setLabels(orgId: string, _meetingId: string, labels: SpeakerLabels): Promise<void> {
      const existing = readJson<SpeakerLabels>(speakersPath(dataDir, orgId), {})
      const merged = { ...existing, ...labels }
      atomicWrite(speakersPath(dataDir, orgId), JSON.stringify(merged, null, 2))
    },

    async getOrgHistory(orgId: string): Promise<SpeakerLabels> {
      return readJson(speakersPath(dataDir, orgId), {})
    }
  }
}
