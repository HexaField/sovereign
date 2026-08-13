// Retention policy job — §8.10
//
// Sweeps meeting/recording files older than a retention window. This used
// to be a stateful "job" object that listened for `config.changed` events
// and read `retentionDays`/`autoTranscribe`/`autoSummarize`/`maxSizeBytes`
// off the top-level event payload. None of those fields ever existed in
// the config schema (see `ConfigChange` in `@sovereign/config` — it only
// carries `path`/`oldValue`/`newValue`), so the watcher never fired and
// `updateConfig`/`getConfig` never reflected a live config change. Removed
// as dead code. Callers now pass `retentionDays` directly at call time.

import fs from 'node:fs'
import path from 'node:path'

export async function runCleanup(orgId: string, dataDir: string, retentionDays?: number): Promise<number> {
  if (!retentionDays) return 0
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
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
}
