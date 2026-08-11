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
import { createLockfile } from './lockfile.js'

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
// Policy + tests live in ./lockfile.ts; this module only logs the decision.
const lockPath = path.join(dataDir, '.sovereign.lock')
const lockfile = createLockfile({ lockPath, host })
const acquired = lockfile.acquire()
if (acquired.outcome === 'refused') {
  const { pid, startedAt, host: holderHost } = acquired.previous
  console.error(
    `[lockfile] another Sovereign is running (pid ${pid}, started ${new Date(startedAt).toISOString()}, host ${holderHost}).`
  )
  console.error(`[lockfile] Refusing to boot. Stop the other instance or delete ${lockPath} if stale.`)
  process.exit(1)
} else if (acquired.reason === 'stale-pid') {
  console.warn(`[lockfile] stale lock from pid ${acquired.previous?.pid} — claiming it`)
} else if (acquired.reason === 'holder-not-sovereign') {
  console.warn(`[lockfile] pid ${acquired.previous?.pid} is alive but is not a Sovereign process — claiming stale lock`)
}
const releaseLock = () => lockfile.release()

// Watch our own lock. Losing it while still running means the single-instance
// guard is disarmed, and nothing else notices — exactly the shape of the
// 2026-08-01 incident, where a second (system-scope) unit ran
// `ExecStartPre=/bin/rm -f .sovereign.lock` before every start attempt and
// quietly deleted this instance's lock ~5 times a minute for 58 hours. Warn on
// each state change, and re-assert ownership so the guard heals itself.
let lastOwnership: ReturnType<typeof lockfile.checkOwnership> = 'held'
const ownershipWatch = setInterval(() => {
  const state = lockfile.checkOwnership()
  if (state === lastOwnership) return
  lastOwnership = state
  if (state === 'missing') {
    console.warn(`[lockfile] our lock at ${lockPath} vanished — another process is deleting it. Re-asserting.`)
    lockfile.acquire()
    lastOwnership = lockfile.checkOwnership()
  } else if (state === 'stolen') {
    console.error(
      `[lockfile] our lock at ${lockPath} is now held by pid ${lockfile.read()?.pid} — two instances are racing.`
    )
  }
}, 30_000)
if (typeof ownershipWatch.unref === 'function') ownershipWatch.unref()

const { shutdown } = bootstrapServer({ app, server, wss, bus, configDir, dataDir, configStore })

// Fast shutdown: snapshot every subsystem synchronously and exit. Any
// in-flight LLM turn is severed at whatever point it reached — the SDK
// writes the interrupt marker to JSONL, the resume orchestrator's Tier 3
// fires `[Resumed after server restart. Continue from where you left off.]`
// on the next boot to kick the conversation back into motion. Preferred
// over a drain because a rebuild is often triggered from *inside* an
// in-flight session (e.g. `bin/sovereign build` run through the agent) —
// waiting for that session to complete is a self-referential deadlock.
//
// MUST call process.exit(). Registering a SIGINT/SIGTERM listener overrides
// Node's default terminate-on-signal, so without an explicit exit the process
// survives its own shutdown whenever any handle is still open — and Sovereign
// always has open handles (Claude Code SDK subprocesses, sockets, intervals).
// The observed failure: systemd sends SIGINT, the process cleans up but keeps
// running, systemd gives up tracking it, the process is re-parented to init,
// and it holds `.sovereign.lock` + :5801 against every subsequent start. That
// is what produced a 58-hour restart loop.
let shuttingDown = false
function shutdownWithLock(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  try {
    shutdown()
  } catch (err) {
    console.error(`[server] shutdown threw during ${signal}:`, err)
  } finally {
    releaseLock()
  }
  // Give in-flight writes a tick to flush, then exit unconditionally. The
  // timer is unref'd so it cannot itself keep the loop alive.
  const t = setTimeout(() => process.exit(0), 250)
  if (typeof t.unref === 'function') t.unref()
  // Backstop: if something re-entrant blocks the timer, hard-exit anyway.
  const hard = setTimeout(() => process.exit(0), 5_000)
  if (typeof hard.unref === 'function') hard.unref()
}

process.on('SIGTERM', () => shutdownWithLock('SIGTERM'))
process.on('SIGINT', () => shutdownWithLock('SIGINT'))
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
