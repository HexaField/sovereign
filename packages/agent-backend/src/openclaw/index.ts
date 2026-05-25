// OpenClaw adapter — public surface.

export { createOpenClawBackend } from './openclaw.js'
export type { OpenClawBackend } from './openclaw.js'
export type { OpenClawConfig, ReconnectConfig, DeviceIdentity } from './types.js'
export { openClawConfigFromEnv } from './env-config.js'
export { defaultOpenClawPaths, type OpenClawPaths } from './session-reader.js'
export { restartOpenClawGateway } from './restart-service.js'
export {
  parseSessionEntry,
  filterMainAndThread,
  mergeWithLocal,
  getGatewayActivityMap
} from './parse-gateway-sessions.js'
export type { ParsedSession, MergedSession } from './parse-gateway-sessions.js'
