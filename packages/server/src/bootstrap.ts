// Sovereign server bootstrap — instantiates every module, mounts routes, and
// returns the handles the entry point needs for shutdown.
//
// The entry point owns transport (HTTP/WS), config loading, and the listen
// call — everything else lives here so `index.ts` stays at a glance.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type express from 'express'
import type http from 'node:http'
import type https from 'node:https'
import type { WebSocketServer } from 'ws'
import type { EventBus } from '@sovereign/core'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import { createSummaryService, createSummaryRoutes } from '@sovereign/summary'
import { createScheduler } from '@sovereign/scheduler'
import { registerSchedulerChannel } from '@sovereign/scheduler'
import { createSchedulerRoutes } from '@sovereign/scheduler'
import { createCronMonitor } from '@sovereign/scheduler'
import { registerNotificationsChannel } from '@sovereign/notifications'
import { createOrgManager } from '@sovereign/orgs'
import { createOrgRoutes } from '@sovereign/orgs'
import { registerOrgsChannel } from '@sovereign/orgs'
import { getRemotes as getProjectRemotes } from '@sovereign/orgs'
import { createMembraneManager } from '@sovereign/membranes'
import { createMembraneRoutes } from '@sovereign/membranes'
import { createFileService } from '@sovereign/files'
import { createFileRouter } from '@sovereign/files'
import { registerFilesChannel } from '@sovereign/files'
import { createMultiRootFileWatcher } from '@sovereign/files'
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
import { createInferenceClient, localLlmConfigFromStore } from '@sovereign/agent-backend'
import { createThreadManager } from '@sovereign/threads'
import { createChatModule } from '@sovereign/chat'
import { createChatRoutes } from '@sovereign/chat'
import { registerChatWs } from '@sovereign/chat'
import { createThreadRoutes } from '@sovereign/threads'
import { registerThreadsWs } from '@sovereign/threads'
import { createForwardHandler } from '@sovereign/threads'
import { createVoiceModule, createVoiceResponse, DEFAULT_SUMMARY_SYSTEM } from '@sovereign/voice'
import { createVoiceRoutes } from '@sovereign/voice'
import { registerVoiceStreamChannel } from '@sovereign/voice'
import { createConversationSummary, createConversationSummaryRoutes } from '@sovereign/voice'
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
import { createDeviceMonitor } from '@sovereign/system'
import { registerLogsChannel } from '@sovereign/system'
import { createEventStream } from '@sovereign/system'
import { wireBusLogging } from '@sovereign/system'
import { registerDefaultModules } from '@sovereign/system'
import { createNotifications } from '@sovereign/notifications'
import { createNotificationRoutes } from '@sovereign/notifications'
import {
  createPresenceTracker,
  createMuteStore,
  createThreadPresenceRoutes,
  registerPresenceWs,
  wirePresenceOrchestrator
} from '@sovereign/thread-presence'
import { createBrowserService } from '@sovereign/browser'
import { createAd4mService } from '@sovereign/ad4m'
import {
  createPresenceModule,
  createAd4mPoster,
  bootstrapKnowledgeGraph,
  createSimpleConversation
} from '@sovereign/presence'
import { createForestRoutes } from './forest/routes.js'
import { createDashboardRoutes } from './dashboard/routes.js'
import { createMeetingsService } from '@sovereign/meetings'
import { createSpeakerService } from '@sovereign/meetings'
import { createSummarizationPipeline } from '@sovereign/meetings'
import { makeFetchSummarizer } from '@sovereign/meetings'
import { createImportHandler } from '@sovereign/meetings'
import { registerMeetingRoutes } from '@sovereign/meetings'
import { registerMeetingsChannel } from '@sovereign/meetings'
import { wireStatusAggregator } from './status/wiring.js'
import { createWsHandler } from '@sovereign/primitives'

export interface BootstrapInput {
  app: express.Express
  server: http.Server | https.Server
  wss: WebSocketServer
  bus: EventBus
  configDir: string
  dataDir: string
  configStore: ConfigStore
}

export interface BootstrapResult {
  shutdown: () => void
}

const authMiddleware = (_req: any, _res: any, next: any) => next()

// ── Layer 3 orphan-sweep helpers ─────────────────────────────────────────
// Pure helpers for the context-cleanup cron below. Kept outside
// `bootstrapServer` because they take no closure state — easier to reason
// about and to unit test in isolation.

/**
 * Reconstruct the shared `.claude/projects` root from a known session file
 * path. Session files nest at varying depth — top-level sessions sit one
 * level under the root, subagents nest three levels deep — so we anchor on
 * the literal `projects` path segment that every backend inserts (see
 * `sessionJsonlPath` in `@sovereign/agent-backend`) rather than assume a
 * fixed number of parent hops. Returns null when no candidate path contains
 * that segment (e.g. no tracked sessions yet).
 */
function deriveProjectsDir(knownSessionFilePaths: string[]): string | null {
  for (const filePath of knownSessionFilePaths) {
    const segments = filePath.split(path.sep)
    const idx = segments.lastIndexOf('projects')
    if (idx !== -1) return segments.slice(0, idx + 1).join(path.sep)
  }
  return null
}

/**
 * Recursively lists every `.jsonl` file under `dir`. Best-effort — a missing
 * or unreadable directory yields an empty list rather than throwing, so one
 * bad path never aborts the wider cleanup sweep.
 */
function listJsonlFilesRecursive(dir: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(path.join(entry.parentPath, entry.name))
    }
  }
  return out
}

export function bootstrapServer(input: BootstrapInput): BootstrapResult {
  const { app, server, wss, bus, configDir, dataDir, configStore } = input
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

  // Membranes — social/privacy layer over orgs. Backed by
  // `<dataDir>/membranes.json` (created lazily on first write). Decouples
  // "who can see this" (membrane) from "which git provider hosts this"
  // (org). See `@sovereign/membranes` for the schema.
  const membraneManager = createMembraneManager(bus, dataDir)
  app.use('/api', createMembraneRoutes(membraneManager, authMiddleware))

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
    createFileRouter(fileService, undefined, fileProjectResolver, {
      workspaceRoot: cfg.workspace.root,
      getRoots: () => orgManager.listOrgs().map((o) => ({ id: o.id, name: o.name, path: o.path }))
    })
  )
  registerFilesChannel(wsHandler, bus)

  // Watch ALL org roots for file changes, not just the global workspace.
  // Each org path gets its own fs.watch instance via the multi-root watcher.
  const watchRoots = [
    ...new Set(
      orgManager
        .listOrgs()
        .map((o) => o.path)
        .filter((p) => fs.existsSync(p))
    )
  ]
  const fileWatcher = createMultiRootFileWatcher(bus, watchRoots)
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
  // Derive outputPath from config, not from HOME — non-production contexts
  // must never write to the production ~/.claude/CLAUDE.md.
  const agentDir = cfg.agentBackend.claudeCode.agentDir || path.join(os.homedir(), '.claude')
  const personalityCompiler = personalityDir
    ? createPersonalityCompiler({
        sourceDir: personalityDir,
        outputPath: path.join(agentDir, 'CLAUDE.md'),
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
  // First-boot seed (config-driven via `cfg.seed`). The runtime makes NO
  // standing assumptions about which threads or membranes exist — this just
  // gives a fresh install one usable thread + its membrane. Both pieces are
  // opt-out (empty config value) and idempotent:
  //   • the default membrane is created only if its id is set AND absent;
  //   • the default thread is created only when the registry is EMPTY, so we
  //     never re-mint it once the user has threads of their own (and never
  //     duplicate across boots).
  if (cfg.seed.membraneId && !membraneManager.getMembrane(cfg.seed.membraneId)) {
    membraneManager.createMembrane({
      id: cfg.seed.membraneId,
      name: cfg.seed.membraneName || cfg.seed.membraneId
    })
  }
  if (cfg.seed.threadLabel && threadManager.list().length === 0) {
    threadManager.create({ label: cfg.seed.threadLabel, membraneId: cfg.seed.membraneId || undefined })
  }

  // Voice / Recordings / Meetings (config-driven URLs; hot-reloadable)
  const voiceModule = createVoiceModule(bus, {
    transcribeUrl: cfg.voice.transcribeUrl || undefined,
    ttsUrl: cfg.voice.ttsUrl || undefined,
    // Qwen3-TTS on ROCm iGPU needs up to 90s for cold kernel compilation
    // on unseen tensor shapes. The default 30s kills most first-run synths.
    timeoutMs: 120_000
  })
  configStore.onChange('voice', () => {
    const next = configStore.get<SovereignConfig['voice']>('voice')
    voiceModule.updateConfig({ transcribeUrl: next.transcribeUrl || undefined, ttsUrl: next.ttsUrl || undefined })
  })
  // Late-binding: presenceModule + chatModule create after voice routes,
  // so capture a mutable ref that gets filled once both initialise.
  let voiceForward: ((text: string, opts?: { deviceId?: string }) => Promise<{ delivered: boolean }>) | undefined
  app.use(
    createVoiceRoutes(voiceModule, {
      forwardToPresence: (text, opts) => {
        if (!voiceForward) return Promise.resolve({ delivered: false })
        return voiceForward(text, opts)
      }
    })
  )

  // ── Streaming STT (real-time transcription via WS) ──────────────────
  if (cfg.voice.transcribeUrl) {
    registerVoiceStreamChannel({
      ws: wsHandler,
      transcribeUrl: cfg.voice.transcribeUrl
    })
  }

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
  app.use(createNotificationRoutes(notificationsModule, notificationsModule.pushManager))
  // Browser service degrades gracefully — a missing Chromium warns but never
  // crashes startup. The service itself handles a null executable path, but
  // wrap construction as a safety net against any unforeseen init failure.
  let browserService: ReturnType<typeof createBrowserService>
  try {
    browserService = createBrowserService(dataDir)
  } catch (err) {
    console.error('[browser] service creation failed — browser tools unavailable:', (err as Error)?.message ?? err)
    // Provide a stub that rejects every call with a clear message.
    browserService = {
      async open() {
        throw new Error('browser: service unavailable (init failed)')
      },
      async act() {
        throw new Error('browser: service unavailable (init failed)')
      },
      async close() {},
      list() {
        return []
      },
      async dispose() {}
    }
  }

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

  // Knowledge graph bootstrap — register the AD4M perspective + SHACL
  // models at startup, replacing the manual LLM-driven bootstrap that
  // PRESENCE.md previously instructed. Perspective name derives from
  // identity.agentName; schemas come from the membrane-local file.
  let teardownKnowledgeGraph: (() => void) | undefined
  if (ad4mService) {
    const schemasFile = path.join(configDir, 'membranes', 'personal', 'knowledge-graph-schemas.json')
    if (fs.existsSync(schemasFile)) {
      teardownKnowledgeGraph = bootstrapKnowledgeGraph({
        ad4m: ad4mService.client(),
        agentName: cfg.identity.agentName,
        schemasFile,
        dataDir: path.join(dataDir, 'presence'),
        memoryFile: path.join(configDir, 'PRESENCE_MEMORY.md')
      })
    }
  }

  // Forest — knowledge graph 3D visualisation index
  {
    const ad4mClient = ad4mService?.client() ?? null
    app.use(
      createForestRoutes({
        dataDir,
        ad4m: ad4mClient
          ? {
              listPerspectives: async () => {
                const c = ad4mClient.getClient()
                if (!c) return []
                const perspectives = await c.perspective.all()
                return perspectives.map((p: any) => ({ uuid: p.uuid, name: p.name }))
              },
              queryLinks: async (
                perspectiveUuid: string,
                opts?: { source?: string; predicate?: string; target?: string }
              ) => {
                const c = ad4mClient.getClient()
                if (!c) return []
                // queryLinks returns LinkExpression[] — data lives in .data
                const raw = await (c.perspective as any).queryLinks(perspectiveUuid, opts ?? {})
                if (!Array.isArray(raw)) return []
                return raw.map((le: any) => ({
                  source: le.data?.source ?? le.source ?? '',
                  predicate: le.data?.predicate ?? le.predicate ?? '',
                  target: le.data?.target ?? le.target ?? '',
                  timestamp: le.timestamp ?? '',
                  author: le.author ?? ''
                }))
              }
            }
          : null
      })
    )
  }

  // Boot-time resume summary, populated after the resume sweep finishes.
  // Exposed on /api/dashboard/resume-summary (R19) so the UI can render the
  // "Last restart resumed N sessions" tile.
  let lastResumeReport: {
    at: number
    counts: { tier1: number; tier2: number; tier3: number; invalidated: number }
    total: number
  } | null = null

  // Presence module — owns the two presence threads (internal +
  // gateway), the response tools, watch list, and digest service. Wired
  // before the agent backend so its tools can be registered into the MCP
  // server. The chat handles are swapped in after createChatModule below
  // (deferred, holder pattern). See plans/presence-thread-spec.md.
  const presenceDataDir = path.join(dataDir, 'presence')
  const chatHandleHolder: {
    postAssistantTurn(threadId: string, content: string): void
    sendToThread(threadId: string, text: string, origin: import('@sovereign/core').MessageOrigin): Promise<void>
  } = {
    postAssistantTurn(threadId) {
      console.warn(`[presence] chat sender not yet wired — dropping turn for ${threadId}`)
    },
    async sendToThread(threadId) {
      console.warn(`[presence] chat sender not yet wired — dropping inbound for ${threadId}`)
    }
  }
  const presenceModule = createPresenceModule({
    bus,
    threadManager,
    dataDir: presenceDataDir,
    voice: voiceModule,
    ws: {
      sendBinaryTo: (deviceId: string, channel: string, payload: Buffer) =>
        (wsHandler as any).sendBinaryTo?.(deviceId, channel, payload) ?? false,
      sendTo: (deviceId: string, payload: Record<string, unknown>) =>
        (wsHandler as any).sendTo?.(deviceId, payload) ?? false
    },
    ad4m: ad4mService ? createAd4mPoster(ad4mService.client()) : undefined,
    chat: {
      postAssistantTurn: (t: string, c: string) => chatHandleHolder.postAssistantTurn(t, c),
      sendToThread: (t, text, origin) => chatHandleHolder.sendToThread(t, text, origin)
    },
    autoCreate: true,
    internalLabel: 'presence-internal',
    gatewayLabel: 'presence',
    autoCreateMembraneId: cfg.seed?.membraneId || 'personal'
  })
  // Fill the late-binding ref so voice transcriptions reach the gateway thread.
  // Voice node transcriptions go to the gateway (same as dashboard voice) —
  // the user expects to see their spoken message as a user turn in the main chat.
  voiceForward = async (text, opts) => {
    const gatewayId = presenceModule.gatewayThreadId()
    if (!gatewayId) return { delivered: false }
    try {
      await chatHandleHolder.sendToThread(gatewayId, text, {
        modality: 'voice',
        ...(opts?.deviceId ? { deviceId: opts.deviceId } : {})
      })
      return { delivered: true }
    } catch (err) {
      console.warn('[voice] gateway forward failed:', (err as Error)?.message)
      return { delivered: false }
    }
  }

  const presenceMcpDeps = {
    internalThreadId: () => presenceModule.internalThreadId(),
    gatewayThreadId: () => presenceModule.gatewayThreadId(),
    watch: {
      add: (threadId: string, reason?: string) => presenceModule.watchStore.add(threadId, reason),
      remove: (threadId: string) => presenceModule.watchStore.remove(threadId),
      list: () => presenceModule.watchStore.list()
    },
    tools: presenceModule.tools,
    forwardToInternal: (text: string, opts?: { deviceId?: string }) => presenceModule.forwardToInternal(text, opts),
    internalHistory: async (limit?: number) => {
      const id = presenceModule.internalThreadId()
      if (!id) return { turns: [] }
      try {
        const { turns } = await routingBackend.forSession(id).getHistory(id)
        const sliced = turns.slice(-(limit ?? 20))
        return { turns: sliced.map((t: any) => ({ role: t.role, content: t.content })) }
      } catch {
        return { turns: [] }
      }
    },
    resolveThreadId: (idOrLabel: string) => threadManager.resolve(idOrLabel)?.id
  }
  // Presence files live alongside the personality sources in configDir
  // (not hardcoded to HOME — tests must never touch production paths).
  const presencePersonalityFile = path.join(configDir, 'PRESENCE.md')
  const presenceMemoryFile = path.join(configDir, 'PRESENCE_MEMORY.md')
  const presenceKnowledgeFile = path.join(configDir, 'PRESENCE_KNOWLEDGE.md')

  // Late-bound health summary — the system module does not exist yet at
  // wiring time. The getter runs only when a session starts (well after
  // boot completes), so the ref will have resolved by then.
  let systemModuleRef: import('@sovereign/system').SystemModule | undefined
  const presenceGetHealthSummary = (): string | undefined => {
    if (!systemModuleRef) return undefined
    const h = systemModuleRef.getHealth()
    const lines: string[] = ['# Service health at session start', '']
    lines.push(`Uptime: ${h.connection.uptime}s`)
    lines.push(`Agent backend: ${h.connection.agentBackend}`)
    if (h.services?.external?.length) {
      lines.push('', '## External services', '')
      for (const svc of h.services.external) {
        const icon = svc.status === 'ok' ? '✓' : '✗'
        lines.push(`- ${icon} **${svc.label}** (port ${svc.port}): ${svc.status}`)
      }
    }
    if (h.services?.semble) {
      const s = h.services.semble
      lines.push(`- Semble: ${s.status}${s.version ? ` v${s.version}` : ''}`)
    }
    return lines.join('\n')
  }

  // Agent backend (the only construction cycle)
  const {
    routingBackend,
    backend,
    cronService,
    claudeCodeBackend,
    sessionsRegistry,
    activeSessions,
    createSovereignMcpInstance,
    askUserQuestionStore,
    metrics
  } = wireAgentBackend({
    bus,
    dataDir,
    configDir,
    configStore,
    scheduler,
    orgManager,
    membraneManager,
    threadManager,
    planningService,
    issueTracker,
    meetingsService,
    notificationsModule,
    browserService,
    presence: presenceMcpDeps,
    presencePersonalityFile,
    presenceMemoryFile,
    presenceKnowledgeFile,
    presenceGetHealthSummary
  })
  app.use(createSchedulerRoutes(scheduler, cronService))

  // Sovereign MCP over Streamable HTTP — session-scoped transport.
  // Each initialize request creates a fresh McpServer + transport pair.
  // Internal agent sessions use in-process injection (no HTTP round-trip).
  // This endpoint serves external MCP clients:
  //   claude mcp add --transport http sovereign http://127.0.0.1:5801/api/mcp
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

  // Chat + threads (after routing/cron exist)
  const chatModule = createChatModule(bus, backend, threadManager, {
    dataDir,
    wsHandler,
    activeSessions: {
      setInFlight: (sessionKey, info) => activeSessions.setInFlight(sessionKey, info)
    },
    presence: {
      takeDigest: () => presenceModule.digest.take()
    }
  })

  // Wire the deferred chat handles now that chatModule exists.
  //   • postAssistantTurn — used by `presence_reply_text`. Delegates to
  //     chatModule.injectExternalTurn which broadcasts, emits the bus
  //     event (triggering push notifications + digest), touches the
  //     thread's lastActivity, and synthesizes idle status. The turn is
  //     NOT written into the SDK's JSONL (session owns that file).
  //   • sendToThread — used by gateway → internal forwarding
  //     (`presence_internal_send`) and any other surface that wants to
  //     drop a user-typed message into Hex's internal stream with an
  //     explicit origin.
  // See R5 + R7.
  chatHandleHolder.postAssistantTurn = (threadId, content) => {
    chatModule.injectExternalTurn(threadId, content)
  }
  chatHandleHolder.sendToThread = async (threadId, text, origin) => {
    await chatModule.handleSend(threadId, text, undefined, { origin })
  }

  // AD4M → presence-internal thread injection. Mentions land on the
  // long-lived internal thread with origin metadata so the agent can choose
  // to reply via `presence_reply_ad4m`. The waker emits per-perspective info
  // in `event.payload.context` for the origin envelope. See R7.
  if (ad4mService) {
    bus.on('ad4m.thread.message', async (event) => {
      const { text, context } = event.payload as {
        threadKey: string
        threadLabel: string
        text: string
        context?: {
          perspectiveUuid: string
          channelAddress?: string
          messageAddress: string
          body?: string
        }
      }
      const internalId = presenceModule.internalThreadId()
      if (!internalId) {
        console.warn('[ad4m] no presence-internal thread configured — dropping mention')
        return
      }
      const origin: import('@sovereign/core').MessageOrigin = {
        modality: 'ad4m',
        ad4m: context
          ? {
              perspectiveUuid: context.perspectiveUuid,
              channelAddress: context.channelAddress ?? '',
              messageAddress: context.messageAddress
            }
          : { perspectiveUuid: '', channelAddress: '', messageAddress: '' }
      }
      try {
        await chatModule.handleSend(internalId, text, undefined, { origin })
      } catch (err: unknown) {
        console.error('[ad4m] presence-internal thread message injection failed:', (err as Error)?.message)
      }
    })
  }
  // Shared by voice response + conversation summary below — both pair a
  // completed turn with recent thread history via the same session lookup.
  const getRecentTurns = async (threadId: string, limit: number): Promise<Array<{ role: string; content: string }>> => {
    const sessionKey = chatModule.getSessionKeyForThread(threadId)
    if (!sessionKey) return []
    try {
      const { turns } = await backend.getHistory(sessionKey)
      return turns.slice(-limit).map((t: any) => ({ role: t.role ?? 'user', content: t.content ?? '' }))
    } catch {
      return []
    }
  }

  // ── Voice response (auto-TTS for voice-originated messages) ────────
  // Generates immediate spoken acknowledgments and post-response summaries
  // for voice-originated messages using the local-llm for text generation
  // and the configured TTS service for audio synthesis.
  //
  // The `summarizeForSimpleConversation` closure gets wired into the
  // simple-conversation module so text-originated assistant turns receive
  // real LLM summaries instead of truncated raw text.
  let summarizeForSimpleConversation: ((text: string) => Promise<string>) | undefined
  {
    const llmCfg = localLlmConfigFromStore(configStore, dataDir)
    const voiceLlm = createInferenceClient({
      baseUrl: llmCfg.baseUrl,
      model: llmCfg.model,
      temperature: 0.3,
      maxTokens: 150,
      timeoutMs: 15_000,
      thinking: false
    })

    const voiceResponse = createVoiceResponse({
      bus,
      synthesize: (text: string) => voiceModule.synthesize(text),
      synthesizeStream: (text, onChunk, options) =>
        voiceModule.synthesizeStream(
          text,
          (chunk) =>
            onChunk({
              index: chunk.index,
              total: chunk.total,
              sentence: chunk.sentence,
              audio: chunk.audio,
              durationMs: chunk.durationMs,
              done: chunk.done
            }),
          options
        ),
      llm: voiceLlm,
      getRecentTurns,
      sendToDeviceName: (deviceName: string, msg: Record<string, unknown>) => {
        wsHandler.sendToDeviceName(deviceName, msg as any)
        // Push fallback — when no WS connection exists for the target device
        // (phone backgrounded/locked), send a push notification with the
        // spoken text so the user still receives Hex's reply.
        if (!wsHandler.isDeviceNameConnected(deviceName) && msg.type === 'voice.tts.audio' && msg.text) {
          const pushPayload = { type: 'voice.reply', text: msg.text, threadId: msg.threadId }
          void notificationsModule.pushManager.sendAll(pushPayload)
          console.log(
            `[voice-push-fallback] device "${deviceName}" offline — push notification sent: "${String(msg.text).slice(0, 60)}"`
          )
        }
      },
      getDeviceName: (deviceId: string) => wsHandler.getDeviceName(deviceId),
      config: () => {
        const v = configStore.get<SovereignConfig['voice']>('voice')
        return {
          autoTts: v?.autoTts ?? false,
          ttsUrl: v?.ttsUrl ?? '',
          ackDelayMs: v?.ackDelayMs ?? 1500,
          ackSystemPrompt: v?.prompts?.ackSystem ?? '',
          summarySystemPrompt: v?.prompts?.summarySystem ?? ''
        }
      }
    })

    // Hot-reload the inference client when local-llm config changes
    configStore.onChange('agentBackend.localLlm', () => {
      const next = localLlmConfigFromStore(configStore, dataDir)
      voiceLlm.updateConfig({
        baseUrl: next.baseUrl,
        model: next.model
      })
    })

    // ── On-demand TTS speak endpoint ──────────────────────────────────
    // Summarises text via the same LLM prompt used for voice response,
    // synthesises via F5-TTS, and returns base64 audio for client-side
    // playback (e.g. "Play aloud" context menu on assistant messages).
    app.post('/api/voice/speak', async (req, res) => {
      const { text } = (req as any).body ?? {}
      if (!text || typeof text !== 'string') {
        res.status(400).json({ error: 'text required' })
        return
      }

      const v = configStore.get<SovereignConfig['voice']>('voice')
      if (!v?.ttsUrl) {
        res.status(503).json({ error: 'No TTS service configured' })
        return
      }

      try {
        // Summarise for spoken delivery (same prompt as voice response summary)
        const summaryPrompt = v?.prompts?.summarySystem || DEFAULT_SUMMARY_SYSTEM
        type Role = 'system' | 'user' | 'assistant' | 'tool'
        const messages: Array<{ role: Role; content: string }> = [
          { role: 'system', content: summaryPrompt },
          {
            role: 'user',
            content: `Summarize this assistant response for spoken delivery:\n\n${text.slice(0, 4000)}`
          }
        ]
        const completion = await voiceLlm.complete(messages)
        const spokenText = completion.choices?.[0]?.message?.content?.trim() || text.slice(0, 500)

        // Synthesise audio
        const { audio, durationMs } = await voiceModule.synthesize(spokenText)
        const audioBase64 = audio.toString('base64')

        res.json({ audio: audioBase64, spokenText, durationMs })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[voice-speak] synthesis failed:', msg)
        res.status(500).json({ error: msg })
      }
    })

    // Expose the summarize function for the simple-conversation module
    // so text-originated turns get real LLM summaries, not truncation.
    summarizeForSimpleConversation = async (text: string) => {
      const v = configStore.get<SovereignConfig['voice']>('voice')
      const summaryPrompt = v?.prompts?.summarySystem || DEFAULT_SUMMARY_SYSTEM
      type Role = 'system' | 'user' | 'assistant' | 'tool'
      const messages: Array<{ role: Role; content: string }> = [
        { role: 'system', content: summaryPrompt },
        {
          role: 'user',
          content: `Summarize this assistant response for spoken delivery:\n\n${text.slice(0, 4000)}`
        }
      ]
      const completion = await voiceLlm.complete(messages)
      return completion.choices?.[0]?.message?.content?.trim() || ''
    }

    // TTS override state query — clients fetch on thread switch / reconnect
    app.get('/api/voice/tts-override', (req, res) => {
      const threadId = req.query.threadId as string
      if (!threadId) return res.status(400).json({ error: 'threadId query param required' })
      res.json(voiceResponse.getTtsOverride(threadId))
    })

    // Broadcast TTS override state changes to all connected clients so
    // toggling on one device updates every tab/device in real time.
    bus.on('voice.tts-override.state', (e) => {
      const payload = (e.payload ?? {}) as { threadId?: string; enabled?: boolean; deviceName?: string | null }
      if (!payload.threadId) return
      wsHandler.broadcastToChannel('chat', {
        type: 'voice.tts-override.state',
        threadId: payload.threadId,
        enabled: payload.enabled,
        deviceName: payload.deviceName
      })
    })

    // Expose for shutdown
    ;(app as any).__voiceResponse = voiceResponse
  }

  // ── Conversation summary (rolling summary bubble, presence gateway
  // thread only) ──────────────────────────────────────────────────────
  // Shares the local-llm connection settings with voice response above via
  // a dedicated client instance — the summary prompt needs more headroom
  // (maxTokens 200) than the ack/summary TTS pipeline (150), and a shared
  // instance would race the two prompts' generations against each other.
  //
  // Registers its GET /api/threads/:threadId/summary route at the same
  // path @sovereign/summary uses further below. That service ships
  // disabled by default and has no client consumer today, so this route
  // (mounted first) safely takes precedence whenever both run.
  {
    const llmCfg = localLlmConfigFromStore(configStore, dataDir)
    const summaryLlm = createInferenceClient({
      baseUrl: llmCfg.baseUrl,
      model: llmCfg.model,
      temperature: 0.3,
      maxTokens: 200,
      timeoutMs: 20_000,
      thinking: false
    })

    const conversationSummary = createConversationSummary({
      bus,
      llm: summaryLlm,
      getRecentTurns,
      config: () => {
        const v = configStore.get<SovereignConfig['voice']>('voice')
        const gateway = threadManager.getPresenceThread('gateway')
        return {
          enabled: v?.conversationSummary ?? false,
          gatewayThreadId: gateway?.id ?? null,
          systemPrompt: v?.prompts?.conversationSummarySystem ?? ''
        }
      }
    })
    app.use(createConversationSummaryRoutes(conversationSummary))

    // Push every update to the chat WS channel so the header bubble
    // refreshes live, without a page reload.
    bus.on('chat.summary.updated', (e) => {
      const payload = (e.payload ?? {}) as { threadId?: string; summary?: string }
      if (!payload.threadId || !payload.summary) return
      wsHandler.broadcastToChannel('chat', {
        type: 'chat.summary',
        threadId: payload.threadId,
        summary: payload.summary
      })
    })

    // Hot-reload the inference client when local-llm config changes
    configStore.onChange('agentBackend.localLlm', () => {
      const next = localLlmConfigFromStore(configStore, dataDir)
      summaryLlm.updateConfig({
        baseUrl: next.baseUrl,
        model: next.model
      })
    })

    // Expose for shutdown
    ;(app as any).__conversationSummary = conversationSummary
  }

  // ── Simple conversation (user↔Hex dialogue, presence gateway) ─────
  // Collects user messages + Hex's outbound replies (reply_voice /
  // reply_text) into a chronological log — the voice-level conversation
  // stripped of internal reasoning and tool calls. Powers the summary
  // bubble's "simple conversation" toggle.
  {
    const simpleConversation = createSimpleConversation({
      bus,
      config: () => {
        const gateway = threadManager.getPresenceThread('gateway')
        return { gatewayThreadId: gateway?.id ?? null }
      },
      dataDir: path.join(dataDir, 'presence'),
      summarize: summarizeForSimpleConversation
    })

    // REST endpoint — initial load / page refresh.
    app.get('/api/presence/simple-conversation', (_req, res) => {
      res.json({ entries: simpleConversation.getEntries() })
    })

    // Push new entries to the chat WS channel for live client updates.
    bus.on('presence.simple-conversation.updated', (e) => {
      const payload = (e.payload ?? {}) as {
        entry?: { role: string; text: string; modality: string; timestamp: string }
        total?: number
      }
      if (!payload.entry) return
      wsHandler.broadcastToChannel('chat', {
        type: 'chat.simple-conversation',
        entry: payload.entry,
        total: payload.total
      })
    })

    ;(app as any).__simpleConversation = simpleConversation
  }

  registerChatWs(wsHandler, chatModule, bus)
  app.use(createChatRoutes(chatModule, backend, dataDir))
  app.use(
    createThreadRoutes(threadManager, createForwardHandler(bus, threadManager), {
      chatModule,
      backend: routingBackend,
      cronService,
      askUserQuestionStore,
      getContextManagementConfig: () =>
        configStore.get<SovereignConfig['contextManagement']>('contextManagement') ?? cfg.contextManagement
    })
  )

  // ── Layer 3: scheduled cleanup cron ──────────────────────────────────
  // Register a system job that sweeps oversized session JSONLs on the
  // configured schedule (default: daily at 04:00 UTC). Enabled by default
  // even without explicit config — matches Layers 1/2 default-on behaviour.
  const CLEANUP_JOB_KIND = 'system-context-cleanup'
  const cleanupCfg = cfg.contextManagement?.cleanup
  const cleanupSchedule = cleanupCfg?.schedule ?? '0 4 * * *'
  if (cleanupCfg?.enabled !== false && scheduler) {
    // Remove stale instances from prior boots (hot-reload safe).
    for (const j of scheduler.list()) {
      if ((j.payload?.kind as string) === CLEANUP_JOB_KIND) scheduler.remove(j.id)
    }
    scheduler.add({
      name: 'context-cleanup-sweep',
      schedule: { kind: 'cron', expr: cleanupSchedule, tz: 'UTC' },
      payload: { kind: CLEANUP_JOB_KIND },
      enabled: true,
      tags: ['system']
    })
    bus.on('scheduler.job.due', async (event) => {
      const payload = event.payload as { job?: { id: string; payload?: Record<string, unknown> }; runId?: string }
      const job = payload.job
      if (!job || (job.payload?.kind as string) !== CLEANUP_JOB_KIND) return
      const cmCfg = configStore.get<SovereignConfig['contextManagement']>('contextManagement')
      const thresholdBytes = (cmCfg?.cleanup?.maxSessionSizeMB ?? 50) * 1024 * 1024
      const be = routingBackend.default()
      if (!be?.recycleSession || !be?.listSessions) return
      const sessions = await be.listSessions()
      let pruned = 0
      const trackedFiles = new Set<string>()
      for (const session of sessions) {
        const filePath = be.getSessionFilePath?.(session.key)
        if (!filePath) continue
        trackedFiles.add(filePath)
        try {
          const stat = fs.statSync(filePath)
          if (stat.size < thresholdBytes) continue
          const result = await be.recycleSession(session.key, { force: true })
          if (result && result.reclaimedBytes > 0) pruned++
        } catch {
          /* skip — session may have ended mid-sweep */
        }
      }

      // ── Orphan sweep ────────────────────────────────────────────────
      // `listSessions()` above only returns sessions Sovereign currently
      // tracks in memory against a live thread. A crashed or stale session
      // leaves its JSONL transcript on disk with nothing tracking it, so it
      // never reaches the loop above. Scan the raw session directory and
      // flag oversized files that don't belong to any tracked session.
      //
      // We only LOG here — pruning needs a live session context
      // (`recycleSession` interrupts a running query and resumes it).
      // Editing an untracked transcript blind risks corrupting a session
      // that later resumes. `cozempic doctor` or a manual pass handles the
      // actual reclaim.
      let orphanCount = 0
      // Derive from tracked session file paths only — no HOME fallback.
      // Non-production contexts must never scan production ~/.claude/projects.
      const projectsDir = deriveProjectsDir([...trackedFiles])
      if (projectsDir && fs.existsSync(projectsDir)) {
        for (const jsonlPath of listJsonlFilesRecursive(projectsDir)) {
          if (trackedFiles.has(jsonlPath)) continue
          try {
            const stat = fs.statSync(jsonlPath)
            if (stat.size < thresholdBytes) continue
          } catch {
            continue // file may have been removed mid-sweep
          }
          orphanCount++
          console.warn(`[context-cleanup] orphaned session file over threshold (untracked, not pruned): ${jsonlPath}`)
        }
      }

      bus.emit({
        type: 'scheduler.job.completed',
        timestamp: new Date().toISOString(),
        source: 'context-cleanup',
        payload: {
          runId: payload.runId,
          jobId: job.id,
          jobName: 'context-cleanup-sweep',
          summary: `pruned ${pruned} session(s)`,
          orphanedOversized: orphanCount
        }
      })
    })
  }
  // ── Summary service ──────────────────────────────────────────────────
  // Maintains rolling per-thread summaries via a local model. Fire-and-
  // forget — never blocks the main event loop. Disabled by default; the
  // user enables via config.summary.enabled + a reachable inference URL.
  const summaryCfg = cfg.summary
  if (summaryCfg?.enabled) {
    try {
      const summaryService = createSummaryService({
        bus,
        dataDir,
        config: {
          enabled: true,
          baseUrl: summaryCfg.baseUrl,
          model: summaryCfg.model,
          debounceMs: summaryCfg.debounceMs ?? 5000,
          maxSummaryWords: summaryCfg.maxSummaryWords ?? 200
        }
      })
      summaryService.start()
      app.use(createSummaryRoutes(summaryService))
    } catch (err) {
      console.warn('[bootstrap] summary service failed to start:', (err as Error)?.message)
    }
  }

  // Forward AskUserQuestion lifecycle events from the bus to the chat WS
  // channel so every connected client learns of new pending questions +
  // submissions in real time. The chat.work / chat.turn round-trip handles
  // the tool_result surface separately (the SDK echoes the answer JSON as a
  // user-role tool_result once the hook resolves), so these events are just
  // for the inline question card's own pending → answered transition.
  for (const evt of ['question.pending', 'question.answered', 'question.aborted'] as const) {
    bus.on(evt, (e: { timestamp: string; payload?: unknown }) => {
      wsHandler.broadcastToChannel('chat', {
        type: evt,
        timestamp: e.timestamp,
        ...((e.payload ?? {}) as Record<string, unknown>)
      })
    })
  }
  registerThreadsWs(wsHandler as any, threadManager, bus)

  // Now that chatModule exists, wire its `handleSend` as the cron-fire path
  // so cron messages enter the chat queue + broadcast like any user send.
  // Without this, the user-message portion of a cron fire only surfaced in
  // the open thread after a manual refresh.
  const setInjectChatMessage = (cronService as any).setInjectChatMessage as
    | ((fn?: (threadId: string, text: string, opts?: { kind?: 'cron' }) => Promise<void>) => void)
    | undefined
  if (typeof setInjectChatMessage === 'function') {
    setInjectChatMessage((threadId, text, opts) =>
      chatModule.handleSend(threadId, text, undefined, { synthRole: opts?.kind === 'cron' ? 'system' : 'user' })
    )
  }

  // Thread presence + push orchestration. Listens on the bus for
  // `chat.turn.completed` and `chat.message.sent`, and on the new `presence`
  // WS channel for thread.focus / thread.blur. Together: when an agent turn
  // completes and no device has the thread focused (and the thread isn't
  // muted), increment `unreadCount` and send a Web Push to every subscribed
  // device. Any iteration (focus or send) clears unread and asks subscribers
  // to dismiss matching-tag notifications. See `plans/push-notifications-spec.md`.
  const presence = createPresenceTracker()
  const muteStore = createMuteStore(dataDir)
  app.use(createThreadPresenceRoutes(muteStore))
  const presenceWs = registerPresenceWs(wsHandler as any, presence, bus, (threadId) => {
    bus.emit({
      type: 'thread.focused',
      timestamp: new Date().toISOString(),
      source: 'presence',
      payload: { threadId }
    })
  })
  const presenceOrchestrator = wirePresenceOrchestrator({
    bus,
    presence,
    muteStore,
    threadManager,
    push: notificationsModule.pushManager
  })

  // System module + routes
  const externalServices = configStore.get<SovereignConfig['services']['external']>('services.external') ?? []
  const systemModule = createSystemModule(bus, dataDir, {
    wsHandler,
    getAgentBackendStatus: () => backend.status(),
    getModelConfig: () => ({
      models: configStore.get<string[]>('models.available'),
      defaultModel: configStore.get<string>('models.default') || null
    }),
    externalServices,
    // Honour SEMBLE_BIN for non-standard installs; empty string opts out.
    sembleBin: process.env.SEMBLE_BIN ?? 'semble'
  })
  // Resolve the late-bound ref so the presence append resolver can read
  // health status when the first session starts.
  systemModuleRef = systemModule
  // Device monitor — collects system metrics from local + remote tailnet devices.
  // Discovery-first: `tailscale status --json` provides the device registry.
  // Optional `deviceOverrides` in config let the user set SSH aliases, labels,
  // watched services, or exclude specific peers — keyed by tailscale HostName.
  const deviceMonitor = createDeviceMonitor({
    overrides: configStore.get<Record<string, any>>('deviceOverrides') ?? {},
    cacheTtlMs: 30_000,
    sshTimeoutMs: 8_000
  })

  let personalityWatcherActive = !!personalityCompiler
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
      }),
      getPersonalityInfo: () => {
        const outputPath = path.join(agentDir, 'CLAUDE.md')
        try {
          const stat = fs.statSync(outputPath)
          return { compiledAt: stat.mtimeMs, size: stat.size, watcherActive: personalityWatcherActive, outputPath }
        } catch {
          return { compiledAt: null, size: 0, watcherActive: personalityWatcherActive, outputPath }
        }
      },
      getThreadMeta: (key: string) => {
        const t = threadManager.get(key)
        if (!t) return null
        return { label: t.label, membraneId: t.membraneId }
      },
      pushManager: {
        allSubscriptions: () => notificationsModule.pushManager.allSubscriptions(),
        getVapidPublicKey: () => notificationsModule.pushManager.getVapidPublicKey()
      },
      agentDir,
      metrics,
      deviceMonitor
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
          // `synthRole: 'system'` keeps the resume prompt out of the transcript
          // as a phantom user message — the user never typed it. The client
          // folds the resulting system turn into the preceding assistant turn's
          // work list (see `absorbFoldableTurn`), so a restart shows up as one
          // unobtrusive row rather than a fake bubble.
          await chatModule.handleSend(threadKey, text, undefined, { synthRole: 'system' })
        }
      })
        .then((report) => {
          lastResumeReport = { at: Date.now(), counts: report.counts, total: report.outcomes.length }
          // No auto-start of the presence internal thread — the LLM
          // session starts lazily on the first real inbound message
          // (voice, AD4M mention, digest, gateway forward). Presence
          // memory + health status get injected at that point via the
          // append resolver.
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
      // Flush active-sessions FIRST, then freeze it so the async teardown
      // from disconnectAll cannot overwrite the flushed entries on disk.
      // Without freeze: disconnectAll fires abort → finally block emits
      // idle → markIdle → remove → sync write, erasing every entry after
      // the flush already persisted them.
      activeSessions.flush()
      activeSessions.freeze()
      routingBackend.disconnectAll().catch(() => {})
      // Flush remaining file-backed caches synchronously.
      sessionsRegistry.flush()
      claudeCodeBackend?.flushState()
      chatModule.flushState()
      personalityWatcherActive = false
      personalityCompiler?.stop()
      browserService.dispose().catch(() => {})
      statusAggregator.destroy()
      systemModule.dispose()
      teardownKnowledgeGraph?.()
      eventStream.dispose()
      presenceOrchestrator.destroy()
      presenceWs.destroy()
      notificationsModule.dispose()
      wss.close()
      server.close()
    }
  }
}
