#!/usr/bin/env node
// Standalone MCP server daemon. Run via launchd (com.sovereign.mcp.plist) or
// directly:
//   SOVEREIGN_URL=http://127.0.0.1:5801 ./bin/sovereign-mcp.mjs
//
// Env:
//   SOVEREIGN_MCP_PORT       (default 5802)
//   SOVEREIGN_MCP_HOST       (default 127.0.0.1) — keep loopback
//   SOVEREIGN_URL            (default http://127.0.0.1:5801)
//   SOVEREIGN_MCP_RPC_SECRET (optional shared secret, sent as a header)

import { startSidecar } from '../dist/index.js'

const port = Number(process.env.SOVEREIGN_MCP_PORT ?? 5802)
const host = process.env.SOVEREIGN_MCP_HOST ?? '127.0.0.1'
const sovereignUrl = (process.env.SOVEREIGN_URL ?? 'http://127.0.0.1:5801').replace(/\/+$/, '')
const sharedSecret = process.env.SOVEREIGN_MCP_RPC_SECRET || undefined

const handle = await startSidecar({
  port,
  host,
  forwarder: { sovereignUrl, sharedSecret }
})

function shutdown(signal) {
  console.log(`[sovereign-mcp] received ${signal}, shutting down`)
  handle
    .close()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[sovereign-mcp] shutdown error:', err)
      process.exit(1)
    })
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
