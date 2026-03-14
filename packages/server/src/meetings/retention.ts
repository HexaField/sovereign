// Retention policy job — §8.10

import type { EventBus } from '@sovereign/core'
import fs from 'node:fs'
import path from 'node:path'

export interface RetentionConfig {
  retentionDays?: number
  autoTranscribe?: boolean
  autoSummarize?: boolean
  maxSizeBytes?: number
}

export interface RetentionJob {
  runCleanup(orgId: string, dataDir: string): Promise<number>
  updateConfig(config: Partial<RetentionConfig>): void
  getConfig(): RetentionConfig
}

export function createRetentionJob(bus: EventBus, initialConfig: RetentionConfig = {}): RetentionJob {
  let config: RetentionConfig = { ...initialConfig }

  bus.on('config.changed', (event) => {
    const payload = event.payload as Record<string, unknown>
    if (payload.retentionDays !== undefined) config.retentionDays = payload.retentionDays as number | undefined
    if (payload.autoTranscribe !== undefined) config.autoTranscribe = payload.autoTranscribe as boolean
    if (payload.autoSummarize !== undefined) config.autoSummarize = payload.autoSummarize as boolean
    if (payload.maxSizeBytes !== undefined) config.maxSizeBytes = payload.maxSizeBytes as number
  })

  return {
    async runCleanup(orgId: string, dataDir: string): Promise<number> {
      if (!config.retentionDays) return 0
      const cutoff = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000
      let removed = 0

      for (const subdir of ['meetings', 'recordings']) {
        const dir = path.join(dataDir, subdir, orgId)
        if (!fs.existsSync(dir)) continue
        for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'speakers.json')) {
          const filePath = path.join(dir, file)
          const meta = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
          if (new Date(meta.createdAt).getTime() < cutoff) {
            fs.unlinkSync(filePath)
            // Also remove associated audio/webm
            const audioFile = filePath.replace('.json', '.webm')
            if (fs.existsSync(audioFile)) fs.unlinkSync(audioFile)
            removed++
          }
        }
      }

      return removed
    },
    updateConfig(newConfig: Partial<RetentionConfig>) {
      config = { ...config, ...newConfig }
    },
    getConfig() {
      return { ...config }
    }
  }
}
