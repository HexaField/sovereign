// Sovereign server entry point — resolves the config + data dirs, loads
// config, builds the transport from the resolved config, then hands off to
// bootstrap.ts.
//
// Two bootstrap env vars (the only ones consulted directly):
//   SOVEREIGN_CONFIG_DIR  — tracks user-edited state (config.json, secrets.json,
//                           config-history.jsonl). Defaults to `~/.sovereign`.
//                           Intended to be version-controlled by the user.
//   SOVEREIGN_DATA_DIR    — holds pure runtime state (threads, queues, logs,
//                           events, scheduler, etc). Defaults to
//                           `${SOVEREIGN_CONFIG_DIR}/data`. Should be gitignored.
//
// Everything else (HOST/PORT/SOVEREIGN_TLS/...) flows through config.json.

import fs from 'node:fs'
import https from 'node:https'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cors from 'cors'
import express from 'express'
import { WebSocketServer } from 'ws'

process.on('unhandledRejection', (r) => console.error('[server] Unhandled rejection:', r))

import { createEventBus } from '@sovereign/core'
import { createConfigStore } from '@sovereign/config'
import healthRouter from './routes/health.js'
import { bootstrapServer } from './bootstrap.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../..')

// ── Config dir + data dir (the two bootstrap env reads) ─────────────────
const configDir = process.env.SOVEREIGN_CONFIG_DIR || path.join(os.homedir(), '.sovereign')
fs.mkdirSync(configDir, { recursive: true })
const dataDir = process.env.SOVEREIGN_DATA_DIR || path.join(configDir, 'data')
fs.mkdirSync(dataDir, { recursive: true })
console.log(
  `Config dir: ${configDir}${process.env.SOVEREIGN_CONFIG_DIR ? '' : ' (defaulted — set SOVEREIGN_CONFIG_DIR to pin)'}`
)
console.log(
  `Data dir: ${dataDir}${process.env.SOVEREIGN_DATA_DIR ? '' : ' (defaulted — set SOVEREIGN_DATA_DIR to pin)'}`
)

// Drift guard: warn if a populated Sovereign data dir exists at a historical
// location (`~/.openclaw/workspace/.sovereign-data`) but isn't the one we're
// using. The legacy path predates the OpenClaw removal but still holds live
// user state for existing installs — without this warning the operator would
// silently see an empty Sovereign because the active dir is stale.
if (!process.env.SOVEREIGN_DATA_DIR) {
  const home = process.env.HOME ?? ''
  const legacyDataDir = path.join(home, '.openclaw', 'workspace', '.sovereign-data')
  if (fs.existsSync(path.join(legacyDataDir, 'threads', 'registry.json')) && legacyDataDir !== dataDir) {
    console.warn(`[data-dir] WARNING: another Sovereign data dir exists at ${legacyDataDir}.`)
    console.warn(
      `[data-dir] You are using the default (${dataDir}); state may diverge. Set SOVEREIGN_DATA_DIR to pick one explicitly.`
    )
  }
}

// ── Config (everything else) ────────────────────────────────────────────
// config.json lives in configDir (version-controlled); secrets.json + the
// change-history JSONL live in dataDir (runtime, gitignored).
const bus = createEventBus(dataDir)
const configStore = createConfigStore(bus, configDir, dataDir)

const host = configStore.get<string>('server.host')
const port = configStore.get<number>('server.port')
const useTls = configStore.get<boolean>('server.tls.enabled')

const app = express()
app.use(cors())
app.use(express.json())
app.use('/health', healthRouter)

const server: http.Server | https.Server = useTls
  ? https.createServer(
      {
        key: fs.readFileSync(path.join(repoRoot, '.certs/localhost.key')),
        cert: fs.readFileSync(path.join(repoRoot, '.certs/localhost.cert'))
      },
      app
    )
  : http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

// ── Single-instance lockfile (R17) ──────────────────────────────────────
const lockPath = path.join(dataDir, '.sovereign.lock')
function acquireLock(): void {
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8')
    const prev = JSON.parse(raw) as { pid: number; startedAt: number; host: string }
    if (prev.pid && prev.pid !== process.pid) {
      try {
        process.kill(prev.pid, 0) // probe — throws ESRCH if not running
        console.error(
          `[lockfile] another Sovereign is running (pid ${prev.pid}, started ${new Date(prev.startedAt).toISOString()}, host ${prev.host}).`
        )
        console.error(`[lockfile] Refusing to boot. Stop the other instance or delete ${lockPath} if stale.`)
        process.exit(1)
      } catch {
        console.warn(`[lockfile] stale lock from pid ${prev.pid} — claiming it`)
      }
    }
  } catch {
    /* no lock yet — fall through */
  }
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now(), host }))
}
function releaseLock(): void {
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8')
    const prev = JSON.parse(raw) as { pid: number }
    if (prev.pid === process.pid) fs.unlinkSync(lockPath)
  } catch {
    /* gone — fine */
  }
}
acquireLock()

const { shutdown } = bootstrapServer({ app, server, wss, bus, dataDir, configStore })

function shutdownWithLock() {
  try {
    shutdown()
  } finally {
    releaseLock()
  }
}

process.on('SIGTERM', shutdownWithLock)
process.on('SIGINT', shutdownWithLock)
process.on('exit', releaseLock)

const clientDist = path.resolve(__dirname, '../../client/dist')
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist))
  app.use((_req, res, next) => {
    if (_req.path.startsWith('/api') || _req.path.startsWith('/ws')) return next()
    const indexPath = path.join(clientDist, 'index.html')
    if (fs.existsSync(indexPath)) {
      res.setHeader('Content-Type', 'text/html')
      res.send(fs.readFileSync(indexPath, 'utf-8'))
    } else next()
  })
  console.log(`Serving client from ${clientDist}`)
}

server.listen(Number(port), host, () => console.log(`Server running at ${useTls ? 'https' : 'http'}://${host}:${port}`))
