import fs from 'node:fs'
import crypto from 'node:crypto'

export function readToken(tokenFile: string): string | null {
  try {
    const raw = fs.readFileSync(tokenFile, 'utf-8')
    const parsed = JSON.parse(raw) as { token?: string }
    return parsed.token ?? null
  } catch {
    return null
  }
}

export function writeToken(tokenFile: string, token: string): void {
  const dir = tokenFile.split('/').slice(0, -1).join('/')
  if (dir) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(tokenFile, JSON.stringify({ token }), { mode: 0o600 })
}

export function generateRand(): string {
  return crypto.randomBytes(16).toString('hex')
}
