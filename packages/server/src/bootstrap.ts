// Sovereign server bootstrap — instantiates every module, mounts routes, and
// returns the handles the entry point needs for shutdown.
//
// The entry point owns transport (HTTP/WS), config (env vars), and the
// listen call — everything else lives here so `index.ts` stays at a glance.

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type express from 'express'
import type http from 'node:http'
import type https from 'node:https'
import type { WebSocketServer } from 'ws'
import type { EventBus } from '@sovereign/core'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import { createScheduler } from '@sovereign/scheduler'
import { registerSchedulerChannel } from '@sovereign/scheduler'
import { createSchedulerRoutes } from '@sovereign/scheduler'
import { createCronMonitor } from '@sovereign/scheduler'
import { registerNotificationsChannel } from '@sovereign/notifications'
import { createOrgManager } from '@sovereign/orgs'
import { createOrgRoutes } from '@sovereign/orgs'
import { registerOrgsChannel } from '@sovereign/orgs'
import { getRemotes as getProjectRemotes } from '@sovereign/orgs'
import { createFileService } from '@sovereign/files'
import { createFileRouter } from '@sovereign/files'
import { registerFilesChannel } from '@sovereign/files'
import { createFileWatcher } from '@sovereign/files'
import { createGitCli } from '@sovereign/git'
import { createGitService } from '@sovereign/git'
import { createGitRoutes } from '@sovereign/git'
import { registerGitChannel } from '@sovereign/git'
import { createTerminalManager } from '@sovereign/terminal'
import { createTerminalRoutes } from '@sovereign/terminal'
import { registerTerminalChannel } from '@sovereign/terminal'
import { createWorktreeManager } from '@sovereign/worktrees'
import { createWorktreeRouter } from '@sovereign/worktrees'
import { registerWorktreesChannel } from '@sovereign/worktrees'
import { createConfigStore } from '@sovereign/config'
import { createConfigRouter } from '@sovereign/config'
import { createChangeSetManager } from '@sovereign/diff'
import { createDiffRouter } from '@sovereign/diff'
import { createIssueTracker } from '@sovereign/issues'
import { createIssueRouter } from '@sovereign/issues'
import { createReviewSystem } from '@sovereign/review'
import { createReviewRouter } from '@sovereign/review'
import { createRadicleManager } from '@sovereign/radicle'
import { createRadicleRouter } from '@sovereign/radicle'
import { createPlanningService } from '@sovereign/planning'
import { createPlanningRouter } from '@sovereign/planning'
import { registerPlanningWs } from '@sovereign/planning'
import { createDraftStore } from '@sovereign/drafts'
import { createDraftRouter } from '@sovereign/drafts'
import { wireAgentBackend } from '@sovereign/agent-backend'
import { getGatewayActivityMap } from '@sovereign/agent-backend'
import { createWorkspaceIndex } from '@sovereign/agent-backend'
import { createThreadManager } from '@sovereign/threads'
import { createChatModule } from '@sovereign/chat'
import { createChatRoutes } from '@sovereign/chat'
import { registerChatWs } from '@sovereign/chat'
import { createThreadRoutes } from '@sovereign/threads'
import { registerThreadsWs } from '@sovereign/threads'
import { createForwardHandler } from '@sovereign/threads'
import { createVoiceModule } from '@sovereign/voice'
import { createVoiceRoutes } from '@sovereign/voice'
import { createRecordingsService } from '@sovereign/recordings'
import { registerRecordingRoutes } from '@sovereign/recordings'
import { registerRecordingsChannel } from '@sovereign/recordings'
import { createTranscriptionQueue } from '@sovereign/recordings'
import { createTranscriptSearch } from '@sovereign/recordings'
import { createRuleBasedPostProcessor } from '@sovereign/voice'
import { createAcknowledgmentGenerator } from '@sovereign/voice'
import { createVoiceTranscriptionProvider } from '@sovereign/voice'
import { createSystemModule } from '@sovereign/system'
import { createSystemRoutes, registerEventsChannel } from '@sovereign/system'
import { createHealthHistory } from '@sovereign/system'
import { registerLogsChannel } from '@sovereign/system'
import { createEventStream } from '@sovereign/system'
import { wireBusLogging } from '@sovereign/system'
import { registerDefaultModules } from '@sovereign/system'
import { createNotifications } from '@sovereign/notifications'
import { createNotificationRoutes } from '@sovereign/notifications'
import { createBrowserService } from '@sovereign/browser'
import { createAd4mService } from '@sovereign/ad4m'
import { createDashboardRoutes } from './dashboard/routes.js'
import { createMeetingsService } from '@sovereign/meetings'
import { createSpeakerService } from '@sovereign/meetings'
import { createSummarizationPipeline } from '@sovereign/meetings'
import { makeFetchSummarizer } from '@sovereign/meetings'
import { createImportHandler } from '@sovereign/meetings'
import { registerMeetingRoutes } from '@sovereign/meetings'
import { registerMeetingsChannel } from '@sovereign/meetings'
import { createRetentionJob } from '@sovereign/meetings'
import { wireStatusAggregator } from './status/wiring.js'
import { createWsHandler } from '@sovereign/primitives'

export interface BootstrapInput {
  app: express.Express
  server: http.Server | https.Server
  wss: WebSocketServer
  bus: EventBus
  dataDir: string
}

export interface BootstrapResult {
  shutdown: () => void
}

const authMiddleware = (_req: any, _res: any, next: any) => next()

export function bootstrapServer(input: BootstrapInput): BootstrapResult {
  const { app, server, wss, bus, dataDir } = input
  const wsHandler = createWsHandler(bus)

  // Scheduler + notifications
  const scheduler = createScheduler(bus, dataDir)
  scheduler.init()
  registerSchedulerChannel(wsHandler, bus)
  registerNotificationsChannel(wsHandler, bus)

  // Orgs + bootstrap global workspace + per-project services
  const orgManager = createOrgManager(bus, dataDir)
  const globalPath = process.env.SOVEREIGN_GLOBAL_PATH || path.join(dataDir, 'orgs', '_global')
  if (!orgManager.getOrg('_global')) {
    fs.mkdirSync(globalPath, { recursive: true })
    orgManager.createOrg({ id: '_global', name: 'Global', path: globalPath, provider: 'radicle' })
  }
  try {
    orgManager.autoDetectProjects('_global')
  } catch {
    /* non-fatal */
  }
  app.use('/api', createOrgRoutes(orgManager, authMiddleware))
  registerOrgsChannel(wsHandler, bus)

  const fileService = createFileService(bus)
  const fileProjectResolver = (projectId: string): string => {
    for (const org of orgManager.listOrgs()) {
      const p = orgManager.listProjects(org.id).find((pr) => pr.id === projectId)
      if (p) return p.repoPath
    }
    return projectId
  }
  app.use('/api/files', createFileRouter(fileService, undefined, fileProjectResolver))
  registerFilesChannel(wsHandler, bus)
  const fileWatcher = createFileWatcher(bus, globalPath)
  fileWatcher.start()

  const resolveProject = (orgId: string, projectId: string, _w?: string) => {
    const p = orgManager.getProject(orgId, projectId)
    return p
      ? { repoPath: p.repoPath, defaultBranch: p.defaultBranch ?? 'main' }
      : { repoPath: path.join(dataDir, 'projects', orgId, projectId), defaultBranch: 'main' }
  }
  const gitService = createGitService(bus, createGitCli(), resolveProject)
  app.use('/api/git', createGitRoutes(gitService, authMiddleware))
  registerGitChannel(wsHandler, bus)

  const terminalManager = createTerminalManager(bus, { validateCwd: () => true, gracePeriodMs: 10_000 })
  app.use('/api/terminal', createTerminalRoutes(terminalManager))
  registerTerminalChannel(wsHandler, bus, terminalManager)

  const worktreeManager = createWorktreeManager(bus, dataDir, {
    getProject: (orgId, projectId) => {
      const p = orgManager.getProject(orgId, projectId)
      return p ? { repoPath: p.repoPath, defaultBranch: p.defaultBranch ?? 'main' } : undefined
    }
  })
  app.use(createWorktreeRouter(worktreeManager, authMiddleware))
  registerWorktreesChannel(wsHandler, bus)

  // Config + diff/issues/review/radicle
  const configStore = createConfigStore(bus, dataDir)
  app.use('/api/config', createConfigRouter(configStore))
  const changeSetManager = createChangeSetManager(bus, dataDir)
  app.use(createDiffRouter(changeSetManager))
  const getRemotes = (orgId: string, projectId: string) => getProjectRemotes(orgManager, orgId, projectId)
  const issueTracker = createIssueTracker(bus, dataDir, getRemotes)
  app.use(createIssueRouter(issueTracker))
  const reviewSystem = createReviewSystem(bus, dataDir, {
    removeWorktree: (worktreeId) => worktreeManager.remove('_global', '_default', worktreeId),
    getChangeSet: (id) => changeSetManager.getChangeSet(id),
    updateChangeSet: (id, patch) => changeSetManager.updateChangeSet(id, patch),
    getProvider: () => {
      throw new Error('No review provider configured')
    }
  })
  app.use(createReviewRouter(reviewSystem))
  const radicleManager = createRadicleManager(bus, dataDir)
  app.use('/api/radicle', createRadicleRouter(radicleManager))

  // Planning + drafts
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

  // Threads + workspace index
  const workspaceIndex = createWorkspaceIndex({ filePath: path.join(process.env.HOME ?? '', '.claude', 'CLAUDE.md') })
  const refreshWorkspaceIndex = () =>
    workspaceIndex.setEntries(
      orgManager.listOrgs().map((o: any) => ({ path: o.path, description: o.name, orgId: o.id }))
    )
  const threadManager = createThreadManager(bus, dataDir)
  for (const label of ['main', 'upgrades', 'v2-app']) {
    if (!threadManager.get(label)) threadManager.create({ label })
  }

  // Voice / Recordings / Meetings
  const voiceModule = createVoiceModule(bus, {
    transcribeUrl: process.env.VOICE_TRANSCRIBE_URL,
    ttsUrl: process.env.VOICE_TTS_URL
  })
  app.use(createVoiceRoutes(voiceModule))
  const recordingsService = createRecordingsService(dataDir)
  app.use(registerRecordingRoutes(recordingsService))
  const meetingsService = createMeetingsService(bus, dataDir)
  const speakerService = createSpeakerService(dataDir)
  void createRuleBasedPostProcessor()
  void createAcknowledgmentGenerator()
  const transcriptionQueue = createTranscriptionQueue(createVoiceTranscriptionProvider(voiceModule))
  void createTranscriptSearch(recordingsService)
  const summarizationPipeline = createSummarizationPipeline({
    bus,
    meetings: meetingsService,
    dataDir,
    onSummarize: makeFetchSummarizer()
  })
  const importHandler = createImportHandler({ bus, meetings: meetingsService })
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

  // System / events / notifications / browser
  const logsChannel = registerLogsChannel(wsHandler, bus, dataDir)
  const healthHistory = createHealthHistory()
  const eventStream = createEventStream(bus)
  const notificationsModule = createNotifications(bus, dataDir)
  app.use(createNotificationRoutes(notificationsModule))
  const browserService = createBrowserService(dataDir)

  // AD4M integration (optional — only if AD4M_HOST is set)
  const ad4mService = process.env.AD4M_HOST
    ? createAd4mService(
        {
          host: process.env.AD4M_HOST,
          tokenFile: path.join(dataDir, 'ad4m-token.json'),
          agentName: process.env.SOVEREIGN_AGENT_NAME
        },
        bus,
        notificationsModule
      )
    : undefined

  if (ad4mService) {
    ad4mService.mountRoutes(app)
  }

  // Agent backend (the only construction cycle)
  const { routingBackend, backend, cronService, openClawBackend, sessionsRegistry, createSovereignMcpInstance } =
    wireAgentBackend({
      bus,
      dataDir,
      scheduler,
      orgManager,
      planningService,
      issueTracker,
      meetingsService,
      notificationsModule,
      browserService
    })
  app.use(createSchedulerRoutes(scheduler, cronService))

  // Sovereign MCP over Streamable HTTP — per-session transport pattern.
  // Each initialize request creates a fresh McpServer + transport pair (session-scoped).
  // Register with Claude Code once: claude mcp add --transport http sovereign http://127.0.0.1:5801/api/mcp
  {
    const sessions = new Map<string, StreamableHTTPServerTransport>()
    const isInit = (body: any) => typeof body === 'object' && body !== null && body.method === 'initialize'

    async function handleMcp(req: any, res: any) {
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      if (sessionId && sessions.has(sessionId)) {
        return sessions.get(sessionId)!.handleRequest(req, res, req.body)
      }
      if (!sessionId && isInit(req.body)) {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
        const server = createSovereignMcpInstance()
        await server.connect(transport)
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId)
        }
        await transport.handleRequest(req, res, req.body)
        if (transport.sessionId) sessions.set(transport.sessionId, transport)
        return
      }
      res
        .status(400)
        .json({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Bad MCP request — missing session or not initialize' },
          id: null
        })
    }

    app.post('/api/mcp', handleMcp)
    app.get('/api/mcp', handleMcp)
    app.delete('/api/mcp', (req: any, res: any) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      if (sessionId) {
        sessions.get(sessionId)?.close()
        sessions.delete(sessionId)
      }
      res.status(200).end()
    })
    console.log('[sovereign] MCP HTTP endpoint ready at /api/mcp')
  }

  // AD4M → thread injection (after routingBackend and threadManager are available)
  if (ad4mService) {
    bus.on('ad4m.thread.message', async (event) => {
      const { threadKey, threadLabel, text } = event.payload as {
        threadKey: string
        threadLabel: string
        text: string
      }
      threadManager.create({ label: threadLabel, orgId: '_global' })
      const sessionKey = `agent:main:thread:${threadKey}`
      try {
        await routingBackend.forSession(sessionKey).sendMessage(sessionKey, text)
      } catch (err: unknown) {
        console.error('[ad4m] thread message injection failed:', threadKey, (err as Error)?.message)
      }
    })
  }

  // Chat + threads (after routing/cron exist)
  const chatModule = createChatModule(bus, backend, threadManager, { dataDir, wsHandler })
  registerChatWs(wsHandler, chatModule)
  app.use(createChatRoutes(chatModule, backend, dataDir))
  app.use(
    createThreadRoutes(threadManager, createForwardHandler(bus, threadManager), {
      chatModule,
      backend: routingBackend,
      activityProvider: openClawBackend
        ? { getGatewayActivityMap: () => getGatewayActivityMap(openClawBackend.paths.sessionsJsonPath) }
        : undefined,
      cronService
    })
  )
  registerThreadsWs(wsHandler as any, threadManager, bus)

  // System module + routes
  const systemModule = createSystemModule(bus, dataDir, {
    wsHandler,
    getAgentBackendStatus: () => backend.status()
  })
  app.use(
    createSystemRoutes({ system: systemModule, logsChannel, dataDir, healthHistory, routingBackend, eventStream, bus })
  )
  registerEventsChannel(wsHandler, eventStream)
  wireBusLogging(bus, logsChannel)
  registerDefaultModules(systemModule)

  refreshWorkspaceIndex()
  bus.on('org.created', () => refreshWorkspaceIndex())
  bus.on('org.updated', () => refreshWorkspaceIndex())
  bus.on('org.deleted', () => refreshWorkspaceIndex())
  app.use(
    createDashboardRoutes({ orgManager, threadManager, notifications: notificationsModule, system: systemModule })
  )

  // Status aggregator + WS connection handler
  const statusAggregator = wireStatusAggregator({
    bus,
    wss,
    wsHandler,
    chatModule,
    voiceModule,
    radicleManager,
    configStore,
    planningService,
    systemModule
  })

  routingBackend.connectAll().catch((err: any) => console.error('Failed to connect agent backend(s):', err.message))
  const cronMonitor = createCronMonitor({ cronService, wsHandler, pollIntervalMs: 30_000, autoFixIntervalMs: 15_000 })
  setTimeout(() => cronMonitor.start(), 5000)

  return {
    shutdown() {
      ad4mService?.close()
      fileWatcher.stop()
      scheduler.destroy()
      terminalManager.dispose()
      cronMonitor.stop()
      routingBackend.disconnectAll().catch(() => {})
      sessionsRegistry.flush()
      workspaceIndex.flush()
      workspaceIndex.dispose()
      browserService.dispose().catch(() => {})
      statusAggregator.destroy()
      systemModule.dispose()
      eventStream.dispose()
      notificationsModule.dispose()
      wss.close()
      server.close()
    }
  }
}
