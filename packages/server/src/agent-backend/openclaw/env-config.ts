// Read OpenClaw-specific environment variables into an `OpenClawConfig`.
// Keeps every `OPENCLAW_*` env reference inside the adapter directory.

import type { OpenClawConfig } from './types.js'

export function openClawConfigFromEnv(dataDir: string): OpenClawConfig {
  return {
    gatewayUrl: process.env.OPENCLAW_GATEWAY_URL?.trim() || 'ws://localhost:3456/ws',
    gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || '',
    dataDir,
    onConfigChange: (_cb) => {}
  }
}
