// Work graph — the types the service, its ports and its routes share.

import { defaults, type SovereignConfig } from '@sovereign/config'
import type { Change, ForgeIssue, ForgeRef, WorkNode } from '@sovereign/core'

/** `forge` in config.json. */
export type ForgeConfig = SovereignConfig['forge']
export const DEFAULT_FORGE_CONFIG: ForgeConfig = defaults.forge

// ── Task port ──────────────────────────────────────────────────────────
// The contract lives in @sovereign/core (the tasks package implements it
// without depending on this one).

export type {
  PortTask,
  PortTaskKind,
  PortTaskState,
  PortTaskStatus,
  RelatedEdgeRecord,
  TaskInit,
  TaskPort
} from '@sovereign/core'

// ── Repo cache ─────────────────────────────────────────────────────────

/** A change as cached: the body is dropped once its "Paired with" refs are read. */
export interface CachedChange extends Change {
  paired: ForgeRef[]
  /** Branch compare against the base, keyed by head + base sha. */
  compare?: { ahead: number; behind: number; key: string }
  /** Total comments at the last read (owned changes only). */
  commentCount?: number
  /** Head sha the failed-check names were read for. */
  failedFor?: string
}

export type CachedIssue = Omit<ForgeIssue, 'body'> & { body: string; commentCount?: number }

export interface BackfillState {
  /** Cursor of the next page; absent before the first page. */
  cursor?: string
  done: boolean
  pages: number
  items: number
}

export interface RepoCache {
  version: 1
  forge: 'github' | 'radicle' | 'gitlab' | 'gitea' | 'local'
  host: string
  repo: string
  changes: Record<string, CachedChange>
  issues: Record<string, CachedIssue>
  /** Branch name → head sha (the last branch list). */
  branches: Record<string, string>
  /** ISO time the 21-day window sync finished. */
  windowSyncedAt?: string
  /** Start of the served window when the backfill began: it reads only items older than this. */
  backfillUntil?: string
  backfill: { changes: BackfillState; issues: BackfillState }
  lastOpenSyncAt?: string
  lastAllSyncAt?: string
  branchesSyncedAt?: string
  /** Node ids already reported stale. */
  stale: string[]
}

// ── Events, triage, digest ─────────────────────────────────────────────

export const FORGE_EVENT_TYPES = [
  'opened',
  'merged',
  'closed',
  'reopened',
  'pushed',
  'ci_failed',
  'ci_passed',
  'review_requested',
  'reviewed',
  'commented',
  'conflict',
  'behind_base',
  'base_merged',
  'labelled',
  'assigned',
  'referenced',
  'stale',
  'plan_changed'
] as const
export type ForgeEventType = (typeof FORGE_EVENT_TYPES)[number]

export interface ForgeEvent {
  at: string
  nodeId: string
  type: ForgeEventType
  detail: Record<string, unknown>
}

export type TriageVerdict = 'info' | 'needs-agent'
/** rule = a fixed rule decided; model = the classifier decided at ≥ threshold; model-low = below it; unavailable = no classifier answer. */
export type TriageTier = 'rule' | 'model' | 'model-low' | 'unavailable'

export interface TriagedEvent extends ForgeEvent {
  triage: TriageVerdict
  tier: TriageTier
  confidence?: number
}

export interface TriageCoverage {
  rule: { info: number; needsAgent: number }
  model: { info: number; needsAgent: number }
  modelLow: number
  unavailable: number
}

/** The decision model for events the rules cannot place. */
export interface ForgeClassifier {
  classify(input: {
    event: ForgeEvent
    node?: WorkNode
    owned: boolean
  }): Promise<{ choice: TriageVerdict; confidence: number } | undefined>
}

export interface DigestNode {
  node: WorkNode
  events: TriagedEvent[]
}

export interface DigestGroup {
  /** null = items in no stream. */
  stream: { id: string; name: string } | null
  nodes: DigestNode[]
}

export interface ForgeDigest {
  membrane: string
  since?: string
  /** Pass back as `since` for the next digest. */
  cursor?: string
  count: number
  groups: DigestGroup[]
}

/** What started a rethink run: its cron slot, "Rethink now", or a tool call in the rethink thread outside a run. */
export type RethinkTrigger = 'schedule' | 'manual' | 'chat'

// ── Overlay sources ────────────────────────────────────────────────────

export interface ThreadPresence {
  label: string
  status: 'working' | 'thinking' | 'idle'
  /** The thread is idle on a question to the user. */
  openQuestion?: boolean
}

export interface ActiveSubagent {
  key: string
  label: string
  parentThreadId: string
  cwd?: string
  startedAt: number
}

export interface ActiveCiWatch {
  threadKey: string
  repo: string
  target: { kind: 'pr'; number: number } | { kind: 'branch'; name: string } | { kind: 'sha'; sha: string }
  createdAt: number
}
