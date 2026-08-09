# Context Management — Design

Sovereign currently has zero active context management. The SDK's built-in auto-compaction triggers at ~80% of the context window — a blunt instrument that summarises everything. Cozempic's guard daemon cannot help because it operates by killing and restarting CLI processes, and Sovereign manages sessions via the SDK in-process.

This design fills the gap with three intervention layers, each building on SDK surfaces that already exist but go unused.

## Problem Breakdown

Session diagnostic (this session, typical):

| Category         | Size    | % of session |
| ---------------- | ------- | ------------ |
| Tool results     | 40.65MB | 40.5%        |
| User messages    | 85.18MB | 84.9%        |
| Signatures       | 6.16MB  | 6.1%         |
| Thinking content | 88.3KB  | 0.1%         |

User messages dominate because they carry injected system-reminders, CLAUDE.md re-injection, and tool-result-wrapper blocks the SDK wraps in `role: user` envelopes.

Context bloat enters through three channels:

1. **Tool results** — large Bash/Read/Grep outputs enter context verbatim
2. **System reminders** — CLAUDE.md and hook output re-injected every turn
3. **Stale history** — old tool results stay at full fidelity forever

Each channel needs a different intervention point.

## Architecture

```
              ┌─────────────────────────────────────────────┐
              │  Layer 1: PREVENT (real-time interception)   │
              │  PostToolUse hook → trim/dedup before model  │
              │  Prevents bloat from entering context        │
              └──────────────────┬──────────────────────────┘
                                 │
              ┌──────────────────▼──────────────────────────┐
              │  Layer 2: RECLAIM (session recycle)          │
              │  Monitor tokens → interrupt → prune → resume │
              │  Reduces accumulated bloat mid-session       │
              └──────────────────┬──────────────────────────┘
                                 │
              ┌──────────────────▼──────────────────────────┐
              │  Layer 3: CLEAN (between-session)            │
              │  SessionStore adapter / cron treat           │
              │  Prunes on resume, cleans old sessions       │
              └─────────────────────────────────────────────┘
```

---

## Layer 1: Prevent — Real-Time Tool Output Interception

### SDK Surface

`PostToolUseHookSpecificOutput` (sdk.d.ts:2229):

```typescript
{
  hookEventName: 'PostToolUse'
  updatedToolOutput?: unknown    // replaces tool output before model sees it
  updatedMCPToolOutput?: unknown // MCP-specific variant (prefer updatedToolOutput)
  additionalContext?: string
}
```

Sovereign already wires `onPostToolUse` (claude-code.ts:785) but returns bare `{ continue: true }`. The `updatedToolOutput` field goes unused.

### What It Does

Before a tool result enters the model's context window, Sovereign rewrites it:

1. **Trim large outputs** — any tool result >8KB gets truncated (first half + last half with a `[trimmed]` marker). Configurable threshold.
2. **Deduplicate content blocks** — md5 hash of each block ≥1KB; second occurrence gets a stub (`[duplicate — first seen earlier]`). Catches CLAUDE.md re-injection, repeated file reads, etc.
3. **Strip signatures** — remove model signature blocks from tool results that echo assistant output (6.1% of session size).
4. **Summarise where possible** — for Read results >16KB, extract just the requested line range ± context instead of passing the full output.

### Implementation

New module: `packages/agent-backend/src/claude-code/context-filter.ts`

```typescript
export interface ContextFilterConfig {
  enabled: boolean
  trimThresholdBytes: number    // default 8192
  trimMaxLines: number          // default 100
  dedupMinBytes: number         // default 1024
  stripSignatures: boolean      // default true
}

export function createContextFilter(config: ContextFilterConfig) {
  const seenHashes = new Map<string, number>()  // hash → first-seen turn

  return {
    /** Apply to a tool result; returns the (possibly trimmed) output. */
    filterToolOutput(toolName: string, output: unknown): unknown { ... },

    /** Reset dedup state (call on session recycle). */
    reset() { seenHashes.clear() }
  }
}
```

Hook wiring change in `onPostToolUse`:

```typescript
const onPostToolUse = async (input: HookInput) => {
  if (input.hook_event_name !== 'PostToolUse') return { continue: true }
  const state = stateForHook(input)
  if (!state?.contextFilter) return { continue: true }
  const inp = input as any
  const filtered = state.contextFilter.filterToolOutput(inp.tool_name, inp.tool_response)
  if (filtered === inp.tool_response) return { continue: true }
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse' as const,
      updatedToolOutput: filtered
    }
  }
}
```

### What Cozempic Strategies This Replaces

| Cozempic strategy     | Expected savings | Live equivalent          |
| --------------------- | ---------------- | ------------------------ |
| tool-output-trim      | 1-8%             | Trim large outputs       |
| document-dedup        | 0-44%            | Content block dedup      |
| tool-use-result-strip | 5-50%            | N/A (SDK internal field) |
| metadata-strip        | 1-3%             | Signature strip          |

### What It Does NOT Replace

These strategies need whole-history context and cannot run per-event:

| Strategy                 | Expected savings | Why not real-time                   |
| ------------------------ | ---------------- | ----------------------------------- |
| tool-result-age          | 10-40%           | Age = relative to total turns       |
| compact-summary-collapse | 85-95%           | Deletes already-written span        |
| stale-reads              | 0.5-2%           | Needs future-knowledge (later edit) |

These belong in Layer 2 (session recycle).

---

## Layer 2: Reclaim — Session Recycle

### Concept

When accumulated context approaches the compaction threshold, Sovereign proactively recycles the session: gracefully interrupt the SDK Query, run batch pruning on the JSONL transcript, then resume with the pruned file. The SDK reads the smaller transcript and continues with reduced context.

This does exactly what Cozempic's guard tries to do (terminate → prune → restart), but through the SDK's own lifecycle instead of process signals.

### SDK Surface

- `Query.getContextUsage()` → `SDKControlGetContextUsageResponse` — rich per-category breakdown, `totalTokens`, `maxTokens`, `autoCompactThreshold`, `messageBreakdown.toolResultTokens`
- `Query.interrupt()` — graceful stop (session stays resumable)
- `query({ ..., options: { resume: sessionId } })` — resume from JSONL
- Resume orchestrator (`resume.ts`) already handles this path at boot

### Flow

```
1. After each assistant turn, poll getContextUsage()
2. If totalTokens > recycleThreshold (default: 55% of maxTokens):
   a. Emit 'session.recycling' event (UI shows spinner)
   b. Call liveQuery.interrupt()
   c. Wait for Query iterator to complete
   d. Run pruning on the JSONL:
      - Option A: shell out to `cozempic treat <session> -rx standard --execute`
      - Option B: native TS pruning (see below)
   e. Create new Query with resume: backendSessionId
   f. Emit 'session.recycled' with token delta
   g. Reset Layer 1 dedup state
```

### Pruning: Subprocess vs Native

**Subprocess (recommended for v1):**

Shell out to `cozempic treat`. Advantages:

- All 18 strategies, battle-tested safety (floor enforcement, validation, parent-chain relinking, fallback ladder)
- Zero reimplementation cost
- Cozempic's incident-driven safety fixes (issues #106, #122, #147) come free

```typescript
import { execFile } from 'child_process'

async function pruneTranscript(
  sessionId: string,
  rx: string = 'standard'
): Promise<{
  savedBytes: number
  savedTokens: number
}> {
  const result = await execFileAsync('cozempic', ['treat', sessionId, '-rx', rx, '--execute', '--json'])
  return JSON.parse(result.stdout)
}
```

Cost: ~2-5s for a 100MB session. Acceptable for a recycle that runs once per ~30 minutes of heavy usage.

**Native (future optimisation):**

Port the three highest-value batch strategies to TypeScript:

- `compact-summary-collapse` (85-95%) — find last compact_boundary, remove everything before it. ~50 lines of logic.
- `tool-result-age` (10-40%) — compute turn ages, stub old results. ~100 lines.
- `stale-reads` (0.5-2%) — track file read/edit pairs, stub superseded reads. ~60 lines.

The core logic of each strategy runs as a pure function on parsed messages. The hard part — safety validation, parent-chain relinking, floor enforcement — lives in Cozempic's executor. Either port that too (~200 lines) or accept the subprocess path.

### Threshold Tuning

```typescript
interface RecycleConfig {
  enabled: boolean
  thresholdPercent: number // default 55 (recycle before SDK's ~80% auto-compact)
  minIntervalMs: number // default 300_000 (no more than once per 5 min)
  prescription: string // default 'standard'
  skipDuringSubagents: boolean // default true (don't recycle mid-subagent)
}
```

The threshold should sit well below the SDK's auto-compact threshold (~80%) so Sovereign's surgical pruning runs before the SDK's blunt summarisation. The gap between 55% and 80% gives ~25% headroom before auto-compact triggers.

### Comparison: Recycle vs Auto-Compact

| Aspect            | Session Recycle                    | SDK Auto-Compact          |
| ----------------- | ---------------------------------- | ------------------------- |
| Trigger           | 55% of context                     | ~80% of context           |
| Method            | Remove low-value messages          | Summarise everything      |
| Information loss  | Minimal (stale results only)       | Significant (summary)     |
| Latency           | 2-5s (prune + resume)              | 5-15s (LLM summary)       |
| Frequency         | Less often (pruning buys headroom) | More often                |
| Cumulative effect | Each recycle buys ~30-40% headroom | Each compact loses detail |

---

## Layer 3: Clean — Between-Session Pruning

### SessionStore Adapter (alpha SDK API)

The SDK supports a custom `SessionStore` passed via `Options.sessionStore`. On resume, the SDK calls `SessionStore.load(key)` — this returns the materialised transcript entries. A pruning adapter could filter entries before they re-enter context.

```typescript
class PrunedSessionStore implements SessionStore {
  constructor(
    private delegate: SessionStore, // or the default disk store
    private pruneConfig: PruneConfig
  ) {}

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const entries = await this.delegate.load(key)
    if (!entries) return null
    return this.prune(entries)
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    return this.delegate.append(key, entries)
  }

  // ... other SessionStore methods delegate through
}
```

**Status:** Alpha API — types exist in SDK 0.3.220 but the semantics may change. Worth prototyping once the API stabilises, but not a v1 dependency.

### Automated Disk Cleanup

A cron job that runs `cozempic treat` on sessions exceeding a size threshold:

```json
{
  "threadKey": "main",
  "when": { "kind": "cron", "expr": "0 4 * * *", "tz": "Australia/Melbourne" },
  "prompt": "Run cozempic treat on all sessions over 50MB.",
  "label": "session-cleanup"
}
```

Or a native implementation in Sovereign's scheduler that calls cozempic as a subprocess — no agent turn needed.

---

## Implementation Order

### Phase 1: PostToolUse Interception (Layer 1)

Highest value, lowest risk. The hook already exists as a no-op.

1. Create `context-filter.ts` with trim + dedup logic
2. Wire into `onPostToolUse` hook
3. Add `contextManagement.filter` config section
4. Test: verify large tool results get trimmed before context entry

Expected impact: **20-40% reduction** in per-turn context growth from tool results (40.5% of session content × 50-95% trim rate on large outputs).

### Phase 2: Context Monitoring (Layer 2 prep)

Wire `getContextUsage()` into Sovereign's event loop.

1. Poll after each assistant turn (or on a timer)
2. Emit `context.usage` events with the category breakdown
3. Surface in the UI (context bar already exists, feed it real data)
4. Log threshold crossings

### Phase 3: Session Recycle (Layer 2)

The session restart mechanism.

1. Implement `recycleSession()` — interrupt → prune → resume
2. Wire threshold trigger from Phase 2
3. Add `contextManagement.recycle` config section
4. Test: verify token count drops after recycle, conversation continues

### Phase 4: Automated Cleanup (Layer 3)

Scheduled maintenance.

1. Sovereign-native cleanup task (no agent turn, just subprocess)
2. Or cron-driven `cozempic treat` on oversized sessions
3. SessionStore adapter when the alpha API stabilises

---

## Config Shape

```json
{
  "contextManagement": {
    "filter": {
      "enabled": true,
      "trimThresholdBytes": 8192,
      "trimMaxLines": 100,
      "dedupMinBytes": 1024,
      "stripSignatures": true
    },
    "recycle": {
      "enabled": true,
      "thresholdPercent": 55,
      "minIntervalMs": 300000,
      "prescription": "standard",
      "skipDuringSubagents": true
    },
    "cleanup": {
      "enabled": true,
      "maxSessionSizeMB": 50,
      "schedule": "0 4 * * *"
    }
  }
}
```

---

## What This Replaces

| Cozempic Feature        | Status Today          | Sovereign Replacement                                |
| ----------------------- | --------------------- | ---------------------------------------------------- |
| Guard daemon            | Broken (SDK mismatch) | Layer 2: Session Recycle                             |
| Pruning strategies      | Manual only           | Layer 1 (real-time) + Layer 2 (batch via subprocess) |
| Digest inject/flush     | Working               | Keep as-is (hooks still fire)                        |
| Checkpoint/post-compact | Working               | Keep as-is                                           |
| Doctor diagnostics      | Working               | Keep as-is (manual tool)                             |
| Disk cleanup            | Manual                | Layer 3: Automated Cleanup                           |

Cozempic remains installed for:

- Digest (behavioral rule extraction) — genuinely useful, no replacement needed
- Checkpoint/post-compact (state recovery) — works through hooks
- `cozempic treat` subprocess — Layer 2 shells out to it for batch pruning
- `cozempic doctor` — manual diagnostics

The guard daemon auto-spawn gets disabled (Sovereign handles monitoring and recycling natively). The `remind` and `nudge` hooks become unnecessary once Sovereign manages its own context thresholds.

---

## Open Questions

1. **PostToolUse output shape** — `updatedToolOutput` accepts `unknown`. Need to verify whether the SDK expects the same shape as the original `tool_response` (string? structured content array?) or accepts any serialisable value. A quick test with a trimmed string output would confirm.

2. **Recycle during subagents** — interrupting a parent session while subagents run would strand them. Default: skip recycle when `liveSubagents.size > 0`. Alternative: interrupt subagents first, then recycle parent, then re-spawn subagents (complex, deferred).

3. **SessionStore stability** — the alpha API covers our exact use case (prune on load). Monitor SDK releases for stabilisation.

4. **Cozempic `--json` output** — need to verify cozempic supports a `--json` flag for structured output from `treat`. If not, parse the human-readable output or add a small wrapper.
