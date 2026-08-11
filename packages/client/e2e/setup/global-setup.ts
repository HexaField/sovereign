// E2E global setup — starts a fully isolated Sovereign server.
//
// Production isolation (NON-NEGOTIABLE):
//   - Isolated SOVEREIGN_CONFIG_DIR  (temp dir, not ~/.sovereign)
//   - Isolated SOVEREIGN_DATA_DIR    (temp dir, not ~/.sovereign/data)
//   - Dedicated port 5899            (not 5801, not 5811)
//   - TLS disabled                   (no cert dependency)
//   - No agent backends enabled      (no external API calls)
//   - Fresh config.json written into the temp dir each run
//
// The server reads host/port from config.json via the config store, NOT
// from PORT/HOST env vars. Setting SOVEREIGN_CONFIG_DIR to the temp dir
// ensures the server never touches the production config.

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── E2E isolation constants ────────────────────────────────────────────
// Port 5899 — differs from production (5801) and wind tunnel (5811).
export const E2E_PORT = 5899
export const E2E_HOST = '127.0.0.1'

let serverProcess: ChildProcess | null = null

function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(url, (res) => {
        if (res.statusCode === 200) {
          resolve()
        } else if (Date.now() - start > timeoutMs) {
          reject(new Error(`Server responded ${res.statusCode}, not 200, within ${timeoutMs}ms`))
        } else {
          setTimeout(check, 300)
        }
      })
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Server did not start within ${timeoutMs}ms`))
        } else {
          setTimeout(check, 300)
        }
      })
    }
    check()
  })
}

export default async function globalSetup() {
  // ── Create fully isolated temp directories ───────────────────────────
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-e2e-'))
  const configDir = path.join(tmpBase, 'config')
  const dataDir = path.join(tmpBase, 'data')
  fs.mkdirSync(configDir, { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })

  // ── Write minimal test config ────────────────────────────────────────
  // TLS disabled, isolated port, no agent backends. The server merges
  // this with code defaults — only what differs needs specifying.
  const testConfig = {
    server: {
      port: E2E_PORT,
      host: E2E_HOST,
      tls: { enabled: false }
    },
    workspace: {
      root: tmpBase,
      globalPath: ''
    },
    agentBackend: {
      default: 'mock',
      claudeCode: {
        // Point agentDir at the temp dir so the personality compiler and
        // orphan cleanup never resolve to production ~/.claude.
        agentDir: path.join(tmpBase, '.claude'),
        cwd: tmpBase
      }
    }
  }
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(testConfig, null, 2))

  const serverRoot = path.resolve(__dirname, '../../../server')

  console.log(`[E2E Setup] Isolated test server — port ${E2E_PORT}`)
  console.log(`[E2E Setup] Config dir: ${configDir}`)
  console.log(`[E2E Setup] Data dir:   ${dataDir}`)

  // ── Start the server with isolated config + data ─────────────────────
  // SOVEREIGN_CONFIG_DIR controls which config.json the server reads.
  // SOVEREIGN_DATA_DIR controls where threads, logs, lockfile, etc. go.
  // Together these ensure zero overlap with production state.
  serverProcess = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SOVEREIGN_CONFIG_DIR: configDir,
      SOVEREIGN_DATA_DIR: dataDir
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })

  serverProcess.stdout?.on('data', (d: Buffer) => {
    const msg = d.toString().trim()
    if (msg) console.log(`[e2e-server] ${msg}`)
  })
  serverProcess.stderr?.on('data', (d: Buffer) => {
    const msg = d.toString().trim()
    if (msg) console.error(`[e2e-server:err] ${msg}`)
  })

  serverProcess.on('error', (err) => {
    console.error('[E2E Setup] Server process error:', err)
  })

  // Health check over plain HTTP (TLS disabled in test config)
  await waitForServer(`http://${E2E_HOST}:${E2E_PORT}/health`)
  console.log(`[E2E Setup] Server ready on :${E2E_PORT} (isolated)`)

  // Store for teardown
  ;(globalThis as any).__E2E_SERVER_PROCESS = serverProcess
  ;(globalThis as any).__E2E_TEMP_DIR = tmpBase
}
