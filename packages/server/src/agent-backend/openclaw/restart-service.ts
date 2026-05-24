// OpenClaw-specific gateway restart helper. Hooked up only when the active
// backend is OpenClaw — Pi / Claude Code don't need this.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface GatewayRestartResult {
  message: string
  command: string
}

export async function restartOpenClawGateway(): Promise<GatewayRestartResult> {
  const command = 'openclaw gateway restart'
  const { stdout, stderr } = await execFileAsync('openclaw', ['gateway', 'restart'], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024
  })
  const output = [stdout, stderr].filter(Boolean).join('\n').trim()
  return {
    command,
    message: output || 'OpenClaw gateway restart completed'
  }
}
