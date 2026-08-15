// Context & tool-call metrics — structured telemetry for tool I/O sizing,
// context filter effectiveness, compaction/recycle reclaim, and per-session
// budget tracking.  Emits structured JSON log lines to stdout and keeps
// in-memory aggregates queryable via API.
//
// Backends call the record* functions at instrumentation points.  The
// metrics accumulator lives for the lifetime of the process; session-scoped
// views are derived on read.

export interface ToolCallMetric {
  ts: number
  sessionKey: string
  backendKind: string
  model: string
  toolName: string
  inputChars: number
  outputChars: number
  /** Chars removed by context filter (0 when no filtering occurred). */
  outputTrimmedChars: number
  durationMs: number
  isSubagent: boolean
}

export interface CompactionMetric {
  ts: number
  sessionKey: string
  backendKind: string
  model: string
  preTokens: number
  postTokens: number
  tokensReclaimed: number
  /** 'compaction' = LLM summary, 'recycle' = JSONL prune, 'auto-recycle' = threshold-triggered recycle */
  method: 'compaction' | 'recycle' | 'auto-recycle'
  isSubagent: boolean
}

export interface ContextSnapshotMetric {
  ts: number
  sessionKey: string
  backendKind: string
  model: string
  totalTokens: number
  contextWindow: number
  fillPercent: number
}

export interface SessionAggregate {
  sessionKey: string
  backendKind: string
  model: string
  isSubagent: boolean
  toolCalls: number
  totalInputChars: number
  totalOutputChars: number
  totalTrimmedChars: number
  compactions: number
  totalTokensReclaimed: number
  /** Per-tool breakdown: toolName → { calls, inputChars, outputChars, trimmedChars } */
  byTool: Record<string, { calls: number; inputChars: number; outputChars: number; trimmedChars: number }>
}

// ---------------------------------------------------------------------------
// Ring buffer — keeps a fixed number of recent entries for the API endpoint.
// ---------------------------------------------------------------------------

class RingBuffer<T> {
  private buf: (T | undefined)[]
  private pos = 0
  private count = 0
  private capacity: number

  constructor(capacity: number) {
    this.capacity = capacity
    this.buf = new Array(capacity)
  }

  push(item: T): void {
    this.buf[this.pos] = item
    this.pos = (this.pos + 1) % this.capacity
    if (this.count < this.capacity) this.count++
  }

  toArray(): T[] {
    if (this.count < this.capacity) {
      return this.buf.slice(0, this.count) as T[]
    }
    // Wrap: pos → end, then 0 → pos
    return [...this.buf.slice(this.pos), ...this.buf.slice(0, this.pos)] as T[]
  }

  get size(): number {
    return this.count
  }
}

// ---------------------------------------------------------------------------
// Metrics accumulator
// ---------------------------------------------------------------------------

const TOOL_RING_SIZE = 500
const COMPACTION_RING_SIZE = 100
const SNAPSHOT_RING_SIZE = 200

export interface MetricsAccumulator {
  recordToolCall(m: ToolCallMetric): void
  recordCompaction(m: CompactionMetric): void
  recordContextSnapshot(m: ContextSnapshotMetric): void
  /** Recent tool-call entries (ring buffer, newest last). */
  recentToolCalls(): ToolCallMetric[]
  /** Recent compaction/recycle entries. */
  recentCompactions(): CompactionMetric[]
  /** Recent context snapshots. */
  recentSnapshots(): ContextSnapshotMetric[]
  /** Per-session aggregates, keyed by sessionKey. */
  sessionAggregates(): SessionAggregate[]
  /** Global totals across all sessions. */
  globalTotals(): {
    toolCalls: number
    totalInputChars: number
    totalOutputChars: number
    totalTrimmedChars: number
    compactions: number
    totalTokensReclaimed: number
    startedAt: number
  }
}

export function createMetricsAccumulator(): MetricsAccumulator {
  const toolRing = new RingBuffer<ToolCallMetric>(TOOL_RING_SIZE)
  const compactRing = new RingBuffer<CompactionMetric>(COMPACTION_RING_SIZE)
  const snapRing = new RingBuffer<ContextSnapshotMetric>(SNAPSHOT_RING_SIZE)

  // Per-session aggregates
  const sessions = new Map<string, SessionAggregate>()
  const startedAt = Date.now()

  // Global counters
  let gToolCalls = 0
  let gInputChars = 0
  let gOutputChars = 0
  let gTrimmedChars = 0
  let gCompactions = 0
  let gTokensReclaimed = 0

  function ensureSession(m: {
    sessionKey: string
    backendKind: string
    model: string
    isSubagent: boolean
  }): SessionAggregate {
    let s = sessions.get(m.sessionKey)
    if (!s) {
      s = {
        sessionKey: m.sessionKey,
        backendKind: m.backendKind,
        model: m.model,
        isSubagent: m.isSubagent,
        toolCalls: 0,
        totalInputChars: 0,
        totalOutputChars: 0,
        totalTrimmedChars: 0,
        compactions: 0,
        totalTokensReclaimed: 0,
        byTool: {}
      }
      sessions.set(m.sessionKey, s)
    }
    // Update model (may change mid-session)
    s.model = m.model
    return s
  }

  function recordToolCall(m: ToolCallMetric): void {
    toolRing.push(m)
    const s = ensureSession(m)

    s.toolCalls++
    s.totalInputChars += m.inputChars
    s.totalOutputChars += m.outputChars
    s.totalTrimmedChars += m.outputTrimmedChars

    const t = s.byTool[m.toolName] ?? { calls: 0, inputChars: 0, outputChars: 0, trimmedChars: 0 }
    t.calls++
    t.inputChars += m.inputChars
    t.outputChars += m.outputChars
    t.trimmedChars += m.outputTrimmedChars
    s.byTool[m.toolName] = t

    gToolCalls++
    gInputChars += m.inputChars
    gOutputChars += m.outputChars
    gTrimmedChars += m.outputTrimmedChars

    // Structured log line
    const tag = m.isSubagent ? 'subagent-tool' : 'tool'
    console.log(
      `[metrics] ${tag} session=${short(m.sessionKey)} model=${m.model} tool=${m.toolName} ` +
        `in=${m.inputChars} out=${m.outputChars} trimmed=${m.outputTrimmedChars} dur=${m.durationMs}ms`
    )
  }

  function recordCompaction(m: CompactionMetric): void {
    compactRing.push(m)
    const s = ensureSession(m)

    s.compactions++
    s.totalTokensReclaimed += m.tokensReclaimed

    gCompactions++
    gTokensReclaimed += m.tokensReclaimed

    console.log(
      `[metrics] ${m.method} session=${short(m.sessionKey)} model=${m.model} ` +
        `pre=${m.preTokens} post=${m.postTokens} reclaimed=${m.tokensReclaimed}` +
        `${m.isSubagent ? ' (subagent)' : ''}`
    )
  }

  function recordContextSnapshot(m: ContextSnapshotMetric): void {
    snapRing.push(m)
    // No log line — snapshots happen every turn, log only on recycle/compact.
  }

  return {
    recordToolCall,
    recordCompaction,
    recordContextSnapshot,
    recentToolCalls: () => toolRing.toArray(),
    recentCompactions: () => compactRing.toArray(),
    recentSnapshots: () => snapRing.toArray(),
    sessionAggregates: () => [...sessions.values()],
    globalTotals: () => ({
      toolCalls: gToolCalls,
      totalInputChars: gInputChars,
      totalOutputChars: gOutputChars,
      totalTrimmedChars: gTrimmedChars,
      compactions: gCompactions,
      totalTokensReclaimed: gTokensReclaimed,
      startedAt
    })
  }
}

/** Shorten a UUID session key to its first 8 chars for log readability. */
function short(key: string): string {
  return key.length > 8 ? key.slice(0, 8) : key
}
