import dotenv from 'dotenv'
import fs from 'node:fs'
import https from 'node:https'
import http from 'node:http'
import path from 'node:path'

// Prevent unhandled rejections from crashing the server
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled rejection:', reason)
})
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

// --- Drafts ---
import { createDraftStore } from './drafts/store.js'
import { createDraftRouter } from './drafts/routes.js'

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
import { createHealthHistory } from './system/health-history.js'
import { registerLogsChannel } from './system/ws.js'
import { createLogger } from './system/logger.js'
import { createEventStream } from './system/event-stream.js'
import { createNotifications } from './notifications/notifications.js'
import { createNotificationRoutes } from './notifications/routes.js'

// --- Phase 8: Meetings, Recording enhancements, Voice enhancements ---
import { createMeetingsService } from './meetings/meetings.js'
import { createSpeakerService } from './meetings/speakers.js'
import { createSummarizationPipeline } from './meetings/summarize.js'
import { createImportHandler } from './meetings/import.js'
import { registerMeetingRoutes } from './meetings/routes.js'
import { registerMeetingsChannel } from './meetings/ws.js'
import { createRetentionJob } from './meetings/retention.js'
import { createTranscriptionQueue } from './recordings/transcription.js'
import { registerRecordingsChannel } from './recordings/ws.js'
import { createTranscriptSearch } from './recordings/search.js'
import { createRuleBasedPostProcessor } from './voice/post-processor.js'
import { createAcknowledgmentGenerator } from './voice/acknowledgment.js'
import { createVoiceTranscriptionProvider } from './voice/provider.js'

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

const useTls = process.env.SOVEREIGN_TLS !== 'false'
let server: http.Server | https.Server

if (useTls) {
  const options = {
    key: fs.readFileSync(path.join(repoRoot, '.certs/localhost.key')),
    cert: fs.readFileSync(path.join(repoRoot, '.certs/localhost.cert'))
  }
  server = https.createServer(options, app)
} else {
  server = http.createServer(app)
}

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

// Auto-detect git projects in the global workspace
try {
  orgManager.autoDetectProjects('_global')
} catch {
  // Non-fatal — global workspace may not have scannable directories
}

app.use('/api', createOrgRoutes(orgManager, authMiddleware))
registerOrgsChannel(wsHandler, bus)

const fileService = createFileService(bus)
const fileProjectResolver = (projectId: string): string => {
  for (const org of orgManager.listOrgs()) {
    const projects = orgManager.listProjects(org.id)
    const p = projects.find((pr) => pr.id === projectId)
    if (p) return p.repoPath
  }
  return projectId // fallback: treat as path
}
app.use('/api/files', createFileRouter(fileService, undefined, fileProjectResolver))
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

function getRemotes(
  orgId: string,
  projectId: string
): Array<{ name: string; provider: 'github' | 'radicle'; repo?: string; rid?: string; projectId?: string }> {
  const allRemotes: Array<{
    name: string
    provider: 'github' | 'radicle'
    repo?: string
    rid?: string
    projectId?: string
  }> = []

  // Determine which projects to scan
  let projects: Array<{ id: string; repoPath: string }> = []
  if (projectId) {
    const project = orgManager.getProject(orgId, projectId)
    if (project) projects = [project]
    else {
      const all = orgManager.listProjects(orgId)
      const match = all.find((p) => p.id === projectId || p.name === projectId)
      if (match) projects = [match]
    }
  } else {
    projects = orgManager.listProjects(orgId)
  }

  for (const project of projects) {
    const remotes = parseGitRemotes(project.repoPath)
    for (const remote of remotes) {
      allRemotes.push({ ...remote, projectId: project.id })
    }
  }

  return allRemotes
}

function parseGitRemotes(
  repoPath: string
): Array<{ name: string; provider: 'github' | 'radicle'; repo?: string; rid?: string }> {
  try {
    const gitConfigPath = path.join(repoPath, '.git', 'config')
    if (!fs.existsSync(gitConfigPath)) return []
    const config = fs.readFileSync(gitConfigPath, 'utf-8')
    const remotes: Array<{ name: string; provider: 'github' | 'radicle'; repo?: string; rid?: string }> = []

    const remoteRegex = /\[remote\s+"([^"]+)"\]\s*\n([\s\S]*?)(?=\n\[|\n*$)/g
    let match
    while ((match = remoteRegex.exec(config)) !== null) {
      const remoteName = match[1]
      const section = match[2]
      const urlMatch = section.match(/url\s*=\s*(.+)/)
      if (!urlMatch) continue
      const url = urlMatch[1].trim()

      // GitHub: git@github.com:owner/repo.git or https://github.com/owner/repo.git
      const ghSsh = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?\/?$/)
      const ghHttps = url.match(/github\.com\/([^/]+\/[^/.]+?)(?:\.git)?\/?$/)
      if (ghSsh || ghHttps) {
        const repo = (ghSsh || ghHttps)![1]
        remotes.push({ name: remoteName, provider: 'github', repo })
        continue
      }

      // Radicle: rad:z... or similar
      const radMatch = url.match(/^rad:(.+)$/)
      if (radMatch) {
        remotes.push({ name: remoteName, provider: 'radicle', rid: radMatch[1] })
        continue
      }
    }

    return remotes
  } catch {
    return []
  }
}
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

// --- Drafts (created first so planning can include them) ---
const draftStore = createDraftStore(dataDir)

const planningService = createPlanningService(bus, dataDir, {
  issueTracker,
  getConfig: () => ({}),
  listOrgIds: () => orgManager.listOrgs().map((o: any) => o.id),
  draftStore
})
app.use(createPlanningRouter(planningService))
registerPlanningWs(wsHandler, bus)

app.use(createDraftRouter(bus, draftStore, { issueTracker, getRemotes }))

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
// Gateway sessions endpoint — returns all sessions from the OpenClaw gateway
// merged with local thread registry metadata (orgId, label overrides)
// MUST be before thread routes so /api/threads/gateway-sessions doesn't match :key
app.get('/api/threads/gateway-sessions', async (_req, res) => {
  try {
    const gatewaySessions = await (backend as any).listGatewaySessions()
    const localThreads = threadManager.list()
    const localMap = new Map(localThreads.map((t: any) => [t.key, t]))
    // Also map by full gateway key format
    for (const t of localThreads as any[]) {
      if (t.key === 'main') localMap.set('agent:main:main', t)
      else if (!t.key.startsWith('agent:')) localMap.set(`agent:main:thread:${t.key}`, t)
    }

    const merged = gatewaySessions
      .map((gs: any) => {
        const local = localMap.get(gs.key)
        // Derive kind from session key pattern
        const key = gs.key as string
        let kind = 'unknown'
        if (key === 'agent:main:main' || key === 'main') kind = 'main'
        else if (key.includes(':thread:')) kind = 'thread'
        else if (key.includes(':cron:')) kind = 'cron'
        else if (key.includes(':subagent:')) kind = 'subagent'

        // Derive short key (what the thread picker uses)
        let shortKey = key
        if (key.startsWith('agent:main:')) shortKey = key.slice('agent:main:'.length)
        if (shortKey.startsWith('thread:')) shortKey = shortKey.slice('thread:'.length)

        return {
          ...gs,
          kind,
          shortKey,
          orgId: local?.orgId,
          localLabel: local?.label,
          isRegistered: !!local
        }
      })
      // Filter: only main + thread sessions (skip cron, subagent, etc.)
      .filter((s: any) => s.kind === 'main' || s.kind === 'thread')

    res.json({ sessions: merged })
  } catch (err: any) {
    console.error('Failed to list gateway sessions:', err.message)
    res.status(500).json({ error: 'Failed to list gateway sessions' })
  }
})

app.use(createThreadRoutes(threadManager, forwardHandler))
registerThreadsWs(wsHandler as any, threadManager, bus)

const voiceModule = createVoiceModule(bus, {
  transcribeUrl: process.env.VOICE_TRANSCRIBE_URL,
  ttsUrl: process.env.VOICE_TTS_URL
})
app.use(createVoiceRoutes(voiceModule))

const recordingsService = createRecordingsService(dataDir)
app.use(registerRecordingRoutes(recordingsService))

// --- Phase 8: Meetings, Transcription, Search, Voice enhancements ---
const meetingsService = createMeetingsService(bus, dataDir)
const speakerService = createSpeakerService(dataDir)
void createRuleBasedPostProcessor()
void createAcknowledgmentGenerator()
const voiceTranscriptionProvider = createVoiceTranscriptionProvider(voiceModule)
const transcriptionQueue = createTranscriptionQueue(voiceTranscriptionProvider)
void createTranscriptSearch(recordingsService)

const summarizationPipeline = createSummarizationPipeline({
  bus,
  meetings: meetingsService,
  dataDir,
  onSummarize: async (_meeting, _transcriptText) => ({
    text: 'Auto-generated summary placeholder',
    actionItems: [],
    decisions: [],
    keyTopics: []
  })
})

const importHandler = createImportHandler({
  bus,
  meetings: meetingsService
})

void createRetentionJob(bus)

app.use(
  registerMeetingRoutes({
    meetings: meetingsService,
    speakers: speakerService,
    importHandler,
    summarization: summarizationPipeline,
    recordings: recordingsService,
    transcriptionQueue
  })
)

registerMeetingsChannel(wsHandler, bus)
registerRecordingsChannel(wsHandler, bus)

const systemModule = createSystemModule(bus, dataDir, {
  wsHandler,
  getAgentBackendStatus: () => backend.status()
})
const logsChannel = registerLogsChannel(wsHandler, bus, dataDir)
const healthHistory = createHealthHistory()
app.use(
  createSystemRoutes({ system: systemModule, logsChannel, dataDir, healthHistory, deviceInfoProvider: backend as any })
)

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
eventStreamRouter.post('/api/events/:id/retry', (req, res) => {
  const id = Number(req.params.id)
  const entries = eventStream.query({ limit: 5000 })
  const entry = entries.find((e) => e.id === id)
  if (!entry) {
    res.status(404).json({ error: 'Event not found' })
    return
  }
  // Re-emit the event on the bus
  bus.emit(entry.event)
  res.json({ success: true, retriedId: id })
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
systemModule.registerModule({
  name: 'recordings',
  status: 'healthy',
  subscribes: [],
  publishes: ['recording.created', 'recording.transcribed']
})
systemModule.registerModule({
  name: 'meetings',
  status: 'healthy',
  subscribes: ['recording.transcribed'],
  publishes: ['meeting.created', 'meeting.updated', 'meeting.summarized', 'meeting.deleted']
})
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
  const proto = useTls ? 'https' : 'http'
  console.log(`Server running at ${proto}://${host}:${port}`)
})
