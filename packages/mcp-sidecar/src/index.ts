// Public entry: programmatic API for embedding the sidecar.
// For OS-level usage, run `bin/sovereign-mcp.mjs` (launchd-managed) instead.

export { createSidecarApp, startSidecar } from './server.js'
export type { SidecarConfig } from './server.js'
export { buildTools } from './tools.js'
export { createForwarder } from './forward.js'
export type { ForwarderConfig, ForwardFn } from './forward.js'
