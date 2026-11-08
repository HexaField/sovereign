// Timeline — one line per thing that happened inside Sovereign (forge, CI,
// agent turns, subagents, scheduler). The record type is shared by the
// server module (`@sovereign/timeline`) and the client's Overview panel.

/** Who or what set a turn going. */
export type TurnOrigin = 'user' | 'cron' | 'rethink' | 'agent' | 'subagent' | 'system'

export const TURN_ORIGINS: readonly TurnOrigin[] = ['user', 'cron', 'rethink', 'agent', 'subagent', 'system']

export type TimelineKind = 'forge' | 'github' | 'agent' | 'subagent' | 'scheduler' | 'system'

export const TIMELINE_KINDS: readonly TimelineKind[] = ['forge', 'github', 'agent', 'subagent', 'scheduler', 'system']

export interface TimelineEntry {
  /** `t<epoch ms base 36>-<random>`: entries are strictly ordered by `at`, so the time part orders ids too. */
  id: string
  at: string
  kind: TimelineKind
  /** Machine-readable, e.g. `turn.started`, `forge.merged`, `ci.failed`. */
  action: string
  title: string
  detail?: string
  threadId?: string
  threadLabel?: string
  membrane?: string
  origin?: TurnOrigin
  url?: string
}

/** One page of `GET /api/timeline`, newest first. `next` is the `before` cursor for the page after it. */
export interface TimelinePage {
  entries: TimelineEntry[]
  more: boolean
  next?: string
}
