import dotenv from 'dotenv'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

dotenv.config({ path: '.env.local' })
dotenv.config()

import cors from 'cors'
import express from 'express'
import { WebSocketServer } from 'ws'
import { createEventBus } from '@sovereign/core'
import healthRouter from './routes/health.js'
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
import { createLogger } from './system/logger.js'
import { createEventStream } from './system/event-stream.js'
import { createNotifications } from './notifications/notifications.js'
import { createNotificationRoutes } from './notifications/routes.js'

// ============================================================
// App setup
// ============================================================

const app = express()
const port = process.env.PORT || 3001
const host = process.env.HOST || 'localhost'

app.use(cors())
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../../..')

app.use(express.json())

app.use('/health', healthRouter)

const options = {
  key: fs.readFileSync(path.join(repoRoot, '.certs/localhost.key')),
  cert: fs.readFileSync(path.join(repoRoot, '.certs/localhost.cert'))
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
// SOVEREIGN_GLOBAL_PATH overrides the default data-dir-based path
const globalPath = process.env.SOVEREIGN_GLOBAL_PATH || path.join(dataDir, 'orgs', '_global')
if (!orgManager.getOrg('_global')) {
  fs.mkdirSync(globalPath, { recursive: true })
  orgManager.createOrg({ id: '_global', name: 'Global', path: globalPath, provider: 'radicle' })
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
  gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN ?? '',
  dataDir,
  onConfigChange: (_cb) => {}
})

const threadManager = createThreadManager(bus, dataDir)

// Seed default threads for global workspace
const defaultThreads = [
  { label: 'main', displayLabel: 'Main' },
  { label: 'upgrades', displayLabel: 'Upgrades' },
  { label: 'v2-app', displayLabel: 'Sovereign Development' }
]
for (const { label } of defaultThreads) {
  if (!threadManager.get(label)) {
    threadManager.create({ label })
  }
}

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

const systemModule = createSystemModule(bus, dataDir, {
  wsHandler,
  getAgentBackendStatus: () => backend.status()
})
const logsChannel = registerLogsChannel(wsHandler, bus, dataDir)
app.use(createSystemRoutes({ system: systemModule, logsChannel, dataDir }))

// --- Event Stream ---
const eventStream = createEventStream(bus)

// Event stream routes
import { Router as EventRouter } from 'express'
const eventStreamRouter = EventRouter()
eventStreamRouter.get('/api/system/events', (req, res) => {
  const { type, source, since, until, entityId, limit, offset } = req.query as Record<string, string | undefined>
  const filter: Record<string, unknown> = {}
  if (type) filter.type = type
  if (source) filter.source = source
  if (since) filter.since = Number(since)
  if (until) filter.until = Number(until)
  if (entityId) filter.entityId = entityId
  if (limit) filter.limit = Number(limit)
  if (offset) filter.offset = Number(offset)
  const entries = eventStream.query(filter as any)
  res.json({ events: entries, total: entries.length })
})
eventStreamRouter.get('/api/system/events/stats', (_req, res) => {
  res.json(eventStream.stats())
})
app.use(eventStreamRouter)

// Event stream WS channel
wsHandler.registerChannel('events', {
  serverMessages: ['event.new', 'event.history'],
  clientMessages: [],
  onSubscribe: (deviceId) => {
    const recent = eventStream.query({ limit: 100 })
    wsHandler.sendTo(deviceId, {
      type: 'event.history',
      events: recent,
      timestamp: new Date().toISOString()
    })
  }
})
eventStream.subscribe((entry) => {
  wsHandler.broadcastToChannel('events', {
    type: 'event.new',
    ...entry,
    timestamp: new Date().toISOString()
  })
})

// --- Notifications module ---
const notificationsModule = createNotifications(bus, dataDir)
app.use(createNotificationRoutes(notificationsModule))

// --- Bus wildcard logging (debug level) ---
const sysLogger = createLogger(logsChannel, 'bus')
bus.on('*', (event) => {
  // Don't log log.entry events to avoid infinite recursion
  if (event.type === 'log.entry') return
  sysLogger.debug(`${event.type}`, { metadata: { source: event.source } })
})

// --- Targeted module-level logging ---
const moduleLogger = createLogger(logsChannel, 'modules')

bus.on('issue.created', (event) => {
  const payload = event.payload as Record<string, unknown>
  moduleLogger.info(`Issue created: ${payload?.title ?? 'unknown'}`, { entityId: payload?.id as string })
})

bus.on('issue.updated', (event) => {
  const payload = event.payload as Record<string, unknown>
  moduleLogger.info(`Issue updated: ${payload?.title ?? 'unknown'}`, { entityId: payload?.id as string })
})

bus.on('review.merged', (event) => {
  const payload = event.payload as Record<string, unknown>
  moduleLogger.info(`Review merged: ${payload?.title ?? 'unknown'}`, { entityId: payload?.id as string })
})

bus.on('scheduler.job.failed', (event) => {
  const payload = event.payload as Record<string, unknown>
  moduleLogger.error(`Scheduled job failed: ${payload?.jobName ?? 'unknown'}`)
})

bus.on('config.changed', (event) => {
  const payload = event.payload as Record<string, unknown>
  moduleLogger.info(`Config changed: ${payload?.key ?? 'unknown'}`)
})

bus.on('webhook.received', (event) => {
  const payload = event.payload as Record<string, unknown>
  moduleLogger.info(`Webhook received from ${event.source}`, { metadata: { type: payload?.type } })
})

// --- Register all modules with system ---
systemModule.registerModule({
  name: 'scheduler',
  status: 'healthy',
  subscribes: ['scheduler.job.*'],
  publishes: ['scheduler.job.due', 'scheduler.job.started', 'scheduler.job.completed']
})
systemModule.registerModule({
  name: 'orgs',
  status: 'healthy',
  subscribes: [],
  publishes: ['org.created', 'org.updated', 'org.deleted']
})
systemModule.registerModule({
  name: 'files',
  status: 'healthy',
  subscribes: [],
  publishes: ['file.created', 'file.deleted']
})
systemModule.registerModule({ name: 'git', status: 'healthy', subscribes: [], publishes: ['git.status.changed'] })
systemModule.registerModule({
  name: 'terminal',
  status: 'healthy',
  subscribes: [],
  publishes: ['terminal.created', 'terminal.closed']
})
systemModule.registerModule({
  name: 'worktrees',
  status: 'healthy',
  subscribes: [],
  publishes: ['worktree.created', 'worktree.removed']
})
systemModule.registerModule({
  name: 'config',
  status: 'healthy',
  subscribes: ['config.changed'],
  publishes: ['config.changed']
})
systemModule.registerModule({
  name: 'diff',
  status: 'healthy',
  subscribes: [],
  publishes: ['changeset.created', 'changeset.updated']
})
systemModule.registerModule({
  name: 'issues',
  status: 'healthy',
  subscribes: [],
  publishes: ['issue.created', 'issue.updated']
})
systemModule.registerModule({
  name: 'review',
  status: 'healthy',
  subscribes: [],
  publishes: ['review.created', 'review.updated', 'review.merged']
})
systemModule.registerModule({
  name: 'radicle',
  status: 'healthy',
  subscribes: [],
  publishes: ['radicle.repo.init', 'radicle.peer.connected']
})
systemModule.registerModule({
  name: 'planning',
  status: 'healthy',
  subscribes: ['issue.*'],
  publishes: ['planning.graph.updated']
})
systemModule.registerModule({ name: 'chat', status: 'healthy', subscribes: [], publishes: [] })
systemModule.registerModule({ name: 'threads', status: 'healthy', subscribes: [], publishes: [] })
systemModule.registerModule({ name: 'voice', status: 'healthy', subscribes: [], publishes: [] })
systemModule.registerModule({ name: 'recordings', status: 'healthy', subscribes: [], publishes: [] })
systemModule.registerModule({
  name: 'notifications',
  status: 'healthy',
  subscribes: ['notification.*'],
  publishes: ['notification.new']
})

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
  systemModule.dispose()
  eventStream.dispose()
  notificationsModule.dispose()
  wss.close()
  server.close()
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// ============================================================
// Static file serving (production mode)
// ============================================================
// In production, serve the built client from ../client/dist/
// In dev, Vite dev server handles this with proxy to our API
const clientDist = path.resolve(__dirname, '../../client/dist')
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist))
  // SPA fallback — serve index.html for all non-API, non-WS routes
  app.use((_req, res, next) => {
    if (_req.path.startsWith('/api') || _req.path.startsWith('/ws')) {
      next()
      return
    }
    const indexPath = path.join(clientDist, 'index.html')
    if (fs.existsSync(indexPath)) {
      res.setHeader('Content-Type', 'text/html')
      res.send(fs.readFileSync(indexPath, 'utf-8'))
    } else {
      next()
    }
  })
  console.log(`Serving client from ${clientDist}`)
}

server.listen(Number(port), host, () => {
  console.log(`Server running at https://${host}:${port}`)
})
