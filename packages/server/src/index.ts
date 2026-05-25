// Sovereign server entry point — transport + listen only. All module
// composition lives in `bootstrap.ts`.

import dotenv from 'dotenv'
import fs from 'node:fs'
import https from 'node:https'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cors from 'cors'
import express from 'express'
import { WebSocketServer } from 'ws'

process.on('unhandledRejection', (r) => console.error('[server] Unhandled rejection:', r))
dotenv.config({ path: '.env.local' })
dotenv.config()

import { createEventBus } from '@sovereign/core'
import healthRouter from './routes/health.js'
import { bootstrapServer } from './bootstrap.js'

const app = express()
const port = process.env.PORT || 3001
const host = process.env.HOST || 'localhost'
app.use(cors())
app.use(express.json())
app.use('/health', healthRouter)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../..')
const useTls = process.env.SOVEREIGN_TLS !== 'false'
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
const dataDir = process.env.SOVEREIGN_DATA_DIR || path.join(process.cwd(), '.data')
fs.mkdirSync(dataDir, { recursive: true })
const bus = createEventBus(dataDir)

const { shutdown } = bootstrapServer({ app, server, wss, bus, dataDir })

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

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
