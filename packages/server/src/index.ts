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

// --- Phase 1: Foundation ---
import { createScheduler } from './scheduler/scheduler.js'
import { registerSchedulerChannel } from './scheduler/ws.js'
import { registerNotificationsChannel } from './notifications/ws.js'

// --- Phase 2: Orgs, Projects & Code ---
import { createOrgManager } from './orgs/orgs.js'
import { createOrgRoutes } from './orgs/routes.js'
import { registerOrgsChannel } from './orgs/ws.js'
import { createFileService } from './files/files.js'
import { createFileRouter } from './files/routes.js'
import { registerFilesChannel } from './files/ws.js'
import { createGitCli } from './git/git.js'
import { createGitService } from './git/service.js'
import { createGitRoutes } from './git/routes.js'
import { registerGitChannel } from './git/ws.js'
import { createTerminalManager } from './terminal/terminal.js'
import { createTerminalRoutes } from './terminal/routes.js'
import { registerTerminalChannel } from './terminal/ws.js'
import { createWorktreeManager } from './worktrees/worktrees.js'
import { createWorktreeRouter } from './worktrees/routes.js'
import { registerWorktreesChannel } from './worktrees/ws.js'

// --- Phase 3: Config & Protocol ---
import { createConfigStore } from './config/config.js'
import { createConfigRouter } from './config/routes.js'

// --- Phase 4: Diff, Issues, Review, Radicle ---
import { createChangeSetManager } from './diff/changeset.js'
import { createDiffRouter } from './diff/routes.js'
import { createIssueTracker } from './issues/issues.js'
import { createIssueRouter } from './issues/routes.js'
import { createReviewSystem } from './review/review.js'
import { createReviewRouter } from './review/routes.js'
import { createRadicleManager } from './radicle/radicle.js'
import { createRadicleRouter } from './radicle/routes.js'

// --- Phase 5: Planning ---
import { createPlanningService } from './planning/planning.js'
import { createPlanningRouter } from './planning/routes.js'
import { registerPlanningWs } from './planning/ws.js'

// --- Phase 6: Chat, Threads, Voice, Recordings, System ---
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
import { createRecordingsService } from './recordings/recordings.js'
import { registerRecordingRoutes } from './recordings/routes.js'
import { createSystemModule } from './system/system.js'
import { createSystemRoutes } from './system/routes.js'
import { registerLogsChannel } from './system/ws.js'

// ============================================================
// App setup
// ============================================================

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
const dataDir = process.env.SOVEREIGN_DATA_DIR || path.join(process.cwd(), '.data')
fs.mkdirSync(dataDir, { recursive: true })
const bus = createEventBus(dataDir)

// --- Passthrough auth middleware (no real auth enforcement yet) ---
const authMiddleware = (_req: any, _res: any, next: any) => next()

// --- Phase 3: WS handler ---
const wsHandler = createWsHandler(bus)

// ============================================================
// Phase 1 — Foundation
// ============================================================

const scheduler = createScheduler(bus, dataDir)
registerSchedulerChannel(wsHandler, bus)
registerNotificationsChannel(wsHandler, bus)

// ============================================================
// Phase 2 — Orgs, Projects & Code
// ============================================================

const orgManager = createOrgManager(bus, dataDir)

// Bootstrap global workspace
if (!orgManager.getOrg('_global')) {
  const globalOrgPath = path.join(dataDir, 'orgs', '_global')
  fs.mkdirSync(globalOrgPath, { recursive: true })
  orgManager.createOrg({ id: '_global', name: 'Global', path: globalOrgPath, provider: 'radicle' })
}

app.use('/api', createOrgRoutes(orgManager, authMiddleware))
registerOrgsChannel(wsHandler, bus)

const fileService = createFileService(bus)
app.use('/api/files', createFileRouter(fileService))
registerFilesChannel(wsHandler, bus)

// Project resolver: maps orgId+projectId to filesystem path
const resolveProject = (orgId: string, projectId: string, _worktreeId?: string) => {
  const project = orgManager.getProject(orgId, projectId)
  if (project) {
    return { repoPath: project.repoPath, defaultBranch: project.defaultBranch ?? 'main' }
  }
  return { repoPath: path.join(dataDir, 'projects', orgId, projectId), defaultBranch: 'main' }
}

const gitCli = createGitCli()
const gitService = createGitService(bus, gitCli, resolveProject)
app.use('/api/git', createGitRoutes(gitService, authMiddleware))
registerGitChannel(wsHandler, bus)

const terminalManager = createTerminalManager(bus, {
  validateCwd: () => true,
  gracePeriodMs: 10_000
})
app.use('/api/terminal', createTerminalRoutes(terminalManager))
registerTerminalChannel(wsHandler, bus, terminalManager)

const worktreeManager = createWorktreeManager(bus, dataDir, {
  getProject: (orgId, projectId) => {
    const p = orgManager.getProject(orgId, projectId)
    if (!p) return undefined
    return { repoPath: p.repoPath, defaultBranch: p.defaultBranch ?? 'main' }
  }
})
app.use(createWorktreeRouter(worktreeManager, authMiddleware))
registerWorktreesChannel(wsHandler, bus)

// ============================================================
// Phase 3 — Config & Protocol
// ============================================================

const configStore = createConfigStore(bus, dataDir)
app.use('/api/config', createConfigRouter(configStore))

// ============================================================
// Phase 4 — Diff, Issues, Review, Radicle
// ============================================================

const changeSetManager = createChangeSetManager(bus, dataDir)
app.use(createDiffRouter(changeSetManager))

const getRemotes = (_orgId: string, _projectId: string) =>
  [] as Array<{ name: string; provider: 'github' | 'radicle'; repo?: string; rid?: string }>
const issueTracker = createIssueTracker(bus, dataDir, getRemotes)
app.use(createIssueRouter(issueTracker))

const reviewSystem = createReviewSystem(bus, dataDir, {
  removeWorktree: (worktreeId: string) => worktreeManager.remove('_global', '_default', worktreeId),
  getChangeSet: (id: string) => changeSetManager.getChangeSet(id),
  updateChangeSet: (id: string, patch: any) => changeSetManager.updateChangeSet(id, patch),
  getProvider: (_orgId: string, _projectId: string) => {
    throw new Error('No review provider configured')
  }
})
app.use(createReviewRouter(reviewSystem))

const radicleManager = createRadicleManager(bus, dataDir)
app.use('/api/radicle', createRadicleRouter(radicleManager))

// ============================================================
// Phase 5 — Planning
// ============================================================

const planningService = createPlanningService(bus, dataDir, {
  issueTracker,
  getConfig: () => ({})
})
app.use(createPlanningRouter(planningService))
registerPlanningWs(wsHandler, bus)

// ============================================================
// Phase 6 — Chat, Threads, Voice, Recordings, System
// ============================================================

const backend = createOpenClawBackend({
  gatewayUrl: process.env.OPENCLAW_GATEWAY_URL ?? 'ws://localhost:3456/ws',
  dataDir,
  onConfigChange: (_cb) => {}
})

const threadManager = createThreadManager(bus, dataDir)
const chatModule = createChatModule(bus, backend, threadManager, { dataDir, wsHandler })
registerChatWs(wsHandler, chatModule)
app.use(createChatRoutes(chatModule, backend))

const forwardHandler = createForwardHandler(bus, threadManager)
app.use(createThreadRoutes(threadManager, forwardHandler))
registerThreadsWs(wsHandler as any, threadManager, bus)

const voiceModule = createVoiceModule(bus, {
  transcribeUrl: process.env.VOICE_TRANSCRIBE_URL,
  ttsUrl: process.env.VOICE_TTS_URL
})
app.use(createVoiceRoutes(voiceModule))

const recordingsService = createRecordingsService(dataDir)
app.use(registerRecordingRoutes(recordingsService))

const systemModule = createSystemModule(bus, dataDir)
app.use(createSystemRoutes(systemModule))
registerLogsChannel(wsHandler, bus)

// ============================================================
// Status Aggregator
// ============================================================

const statusAggregator = createStatusAggregator(bus, {
  modules: [
    { name: 'chat', status: () => chatModule.status() },
    {
      name: 'voice',
      status: () => {
        const vs = voiceModule.status()
        return { name: vs.module, status: vs.status as 'ok' | 'degraded' | 'error' }
      }
    },
    { name: 'radicle', status: () => radicleManager.status() },
    { name: 'config', status: () => configStore.status() },
    {
      name: 'planning',
      status: () => {
        const ps = planningService.status()
        return { name: 'planning', status: ps.status as 'ok' | 'degraded' | 'error' }
      }
    },
    {
      name: 'system',
      status: () => {
        const ss = systemModule.status()
        return { name: 'system', status: ss.healthy ? ('ok' as const) : ('degraded' as const) }
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

// ============================================================
// WebSocket connection handler
// ============================================================

wss.on('connection', (ws) => {
  const deviceId = Math.random().toString(36).slice(2)
  wsHandler.handleConnection(ws as any, deviceId)

  const initial = { type: 'status.update', payload: statusAggregator.getStatus() }
  ws.send(JSON.stringify(initial))
})

// ============================================================
// Connect agent backend
// ============================================================

backend.connect().catch((err) => {
  console.error('Failed to connect agent backend:', err.message)
})

// ============================================================
// Graceful shutdown
// ============================================================

function shutdown() {
  scheduler.destroy()
  terminalManager.dispose()
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
