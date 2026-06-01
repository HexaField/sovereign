// Sovereign server bootstrap — instantiates every module, mounts routes, and
// returns the handles the entry point needs for shutdown.
//
// The entry point owns transport (HTTP/WS), config loading, and the listen
// call — everything else lives here so `index.ts` stays at a glance.

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
import { createConfigRouter } from '@sovereign/config'
import type { ConfigStore, SovereignConfig } from '@sovereign/config'
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
import { createPersonalityCompiler } from '@sovereign/agent-backend'
import { resumeActiveSessions } from '@sovereign/agent-backend'
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
  configStore: ConfigStore
}

export interface BootstrapResult {
  shutdown: () => void
}

const authMiddleware = (_req: any, _res: any, next: any) => next()

export function bootstrapServer(input: BootstrapInput): BootstrapResult {
  const { app, server, wss, bus, dataDir, configStore } = input
  const wsHandler = createWsHandler(bus)
  const cfg: SovereignConfig = configStore.get()

  // Scheduler + notifications
  const scheduler = createScheduler(bus, dataDir)
  scheduler.init()
  registerSchedulerChannel(wsHandler, bus)
  registerNotificationsChannel(wsHandler, bus)

  // Orgs + bootstrap global workspace + per-project services
  const orgManager = createOrgManager(bus, dataDir)
  const globalPath = cfg.workspace.globalPath || path.join(dataDir, 'orgs', '_global')
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
  app.use(
    '/api/files',
    createFileRouter(fileService, undefined, fileProjectResolver, { workspaceRoot: cfg.workspace.root })
  )
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

  // Config router
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

  // Personality compiler — assembles `~/.claude/CLAUDE.md` as an exact
  // concatenation of the source files listed in `config.personality`. Owns
  // the whole file. Recompiles on (a) source `.md` file changes (via fs.watch)
  // and (b) `config.personality` changes (via configStore.onChange).
  const personalityDir = cfg.personality.sourceDir || cfg.workspace.root
  const personalityCompiler = personalityDir
    ? createPersonalityCompiler({
        sourceDir: personalityDir,
        manifest: { files: cfg.personality.files, separator: cfg.personality.separator }
      })
    : null
  if (personalityCompiler) {
    try {
      personalityCompiler.compile()
    } catch (err: unknown) {
      console.error('[personality] initial compile failed:', (err as Error)?.message ?? err)
    }
    personalityCompiler.start()
    configStore.onChange('personality', () => {
      const next = configStore.get<SovereignConfig['personality']>('personality')
      personalityCompiler.setManifest({ files: next.files, separator: next.separator })
    })
  }
  const threadManager = createThreadManager(bus, dataDir)
  for (const label of ['main', 'upgrades', 'v2-app']) {
    if (!threadManager.get(label)) threadManager.create({ label })
  }

  // Voice / Recordings / Meetings (config-driven URLs; hot-reloadable)
  const voiceModule = createVoiceModule(bus, {
    transcribeUrl: cfg.voice.transcribeUrl || undefined,
    ttsUrl: cfg.voice.ttsUrl || undefined
  })
  configStore.onChange('voice', () => {
    const next = configStore.get<SovereignConfig['voice']>('voice')
    voiceModule.updateConfig({ transcribeUrl: next.transcribeUrl || undefined, ttsUrl: next.ttsUrl || undefined })
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
    onSummarize: makeFetchSummarizer({ getUrl: () => configStore.get<string>('meetings.summarizeUrl') })
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

  // AD4M integration (optional — only if host configured)
  const ad4mService = cfg.ad4m.host
    ? createAd4mService(
        {
          host: cfg.ad4m.host,
          tokenFile: path.join(dataDir, 'ad4m-token.json'),
          agentName: cfg.identity.agentName
        },
        bus,
        notificationsModule
      )
    : undefined

  if (ad4mService) {
    ad4mService.mountRoutes(app)
  }

  // Boot-time resume summary, populated after the resume sweep finishes.
  // Exposed on /api/dashboard/resume-summary (R19) so the UI can render the
  // "Last restart resumed N sessions" tile.
  let lastResumeReport: {
    at: number
    counts: { tier1: number; tier2: number; tier3: number; invalidated: number }
    total: number
  } | null = null

  // Agent backend (the only construction cycle)
  const {
    routingBackend,
    backend,
    cronService,
    claudeCodeBackend,
    sessionsRegistry,
    activeSessions,
    createSovereignMcpInstance
  } = wireAgentBackend({
    bus,
    dataDir,
    configStore,
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
      res.status(400).json({
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
  const chatModule = createChatModule(bus, backend, threadManager, {
    dataDir,
    wsHandler,
    activeSessions: {
      setInFlight: (sessionKey, info) => activeSessions.setInFlight(sessionKey, info)
    }
  })
  registerChatWs(wsHandler, chatModule)
  app.use(createChatRoutes(chatModule, backend, dataDir))
  app.use(
    createThreadRoutes(threadManager, createForwardHandler(bus, threadManager), {
      chatModule,
      backend: routingBackend,
      cronService
    })
  )
  registerThreadsWs(wsHandler as any, threadManager, bus)

  // System module + routes
  const systemModule = createSystemModule(bus, dataDir, {
    wsHandler,
    getAgentBackendStatus: () => backend.status(),
    getModelConfig: () => ({
      models: configStore.get<string[]>('models.available'),
      defaultModel: configStore.get<string>('models.default') || null
    })
  })
  app.use(
    createSystemRoutes({
      system: systemModule,
      logsChannel,
      dataDir,
      healthHistory,
      routingBackend,
      activeSessions,
      eventStream,
      bus,
      getIdentity: () => ({
        agentName: configStore.get<string>('identity.agentName'),
        agentIcon: configStore.get<string>('identity.agentIcon')
      })
    })
  )
  registerEventsChannel(wsHandler, eventStream)
  wireBusLogging(bus, logsChannel)
  registerDefaultModules(systemModule)

  app.use(
    createDashboardRoutes({ orgManager, threadManager, notifications: notificationsModule, system: systemModule })
  )
  app.get('/api/dashboard/resume-summary', (_req, res) => {
    res.json(lastResumeReport ?? { at: null, counts: { tier1: 0, tier2: 0, tier3: 0, invalidated: 0 }, total: 0 })
  })

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

  // Connect backends, then run the boot-time resume sweep (R10).
  // resumeActiveSessions is a no-op when no entries exist, so a clean boot
  // pays no cost. Runs *before* WS connections are accepted so any UI
  // reconnecting sees the resumed state. The report is exposed via
  // /api/dashboard/resume-summary (R19).
  void routingBackend
    .connectAll()
    .then(() =>
      resumeActiveSessions({
        activeSessions,
        routingBackend,
        bus,
        getAllQueues: () => chatModule.messageQueue.getAllQueues(),
        replayQueueHead: (id) => chatModule.retryQueued(id),
        dropQueueHead: (id) => chatModule.cancelQueued(id),
        sendContinuation: async (threadKey, text) => {
          await chatModule.handleSend(threadKey, text)
        }
      })
        .then((report) => {
          lastResumeReport = { at: Date.now(), counts: report.counts, total: report.outcomes.length }
        })
        .catch((err: any) => console.error('[resume] orchestrator failed:', err?.message ?? err))
    )
    .catch((err: any) => console.error('Failed to connect agent backend(s):', err.message))
  const cronMonitor = createCronMonitor({ cronService, wsHandler, pollIntervalMs: 30_000 })
  setTimeout(() => cronMonitor.start(), 5000)

  return {
    shutdown() {
      ad4mService?.close()
      fileWatcher.stop()
      scheduler.destroy()
      terminalManager.dispose()
      cronMonitor.stop()
      routingBackend.disconnectAll().catch(() => {})
      // Flush every file-backed cache synchronously so SIGTERM leaves disk
      // in its latest known-good state (R5). Order matters only in that
      // active-sessions sees the final transitions from the backend.
      sessionsRegistry.flush()
      activeSessions.flush()
      claudeCodeBackend?.flushState()
      chatModule.flushState()
      personalityCompiler?.stop()
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
