// Sovereign server entry point — resolves data dir, loads config, builds the
// transport from the resolved config, then hands off to bootstrap.ts.
//
// Every former env-var read (HOST/PORT/SOVEREIGN_TLS/...) now flows through
// {SOVEREIGN_DATA_DIR}/config.json. SOVEREIGN_DATA_DIR is the only remaining
// process.env read.

import fs from 'node:fs'
import https from 'node:https'
import http from 'node:http'
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

// ── Data dir (only remaining env-var read) ──────────────────────────────
const dataDir = process.env.SOVEREIGN_DATA_DIR || path.join(process.cwd(), '.data')
fs.mkdirSync(dataDir, { recursive: true })
console.log(
  `Data dir: ${dataDir}${process.env.SOVEREIGN_DATA_DIR ? '' : ' (defaulted — set SOVEREIGN_DATA_DIR to pin)'}`
)

// Drift guard: warn if a sibling sovereign data dir under ~/.openclaw/workspace
// exists but isn't the one we're using. This is the exact failure mode where
// threads/sessions silently disappear because the active dir is stale.
if (!process.env.SOVEREIGN_DATA_DIR) {
  const home = process.env.HOME ?? ''
  const siblingDataDir = path.join(home, '.openclaw', 'workspace', '.sovereign-data')
  if (fs.existsSync(path.join(siblingDataDir, 'threads', 'registry.json')) && siblingDataDir !== dataDir) {
    console.warn(`[data-dir] WARNING: another Sovereign data dir exists at ${siblingDataDir}.`)
    console.warn(
      `[data-dir] You are using the default (${dataDir}); state may diverge. Set SOVEREIGN_DATA_DIR to pick one explicitly.`
    )
  }
}

// ── Config (everything else) ────────────────────────────────────────────
const bus = createEventBus(dataDir)
const configStore = createConfigStore(bus, dataDir)

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
