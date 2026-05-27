// Resolve the OpenClaw adapter's config from the Sovereign ConfigStore.

import type { ConfigStore } from '@sovereign/config'
import type { OpenClawConfig } from './types.js'

export function openClawConfigFromStore(configStore: ConfigStore, dataDir: string): OpenClawConfig {
  return {
    gatewayUrl: configStore.get<string>('agentBackend.openclaw.gatewayUrl') || 'ws://localhost:3456/ws',
    gatewayToken: configStore.getSecret('openclawGatewayToken') || '',
    dataDir,
    onConfigChange: (_cb) => {}
  }
}
