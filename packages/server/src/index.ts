import dotenv from 'dotenv'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'

dotenv.config({ path: '.env.local' })
dotenv.config()

import cors from 'cors'
import express from 'express'
import { WebSocketServer } from 'ws'
import { createEventBus } from '@template/core'
import healthRouter from './routes/health'
import { createStatusAggregator } from './status/status.js'

const app = express()
const port = process.env.PORT || 3001
const host = process.env.HOST || 'localhost'

app.use(cors())
app.use(express.json())

app.use('/health', healthRouter)

const options = {
  key: fs.readFileSync(path.join(process.cwd(), '../../.certs/localhost.key')),
  cert: fs.readFileSync(path.join(process.cwd(), '../../.certs/localhost.cert'))
}

const server = https.createServer(options, app)

// --- WebSocket setup ---
const wss = new WebSocketServer({ server, path: '/ws' })
const dataDir = path.join(process.cwd(), '.data')
fs.mkdirSync(dataDir, { recursive: true })
const bus = createEventBus(dataDir)

const statusAggregator = createStatusAggregator(bus, {
  modules: [],
  pushToClients: (update) => {
    const msg = JSON.stringify(update)
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(msg)
    }
  }
})

wss.on('connection', (ws) => {
  // Send initial status immediately
  const initial = { type: 'status.update', payload: statusAggregator.getStatus() }
  ws.send(JSON.stringify(initial))
})

server.listen(Number(port), host, () => {
  console.log(`Server running at https://${host}:${port}`)
})
