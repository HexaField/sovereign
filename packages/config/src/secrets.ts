// Secrets store — kept in a separate {dataDir}/secrets.json file with mode 0600.
// Values never appear in the main config, in /api/config responses (unmasked),
// in history JSONL, or in exports.

import fs from 'node:fs'
import path from 'node:path'
import { validateSecrets } from './schema.js'

const SECRET_MASK = '***'

export interface SecretsStore {
  get(key: string): string
  set(key: string, value: string): void
  has(key: string): boolean
  all(): Record<string, string>
}

export function createSecretsStore(dataDir: string): SecretsStore {
  const filePath = path.join(dataDir, 'secrets.json')

  function read(): Record<string, string> {
    if (!fs.existsSync(filePath)) return {}
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      const { valid } = validateSecrets(raw)
      if (!valid) return {}
      return raw as Record<string, string>
    } catch {
      return {}
    }
  }

  function write(secrets: Record<string, string>): void {
    fs.mkdirSync(dataDir, { recursive: true })
    const tmpPath = filePath + '.tmp'
    fs.writeFileSync(tmpPath, JSON.stringify(secrets, null, 2), { mode: 0o600 })
    fs.renameSync(tmpPath, filePath)
    try {
      fs.chmodSync(filePath, 0o600)
    } catch {
      /* best-effort on non-POSIX */
    }
  }

  return {
    get(key) {
      return read()[key] ?? ''
    },
    set(key, value) {
      const current = read()
      if (value === '') {
        delete current[key]
      } else {
        current[key] = value
      }
      write(current)
    },
    has(key) {
      return key in read()
    },
    all() {
      return read()
    }
  }
}

export { SECRET_MASK }
