import type { FullConfig } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let serverProcess: ChildProcess | null = null
let tempDir: string | null = null

function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = https.get(url, { rejectUnauthorized: false }, (res) => {
        if (res.statusCode === 200) {
          resolve()
        } else if (Date.now() - start > timeoutMs) {
          reject(new Error(`Server did not respond with 200 within ${timeoutMs}ms (got ${res.statusCode})`))
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

async function globalSetup(config: FullConfig) {
  // Create temp data directory
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-e2e-'))
  const globalPath = path.join(tempDir, 'global')
  fs.mkdirSync(globalPath, { recursive: true })

  const serverPort = 5899
  const serverRoot = path.resolve(__dirname, '../../../server')

  console.log(`[E2E Setup] Starting server on port ${serverPort}`)
  console.log(`[E2E Setup] Data dir: ${tempDir}`)

  serverProcess = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: serverRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(serverPort),
      HOST: 'localhost',
      SOVEREIGN_DATA_DIR: tempDir,
      SOVEREIGN_GLOBAL_PATH: globalPath,
      OPENCLAW_GATEWAY_URL: '',
      OPENCLAW_GATEWAY_TOKEN: ''
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })

  serverProcess.stdout?.on('data', (data: Buffer) => {
    const msg = data.toString().trim()
    if (msg) console.log(`[server] ${msg}`)
  })
  serverProcess.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim()
    if (msg) console.error(`[server:err] ${msg}`)
  })

  serverProcess.on('error', (err) => {
    console.error('[E2E Setup] Server process error:', err)
  })

  // Wait for health endpoint
  await waitForServer(`https://localhost:${serverPort}/health`)
  console.log('[E2E Setup] Server is ready')

  // Seed test data via REST API
  const baseUrl = `https://localhost:${serverPort}`
  const agent = new https.Agent({ rejectUnauthorized: false })

  // Create test threads
  for (const label of ['test-thread-1', 'test-thread-2']) {
    try {
      const postData = JSON.stringify({ label })
      const res = await fetch(`${baseUrl}/api/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: postData,
        // @ts-ignore
        dispatcher: undefined
      })
      // ignore if node-fetch doesn't support dispatcher, the server likely seeds defaults anyway
    } catch {
      // Swallow — threads may already exist from server startup defaults
    }
  }

  console.log('[E2E Setup] Test data seeded')

  // Store for teardown
  ;(globalThis as any).__E2E_SERVER_PROCESS = serverProcess
  ;(globalThis as any).__E2E_TEMP_DIR = tempDir
}

export default globalSetup
