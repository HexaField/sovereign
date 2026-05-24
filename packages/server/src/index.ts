import dotenv from 'dotenv'
import fs from 'node:fs'
import https from 'node:https'
import http from 'node:http'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

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
import { createSchedulerRoutes } from './scheduler/routes.js'
import { createCronMonitor } from './scheduler/cron-monitor.js'
import { registerNotificationsChannel } from './notifications/ws.js'

// --- Phase 2: Orgs, Projects & Code ---
import { createOrgManager } from './orgs/orgs.js'
import { createOrgRoutes } from './orgs/routes.js'
import { registerOrgsChannel } from './orgs/ws.js'
import { createFileService } from './files/files.js'
import { createFileRouter } from './files/routes.js'
import { registerFilesChannel } from './files/ws.js'
import { createFileWatcher } from './files/watcher.js'
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
import { createBackend, createSessionsRegistry, routingAsBackend } from './agent-backend/index.js'
import { createOpenClawBackend, type OpenClawBackend } from './agent-backend/openclaw/openclaw.js'
import { openClawConfigFromEnv } from './agent-backend/openclaw/env-config.js'
import { getGatewayActivityMap } from './agent-backend/openclaw/parse-gateway-sessions.js'
import {
  createClaudeCodeBackend,
  claudeCodeConfigFromEnv,
  createSovereignMcpServer,
  createWorkspaceIndex,
  type ClaudeCodeBackend
} from './agent-backend/claude-code/index.js'
import { createCronService } from './scheduler/cron-service.js'
import type { AgentBackendKind, SubagentSummary, SessionSummary } from '@sovereign/core'
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
import { createDashboardRoutes } from './dashboard/routes.js'

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
scheduler.init() // start the 1s tick loop so Sovereign-native crons (and any other schedule kinds) actually fire
registerSchedulerChannel(wsHandler, bus)
app.use(createSchedulerRoutes(scheduler))
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

// Start file watcher for active org root path
const fileWatcher = createFileWatcher(bus, globalPath)
fileWatcher.start()

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

// Build the multi-backend routing layer. OpenClaw is always available; the
// Claude Code adapter joins it when `SOVEREIGN_ENABLED_BACKENDS` includes it.
const sessionsRegistry = createSessionsRegistry(dataDir)
const enabledBackendsEnv = (process.env.SOVEREIGN_ENABLED_BACKENDS?.trim() || 'openclaw')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean) as AgentBackendKind[]
const defaultBackendKind = (process.env.SOVEREIGN_DEFAULT_BACKEND?.trim() || 'openclaw') as AgentBackendKind

// Forward-declarations: the Claude Code backend's MCP server needs to call
// into cron + sessions + planning modules which are constructed after the
// backend factory runs. We wire the deps via a mutable container that the
// MCP server captures by reference.
const mcpDeps: { sovereignMcpDeps?: import('./agent-backend/claude-code/index.js').SovereignToolDeps } = {}
const sovereignMcpServer = createSovereignMcpServer({
  cron: {
    async createUserMessageCron(o) {
      return mcpDeps.sovereignMcpDeps!.cron.createUserMessageCron(o)
    },
    async list(d) {
      return mcpDeps.sovereignMcpDeps!.cron.list(d)
    },
    async remove(id) {
      return mcpDeps.sovereignMcpDeps!.cron.remove(id)
    }
  },
  sessions: {
    async list(f) {
      return mcpDeps.sovereignMcpDeps!.sessions.list(f)
    },
    async send(k, t) {
      return mcpDeps.sovereignMcpDeps!.sessions.send(k, t)
    },
    async history(k, l) {
      return mcpDeps.sovereignMcpDeps!.sessions.history(k, l)
    }
  },
  agents: {
    async list(p) {
      return mcpDeps.sovereignMcpDeps!.agents.list(p)
    },
    async spawn(p, o) {
      return mcpDeps.sovereignMcpDeps!.agents.spawn(p, o)
    }
  },
  notifications: {
    send(o) {
      return mcpDeps.sovereignMcpDeps!.notifications.send(o)
    }
  },
  planning: {
    async createIssue(o) {
      return mcpDeps.sovereignMcpDeps!.planning.createIssue(o)
    },
    async updateIssue(o) {
      return mcpDeps.sovereignMcpDeps!.planning.updateIssue(o)
    }
  },
  orgs: {
    list() {
      return mcpDeps.sovereignMcpDeps!.orgs.list()
    }
  },
  meetings: {
    async list(orgId, limit) {
      return mcpDeps.sovereignMcpDeps!.meetings.list(orgId, limit)
    },
    async read(orgId, id) {
      return mcpDeps.sovereignMcpDeps!.meetings.read(orgId, id)
    }
  },
  currentSessionKey() {
    return mcpDeps.sovereignMcpDeps?.currentSessionKey?.()
  }
})

let claudeCodeBackendRef: ClaudeCodeBackend | undefined

const routingBackend = createBackend({
  enabled: enabledBackendsEnv,
  default: defaultBackendKind,
  registry: sessionsRegistry,
  factories: {
    openclaw: () => createOpenClawBackend(openClawConfigFromEnv(dataDir)),
    'claude-code': () => {
      const cc = createClaudeCodeBackend(claudeCodeConfigFromEnv(dataDir), {
        sovereignMcpServer,
        registry: {
          upsertSession(record) {
            sessionsRegistry.upsert({
              threadKey: record.threadKey,
              sessionKey: record.sessionKey,
              backendKind: 'claude-code',
              backendSessionId: record.backendSessionId,
              backendSessionFile: record.backendSessionFile,
              label: record.label,
              parentSessionKey: record.parentSessionKey,
              orgId: record.orgId,
              cwd: record.cwd,
              model: record.model
            })
          },
          lookupSession(sessionKey) {
            const existing = sessionsRegistry.getBySession(sessionKey)
            if (!existing || existing.backendKind !== 'claude-code' || !existing.backendSessionId) return null
            return {
              backendSessionId: existing.backendSessionId,
              backendSessionFile: existing.backendSessionFile,
              label: existing.label,
              parentSessionKey: existing.parentSessionKey,
              orgId: existing.orgId,
              cwd: existing.cwd,
              model: existing.model
            }
          }
        },
        toolPolicy: async ({ toolName, orgId }) => {
          // Per-org tool allowlist policy.
          //
          // Org config can declare `agent.toolAllowlist: string[]` and/or
          // `agent.toolDenylist: string[]` to constrain which built-in tools
          // this org's agents may invoke. Both are optional; when neither is
          // set, permit-all.
          if (!orgId) return { decision: 'allow' }
          let cfg: Record<string, unknown> | null = null
          try {
            cfg = orgManager.getOrgConfig(orgId) as Record<string, unknown>
          } catch {
            return { decision: 'allow' }
          }
          const agentCfg = (cfg?.agent ?? {}) as Record<string, unknown>
          const allow = Array.isArray(agentCfg.toolAllowlist) ? (agentCfg.toolAllowlist as string[]) : null
          const deny = Array.isArray(agentCfg.toolDenylist) ? (agentCfg.toolDenylist as string[]) : null
          if (deny && deny.includes(toolName)) {
            return { decision: 'deny', reason: `Tool '${toolName}' is denied by org '${orgId}' policy.` }
          }
          if (allow && allow.length > 0 && !allow.includes(toolName)) {
            return { decision: 'deny', reason: `Tool '${toolName}' is not in org '${orgId}' allowlist.` }
          }
          return { decision: 'allow' }
        }
      })
      claudeCodeBackendRef = cc
      return cc
    }
  }
})

// Workspace-folder index in ~/.claude/CLAUDE.md — kept in sync with orgs.
const workspaceIndex = createWorkspaceIndex({
  filePath: path.join(process.env.HOME ?? '', '.claude', 'CLAUDE.md')
})
function refreshWorkspaceIndex() {
  const orgs = orgManager.listOrgs()
  workspaceIndex.setEntries(orgs.map((o: any) => ({ path: o.path, description: o.name, orgId: o.id })))
}

// The OpenClaw adapter is the only backend exposing legacy gateway-only
// surfaces (sessions.list RPC for the SSE status fallback, the activity-map
// for the threads index). Modules outside the adapter look these up via the
// routing layer instead of importing from `agent-backend/openclaw/*`.
const openClawBackend = routingBackend.forKind('openclaw') as OpenClawBackend | undefined

// Single AgentBackend reference for callers expecting the old shape.
// Per-session methods (sendMessage/abort/getHistory/etc.) dispatch through
// `routing.forSession()` so threads bound to Claude Code route there while
// OpenClaw threads stay on OpenClaw.
const backend = routingAsBackend(routingBackend)

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
app.use(createChatRoutes(chatModule, backend, dataDir))

// Bulk active subagents grouped by parent thread
app.get('/api/threads/active-subagents', async (_req, res) => {
  try {
    const result: Record<string, Array<{ sessionKey: string; label: string; status: string; task: string }>> = {}

    // Aggregate subagents across every enabled backend.
    for (const inst of routingBackend.all()) {
      let subagentSessions: SessionSummary[] = []
      try {
        subagentSessions = await inst.backend.listSessions({ kind: 'subagent' })
      } catch {
        continue
      }

      for (const s of subagentSessions) {
        const status = s.agentStatus || 'done'
        const isActive = status === 'running' || status === 'working' || status === 'thinking'
        if (!isActive) continue
        if (!s.parentKey) continue

        let threadKey = 'main'
        if (s.parentKey === 'agent:main:main') threadKey = 'main'
        else if (s.parentKey.startsWith('agent:main:thread:')) threadKey = s.parentKey.replace('agent:main:thread:', '')
        else if (s.parentKey.includes(':subagent:')) threadKey = s.parentKey

        if (!result[threadKey]) result[threadKey] = []
        result[threadKey].push({
          sessionKey: s.key,
          label: s.label || s.key.split(':subagent:')[1]?.slice(0, 8) || 'Subagent',
          status: status === 'running' ? 'working' : status,
          task: s.task || s.label || ''
        })
      }
    }

    res.json({ subagents: result })
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to list subagents' })
  }
})

// Subagent listing — children of a thread, aggregated across enabled backends.
app.get('/api/threads/:key/subagents', async (req, res) => {
  try {
    const threadKey = req.params.key
    const parentSessionKey =
      threadKey === 'main'
        ? 'agent:main:main'
        : threadKey.startsWith('agent:')
          ? threadKey
          : `agent:main:thread:${threadKey}`

    const subagents: SubagentSummary[] = []
    for (const inst of routingBackend.all()) {
      try {
        const list = await inst.backend.listSubagents(parentSessionKey)
        subagents.push(...list)
      } catch {
        /* ignore per-backend errors */
      }
    }

    res.json({ subagents })
  } catch (err: any) {
    console.error('Failed to list subagents:', err.message)
    res.status(500).json({ error: 'Failed to list subagents' })
  }
})

// Subagent history — fetch chat history for a subagent session key
// Simple cache for subagent history to avoid hammering the gateway
const subagentHistoryCache = new Map<string, { data: any; ts: number }>()
const SUBAGENT_CACHE_TTL = 5000 // 5 seconds

app.get('/api/threads/:key/history', async (req, res) => {
  try {
    const sessionKey = req.params.key.startsWith('agent:') ? req.params.key : `agent:main:subagent:${req.params.key}`
    const cached = subagentHistoryCache.get(sessionKey)
    if (cached && Date.now() - cached.ts < SUBAGENT_CACHE_TTL) {
      return res.json({ history: cached.data })
    }
    const { turns: history } = await routingBackend.forSession(sessionKey).getHistory(sessionKey)
    subagentHistoryCache.set(sessionKey, { data: history, ts: Date.now() })
    // Evict old entries
    if (subagentHistoryCache.size > 50) {
      const now = Date.now()
      for (const [k, v] of subagentHistoryCache) {
        if (now - v.ts > 30000) subagentHistoryCache.delete(k)
      }
    }
    res.json({ history })
  } catch (err: any) {
    console.error('Failed to get subagent history:', err.message)
    res.status(500).json({ error: 'Failed to get history' })
  }
})

const forwardHandler = createForwardHandler(bus, threadManager)
// Runtime sessions endpoint — aggregates main/thread sessions from every
// enabled backend and merges with the local thread registry. Replaces the
// old gateway-sessions endpoint (still served at the legacy path).
app.get('/api/threads/gateway-sessions', async (_req, res) => {
  try {
    const localThreads = threadManager.list() as any[]
    const localMap = new Map(localThreads.map((t) => [t.key, t]))
    for (const t of localThreads) {
      if (t.key === 'main') localMap.set('agent:main:main', t)
      else if (!t.key.startsWith('agent:')) localMap.set(`agent:main:thread:${t.key}`, t)
    }

    const merged: Array<{
      key: string
      shortKey: string
      kind: string
      label: string
      lastActivity?: number
      orgId?: string
      localLabel?: string
      isRegistered: boolean
    }> = []

    for (const inst of routingBackend.all()) {
      let sessions: SessionSummary[] = []
      try {
        sessions = await inst.backend.listSessions()
      } catch {
        continue
      }
      for (const s of sessions) {
        if (s.kind !== 'main' && s.kind !== 'thread') continue
        let shortKey = s.key
        if (shortKey.startsWith('agent:main:')) shortKey = shortKey.slice('agent:main:'.length)
        if (shortKey.startsWith('thread:')) shortKey = shortKey.slice('thread:'.length)
        const local = localMap.get(s.key) || localMap.get(shortKey)
        merged.push({
          key: s.key,
          shortKey,
          kind: s.kind,
          label: s.label || shortKey,
          lastActivity: s.lastActivity,
          orgId: local?.orgId,
          localLabel: local?.label,
          isRegistered: !!local
        })
      }
    }

    res.json({ sessions: merged })
  } catch (err: any) {
    console.error('Failed to list sessions:', err.message)
    res.status(500).json({ error: 'Failed to list sessions' })
  }
})

// Sovereign-native cron service — routes cron-related endpoints through it.
// Wires `Scheduler` + `bus` so the Sovereign-native cron path (used by the
// Claude Code adapter + future Pi adapter) fires user-messages into the
// bound thread via `routing.forSession(threadKey).sendMessage(...)`.
const cronService = createCronService({ routing: routingBackend, scheduler, bus })

// Thread cron jobs endpoint
app.get('/api/threads/:key/crons', async (req, res) => {
  try {
    const threadKey = req.params.key
    const sessionKey =
      chatModule.getSessionKeyForThread(threadKey) ??
      (threadKey === 'main'
        ? 'agent:main:main'
        : threadKey.startsWith('agent:')
          ? threadKey
          : `agent:main:thread:${threadKey}`)
    // Race against a 5s timeout so a slow backend doesn't block the UI
    const jobs = await Promise.race([
      cronService.list(true),
      new Promise<any[]>((_, reject) => setTimeout(() => reject(new Error('cron list timeout')), 5000))
    ]).catch(() => [] as any[])
    // Filter for crons targeting this thread's session
    const filtered = jobs.filter((j: any) => {
      if (j.sessionTarget === sessionKey) return true
      if (j.sessionKey === sessionKey) return true
      if (j.payload?.sessionTarget === sessionKey) return true
      // Also match session:agent:... format against agent:... format
      if (j.sessionTarget === `session:${sessionKey}`) return true
      // Check if payload text/message mentions the thread key
      const text = j.payload?.message || j.payload?.text || ''
      if (text.includes(threadKey)) return true
      return false
    })
    res.json({ crons: filtered })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ── Cron Management Endpoints ──

// Helper: derive threadKey from sessionTarget or sessionKey
function deriveThreadKey(sessionTarget?: string, sessionKey?: string): string | null {
  for (const val of [sessionTarget, sessionKey]) {
    if (!val) continue
    // session:agent:main:thread:<key>
    const sessionMatch = val.match(/^session:agent:main:thread:(.+)$/)
    if (sessionMatch) return sessionMatch[1]
    // agent:main:thread:<key>
    const agentMatch = val.match(/^agent:main:thread:(.+)$/)
    if (agentMatch) return agentMatch[1]
  }
  return null
}

// Helper: detect issues with a cron job
function detectCronIssues(job: any): string[] {
  const issues: string[] = []
  // missing-channel
  if (!job.delivery?.channel) {
    issues.push('missing-channel')
  }
  // wrong-session-target — targets "isolated" or "main" AND has no sessionKey routing to a thread
  const target = job.sessionTarget || ''
  const threadKey = deriveThreadKey(job.sessionTarget, job.sessionKey)
  if ((target === 'isolated' || target === 'main') && !threadKey) {
    issues.push('wrong-session-target')
  }
  // system-event-on-thread — using systemEvent payload but targeting a thread session
  if (threadKey && job.payload?.kind === 'systemEvent') {
    issues.push('system-event-on-thread')
  }
  // disabled-after-error
  if (job.enabled === false && job.state?.lastStatus === 'error') {
    issues.push('disabled-after-error')
  }
  // no-delivery-channels — webchat is the only channel and no real messaging channels exist
  if (job.delivery?.channel === 'webchat' && job.delivery?.mode === 'announce') {
    issues.push('no-delivery-channels')
  }
  return issues
}

// GET /api/crons — list ALL cron jobs with issue detection + threadKey derivation
app.get('/api/crons', async (_req, res) => {
  try {
    const jobs = await Promise.race([
      cronService.list(true),
      new Promise<any[]>((_, reject) => setTimeout(() => reject(new Error('cron list timeout')), 5000))
    ]).catch(() => [] as any[])
    const annotated = jobs.map((j: any) => ({
      ...j,
      threadKey: deriveThreadKey(j.sessionTarget, j.sessionKey),
      issues: detectCronIssues(j)
    }))
    res.json({ crons: annotated })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// PATCH /api/crons/:id — update a cron job
app.patch('/api/crons/:id', async (req, res) => {
  try {
    const result = await cronService.update(req.params.id, req.body)
    res.json({ ok: true, cron: result })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/crons/:id — remove a cron job
app.delete('/api/crons/:id', async (req, res) => {
  try {
    await cronService.remove(req.params.id)
    res.json({ ok: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/crons/:id/fix-thread — one-click fix to pin cron to a thread
app.post('/api/crons/:id/fix-thread', async (req, res) => {
  try {
    const { threadKey } = req.body
    if (!threadKey) {
      return res.status(400).json({ error: 'threadKey is required' })
    }
    const jobs = await cronService.list(true)
    const job = jobs.find((j: any) => j.id === req.params.id)
    if (!job) {
      return res.status(404).json({ error: 'Cron job not found' })
    }
    const patch: Record<string, unknown> = {
      sessionTarget: `session:agent:main:thread:${threadKey}`,
      sessionKey: `agent:main:thread:${threadKey}`,
      delivery: { mode: 'none' },
      enabled: true
    }
    const result = await cronService.update(req.params.id, patch)
    res.json({ ok: true, cron: result })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/crons/:id/toggle — enable/disable toggle
app.post('/api/crons/:id/toggle', async (req, res) => {
  try {
    const jobs = await cronService.list(true)
    const job = jobs.find((j: any) => j.id === req.params.id)
    if (!job) {
      return res.status(404).json({ error: 'Cron job not found' })
    }
    const result = await cronService.update(req.params.id, { enabled: !job.enabled })
    res.json({ ok: true, cron: result })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/crons/cleanup — bulk remove disabled+errored+past crons
app.delete('/api/crons/cleanup', async (_req, res) => {
  try {
    const jobs = await cronService.list(true)
    const toRemove = jobs.filter((j: any) => {
      if (j.enabled === false && j.state?.lastStatus === 'error') return true
      if (j.enabled === false && j.deleteAfterRun === true) return true
      if (j.schedule?.kind === 'oneshot' && j.schedule?.at) {
        const atMs = new Date(j.schedule.at).getTime()
        if (!isNaN(atMs) && atMs < Date.now()) return true
      }
      return false
    })
    let removed = 0
    for (const job of toRemove) {
      try {
        await cronService.remove(job.id)
        removed++
      } catch {
        /* keep going */
      }
    }
    res.json({ ok: true, removed, total: toRemove.length })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/crons/channel-status — check if any delivery channels are configured
app.get('/api/crons/channel-status', async (_req, res) => {
  try {
    const jobs = await Promise.race([
      cronService.list(true),
      new Promise<any[]>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ]).catch(() => [] as any[])
    const channels = new Set<string>()
    for (const j of jobs) {
      if (j.delivery?.channel) channels.add(j.delivery.channel)
    }
    const realChannels = [...channels].filter((c) => c !== 'webchat')
    const hasRealChannels = realChannels.length > 0
    res.json({
      hasRealChannels,
      channels: [...channels],
      realChannels,
      warning: hasRealChannels
        ? null
        : 'No messaging channels configured. Cron delivery via "webchat" only works during active browser sessions. Configure Telegram, Discord, or another channel for reliable delivery.'
    })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/crons/runs — get cron run history, optionally filtered by thread
app.get('/api/crons/runs', async (req, res) => {
  try {
    const threadKeyFilter = req.query.threadKey as string | undefined
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100)
    const entries = await cronService.runs()

    if (!threadKeyFilter) {
      return res.json({ entries: entries.slice(0, limit) })
    }

    const jobs = await cronService.list(true)
    const jobThreadMap = new Map<string, string | null>()
    for (const job of jobs) {
      jobThreadMap.set(job.id, deriveThreadKey(job.sessionTarget, job.sessionKey))
    }
    const filtered = entries.filter((e: any) => jobThreadMap.get(e.jobId) === threadKeyFilter)
    res.json({ entries: filtered.slice(0, limit) })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

app.use(
  createThreadRoutes(threadManager, forwardHandler, {
    chatModule,
    backend: routingBackend,
    activityProvider: openClawBackend
      ? { getGatewayActivityMap: () => getGatewayActivityMap(openClawBackend.paths.sessionsJsonPath) }
      : undefined
  })
)

// Model reset on boot removed — users' model choices are now preserved across restarts
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
  onSummarize: async (_meeting, transcriptText) => {
    const url = process.env.SOVEREIGN_SUMMARIZE_URL
    if (!url) {
      return {
        text: 'Summarization not configured — set SOVEREIGN_SUMMARIZE_URL',
        actionItems: [],
        decisions: [],
        keyTopics: []
      }
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: `Summarize the following meeting transcript. Return JSON with fields: text (string summary), actionItems (array of {text, assignee?}), decisions (string[]), keyTopics (string[]).\n\nTranscript:\n${transcriptText}`
        })
      })
      if (!res.ok) throw new Error(`Summarize endpoint returned ${res.status}`)
      const data = await res.json()
      return {
        text: data.text ?? data.summary ?? 'No summary returned',
        actionItems: data.actionItems ?? [],
        decisions: data.decisions ?? [],
        keyTopics: data.keyTopics ?? []
      }
    } catch (err: any) {
      return {
        text: `Summarization failed: ${err.message}`,
        actionItems: [],
        decisions: [],
        keyTopics: []
      }
    }
  }
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
app.use(createSystemRoutes({ system: systemModule, logsChannel, dataDir, healthHistory, routingBackend }))

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

// Populate the deferred Sovereign-MCP deps now that every module exists.
mcpDeps.sovereignMcpDeps = {
  cron: {
    async createUserMessageCron(o) {
      return cronService.createUserMessageCron(o)
    },
    async list(d) {
      return cronService.list(d)
    },
    async remove(id) {
      return cronService.remove(id)
    }
  },
  sessions: {
    async list(filter) {
      const out: Array<{ key: string; label?: string; kind?: string }> = []
      for (const inst of routingBackend.all()) {
        if (filter?.backendKind && inst.kind !== filter.backendKind) continue
        try {
          const list = await inst.backend.listSessions()
          for (const s of list) out.push({ key: s.key, label: s.label, kind: s.kind })
        } catch {
          /* ignore per-backend errors */
        }
      }
      return out
    },
    async send(sessionKey, text) {
      const key = sessionKey.startsWith('agent:')
        ? sessionKey
        : sessionKey === 'main'
          ? 'agent:main:main'
          : `agent:main:thread:${sessionKey}`
      await routingBackend.forSession(key).sendMessage(key, text)
    },
    async history(sessionKey, limit) {
      const key = sessionKey.startsWith('agent:')
        ? sessionKey
        : sessionKey === 'main'
          ? 'agent:main:main'
          : `agent:main:thread:${sessionKey}`
      const { turns } = await routingBackend.forSession(key).getHistory(key)
      return turns.slice(-(limit ?? 20)).map((t: any) => ({ role: t.role, content: t.content }))
    }
  },
  agents: {
    async list(parentKey) {
      const out: Array<{ sessionKey: string; label: string; status: string; task?: string }> = []
      for (const inst of routingBackend.all()) {
        try {
          const list = await inst.backend.listSubagents(parentKey)
          for (const s of list) out.push({ sessionKey: s.sessionKey, label: s.label, status: s.status, task: s.task })
        } catch {
          /* ignore */
        }
      }
      return out
    },
    async spawn(parentKey, opts) {
      const backend = routingBackend.forSession(parentKey)
      if (!backend.spawnSubagent) throw new Error('agents_spawn: backend does not support subagent spawn')
      const childKey = await backend.spawnSubagent(parentKey, { task: opts.task, label: opts.label })
      return { sessionKey: childKey }
    }
  },
  notifications: {
    send(input) {
      // Append directly to the notifications store + emit on the bus so the
      // existing notifications WS channel relays it to the UI.
      const id = randomUUID()
      const notification = {
        id,
        timestamp: new Date().toISOString(),
        severity: (input.severity as 'info' | 'warning' | 'error' | 'critical') ?? 'info',
        title: input.title,
        body: input.body ?? '',
        source: 'sovereign-agent',
        read: false,
        dismissed: false,
        entityId: input.entityId
      }
      notificationsModule._store.append(notification)
      bus.emit({
        type: 'notification.created',
        timestamp: notification.timestamp,
        source: 'notifications',
        payload: notification
      })
      return { id }
    }
  },
  planning: {
    async createIssue(o) {
      const result = await planningService.createIssue(o.orgId, {
        remote: o.remote,
        projectId: o.projectId,
        title: o.title,
        body: o.body,
        labels: o.labels,
        assignees: o.assignees
      })
      return {
        id: result.issue.id,
        orgId: result.issue.orgId,
        projectId: result.issue.projectId,
        title: result.issue.title
      }
    },
    async updateIssue(o) {
      const updated = await issueTracker.update(o.orgId, o.projectId, o.issueId, {
        title: o.title,
        body: o.body,
        state: o.state,
        labels: o.labels
      })
      return {
        id: updated.id,
        orgId: updated.orgId,
        projectId: updated.projectId,
        title: updated.title,
        state: updated.state
      }
    }
  },
  orgs: {
    list() {
      return orgManager.listOrgs().map((o: any) => ({ id: o.id, name: o.name, path: o.path }))
    }
  },
  meetings: {
    async list(orgId, limit) {
      const list = await meetingsService.list(orgId, { limit: limit ?? 20 })
      return list.map((m: any) => ({ id: m.id, title: m.title, createdAt: m.createdAt }))
    },
    async read(orgId, id) {
      const m = await meetingsService.get(orgId, id)
      if (!m) return null
      return {
        id: m.id,
        title: m.title,
        transcript: m.transcript?.text,
        summary: m.summary?.text
      }
    }
  },
  currentSessionKey() {
    return claudeCodeBackendRef?.getActiveSessionKey()
  }
}

// Workspace folder index — refresh on boot + when org list changes.
refreshWorkspaceIndex()
bus.on('org.created', () => refreshWorkspaceIndex())
bus.on('org.updated', () => refreshWorkspaceIndex())
bus.on('org.deleted', () => refreshWorkspaceIndex())
app.use(createDashboardRoutes({ orgManager, threadManager, notifications: notificationsModule, system: systemModule }))

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

routingBackend.connectAll().catch((err: any) => {
  console.error('Failed to connect agent backend(s):', err.message)
})

// ============================================================
// Cron Monitor — polls for cron run results and broadcasts to clients
// ============================================================

const cronMonitor = createCronMonitor({
  cronService,
  wsHandler,
  pollIntervalMs: 30_000,
  autoFixIntervalMs: 15_000
})

// Start after a short delay to let backend connect first
setTimeout(() => cronMonitor.start(), 5000)

// ============================================================
// Graceful shutdown
// ============================================================

function shutdown() {
  fileWatcher.stop()
  scheduler.destroy()
  terminalManager.dispose()
  cronMonitor.stop()
  routingBackend.disconnectAll().catch(() => {})
  sessionsRegistry.flush()
  workspaceIndex.flush()
  workspaceIndex.dispose()
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
