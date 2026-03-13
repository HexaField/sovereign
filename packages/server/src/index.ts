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
import { createWsHandler } from './ws/handler.js'
import { createOpenClawBackend } from './agent-backend/openclaw.js'
import { createThreadManager } from './threads/threads.js'
import { createChatModule } from './chat/chat.js'
import { createChatRoutes } from './chat/routes.js'
import { registerChatWs } from './chat/ws.js'
import { createThreadRoutes } from './threads/routes.js'
import { registerThreadsWs } from './threads/ws.js'
import { createForwardHandler } from './threads/forward.js'
import { createVoiceModule } from './voice/voice.js'
import { createVoiceRoutes } from './voice/routes.js'

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

// --- Phase 3: WS handler ---
const wsHandler = createWsHandler(bus)

// --- Phase 6: Agent Backend ---
const backend = createOpenClawBackend({
  gatewayUrl: process.env.OPENCLAW_GATEWAY_URL ?? 'ws://localhost:3456/ws',
  dataDir,
  onConfigChange: (_cb) => {
    // Hot-reload support — config module can call cb() with new values
  }
})

// --- Phase 6: Thread Manager ---
const threadManager = createThreadManager(bus, dataDir)

// --- Phase 6: Chat Module ---
const chatModule = createChatModule(bus, backend, threadManager, { dataDir, wsHandler })
registerChatWs(wsHandler, chatModule)
app.use(createChatRoutes(chatModule, backend))

// --- Phase 6: Thread Routes + WS ---
const forwardHandler = createForwardHandler(bus, threadManager)
app.use(createThreadRoutes(threadManager, forwardHandler))
registerThreadsWs(wsHandler as any, threadManager, bus)

// --- Phase 6: Voice Module ---
const voiceModule = createVoiceModule(bus, {
  transcribeUrl: process.env.VOICE_TRANSCRIBE_URL,
  ttsUrl: process.env.VOICE_TTS_URL
})
app.use(createVoiceRoutes(voiceModule))

// --- Status Aggregator ---
const statusAggregator = createStatusAggregator(bus, {
  modules: [
    { name: 'chat', status: () => chatModule.status() },
    {
      name: 'voice',
      status: () => {
        const vs = voiceModule.status()
        return { name: vs.module, status: vs.status as 'ok' | 'degraded' | 'error' }
      }
    }
  ],
  pushToClients: (update) => {
    const msg = JSON.stringify(update)
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(msg)
    }
  }
})

wss.on('connection', (ws) => {
  const deviceId = Math.random().toString(36).slice(2)
  wsHandler.handleConnection(ws as any, deviceId)

  // Send initial status immediately
  const initial = { type: 'status.update', payload: statusAggregator.getStatus() }
  ws.send(JSON.stringify(initial))
})

// --- Connect agent backend ---
backend.connect().catch((err) => {
  console.error('Failed to connect agent backend:', err.message)
})

// --- Graceful shutdown ---
function shutdown() {
  backend.disconnect().catch(() => {})
  statusAggregator.destroy()
  wss.close()
  server.close()
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

server.listen(Number(port), host, () => {
  console.log(`Server running at https://${host}:${port}`)
})
