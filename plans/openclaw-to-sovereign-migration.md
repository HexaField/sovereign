# Migrating `~/.openclaw/` → `~/.sovereign/`

**Status:** Automated **Date:** 2026-06-01 (revised)

End-to-end procedure to **copy** all live state from `~/.openclaw/workspace/` to a new `~/.sovereign/` home. OpenClaw's directory is never modified or deleted — the operation is purely additive, so backtracking is just "stop the new Sovereign, restore the launchd plist, start the old one".

## TL;DR — automated path

```sh
sovereign migrate
```

…runs all the steps below in order, with backups, validation, and dry-run output. See [bin/sovereign-migrate.sh](../bin/sovereign-migrate.sh) for the implementation; the rest of this document is the manual procedure (kept for reference, debugging, and partial recovery).

The automated migration:

- **Copies** (never moves) from `~/.openclaw/workspace/` so the original stays intact.
- Backs up `~/.claude/CLAUDE.md` and the launchd plist before touching them.
- Rewrites every absolute path inside the copied data files.
- Copies + renames the Claude Code JSONL transcript directory.
- Updates the launchd plist's `SOVEREIGN_DATA_DIR`.
- Seeds `~/.sovereign/personality-order.json` with a default order if absent.
- Restarts Sovereign and verifies health.

After migration, the personality compiler (now part of the server) watches `~/.sovereign/*.md` and recompiles `~/.claude/CLAUDE.md` whenever a source file changes — no manual `cat` step ever again.

## What this revision changes

- **`cp` not `mv`.** OpenClaw configs stay untouched at `~/.openclaw/`. Rollback is reverting the plist + stopping Sovereign; the old data is still there if you ever want to point a service back at it.
- **Personality assembly is source-files-in / `CLAUDE.md`-out.** The OpenClaw-style sources (`IDENTITY.md`, `SOUL.md`, `MEMORY.md`, …) stay as separate editable files in `~/.sovereign/`. The compiler concatenates them into the user-global `~/.claude/CLAUDE.md`, which the SDK reads for every Claude Code session regardless of cwd. **`CLAUDE.md` is never an OpenClaw source file** — it's the compiled output target. The existing `~/.sovereign/CLAUDE.md` (your current hand-written approximation) is quarantined to a `.pre-migration.bak` during migration so the SDK's cwd walk-up doesn't read it alongside the compiled output and double the personality content.
- **Compilation is automatic.** The Sovereign server runs a watcher on the source `.md` files and rewrites `~/.claude/CLAUDE.md` on every change. No more manual concat, no more stale assemblies.
- **The workspace stays version-controlled.** Your existing `~/.openclaw/workspace/.git` is copied as-is; the new `~/.sovereign/` is the same git repo (you may want to `git remote rename` or push to a new repo to match the rename).

## Why now

OpenClaw the adapter is gone (see commit history around 2026-05-30). The `~/.openclaw/workspace/` path is the last place the name persists — and it persists in several layered ways:

- **Data dir.** `SOVEREIGN_DATA_DIR=~/.openclaw/workspace/.sovereign-data` (set in launchd plist) — 414 MB of registry/queues/scheduler/JSONL state.
- **Working directory.** Every Claude Code session has `cwd: "/Users/josh/.openclaw/workspace"` recorded in its registry entry and per-session state file (16 JSON files reference the path).
- **Claude Code transcripts.** The SDK encodes cwd into a directory name: `~/.claude/projects/-Users-josh--openclaw-workspace/` (77 MB of JSONL).
- **Workspace files.** `CLAUDE.md`, `MEMORY.md`, `AGENTS.md`, `IDENTITY.md`, `SOUL.md`, the `.git/` checkout, `.ad4m/`, `.learnings/`, `.state/` — all live at `~/.openclaw/workspace/`.
- **Server drift-guard** in [packages/server/src/index.ts:34-46](../packages/server/src/index.ts#L34-L46) explicitly hardcodes the legacy path.

A simple `mv` is insufficient because the in-data-dir JSON files carry absolute paths that won't update themselves, and Claude Code's project-dir encoding is derived from cwd at write time (existing transcripts would orphan).

## Target layout

```
~/.sovereign/              ← workspace cwd (CLAUDE.md, MEMORY.md, etc.)
├── .git/                  ← unchanged
├── .ad4m/                 ← unchanged
├── .learnings/            ← unchanged
├── .state/                ← unchanged
├── .vscode/               ← unchanged
├── AGENTS.md
├── CLAUDE.md
├── MEMORY.md
├── SOUL.md
├── IDENTITY.md
├── HEARTBEAT.md
├── agents/                ← unchanged
└── data/                  ← was `.sovereign-data` — renamed (the `.` prefix
                              was hiding it as a sibling of `.openclaw`; that
                              concern is gone, so flatten the name)

~/.claude/projects/
└── -Users-josh-sovereign/ ← was `-Users-josh--openclaw-workspace/`
                              (SDK-encoded cwd: `/.` → `--`, `/` → `-`,
                              so `/Users/josh/.sovereign` → `-Users-josh--sovereign`)
```

> **Encoding note.** Re-read [path-encoding.ts](../packages/agent-backend/src/claude-code/path-encoding.ts) to confirm — every `/` AND `.` becomes `-`. `/Users/josh/.sovereign` → `-Users-josh--sovereign` (the leading dot in `.sovereign` produces a double dash). Verify against an existing project dir before relying on this.

## Pre-flight

```sh
# 1. Confirm sovereign is running and there's no in-flight work you can't survive losing.
sovereign status
curl -s http://127.0.0.1:5801/api/system/agents/active | jq .

# 2. Confirm where things are.
ls -la ~/.openclaw/workspace/
ls -la ~/.openclaw/workspace/.sovereign-data/
ls ~/.claude/projects/ | grep openclaw
launchctl print "gui/$(id -u)/com.sovereign.server" | grep SOVEREIGN_DATA_DIR
```

You should see:

- `SOVEREIGN_DATA_DIR = /Users/josh/.openclaw/workspace/.sovereign-data` in the plist.
- A populated `.sovereign-data/` (`agent-backend/`, `chat/`, `scheduler/`, etc.).
- `~/.claude/projects/-Users-josh--openclaw-workspace/` with sized JSONLs.

If any of those look wrong, stop and re-audit before proceeding.

## The migration

### Step 1 — Stop Sovereign

```sh
sovereign stop
# Wait until launchctl confirms it's gone.
launchctl list | grep sovereign  # should print nothing
```

### Step 2 — Back up the things we'll overwrite

Most of the migration is additive (cp-based) so the originals don't need protecting. The two exceptions are the launchd plist (overwritten in Step 7) and the user-level `~/.claude/CLAUDE.md` (overwritten by the compiler on first boot).

```sh
mkdir -p ~/sovereign-migration-backup-$(date +%Y%m%d)
BACKUP=~/sovereign-migration-backup-$(date +%Y%m%d)
cp ~/Library/LaunchAgents/com.sovereign.server.plist "$BACKUP/plist.original"
[ -f ~/.claude/CLAUDE.md ] && cp ~/.claude/CLAUDE.md "$BACKUP/claude-CLAUDE.md.original"
echo "Backup at $BACKUP — needed only for rollback (Steps 7 + the personality compiler)."
```

The OpenClaw directory and the Claude Code JSONL tree are **never modified**, so they don't need backing up. They stay as live read-only references at their original paths.

### Step 3 — Copy the workspace

```sh
# Copy (not move) the whole workspace tree. The original at ~/.openclaw/ is
# never touched; if you ever need to roll back, point a service at it again.
cp -R ~/.openclaw/workspace ~/.sovereign

# Rename the data dir inside the copy for cleanliness — `.sovereign-data`
# only made sense when it lived under `.openclaw`. Internal-only, no on-disk
# references need updating (paths are stored as absolute strings).
mv ~/.sovereign/.sovereign-data ~/.sovereign/data
```

Anything else under `~/.openclaw/` (legacy `agents/`, `cron/`, `devices/`, `flows/`, `identity/`, `memory/`, `openclaw.json`, heartbeat lockfiles) is OpenClaw's own state — Sovereign doesn't read any of it. **Leave it alone.** Deleting is irreversible and pointless once the migration is verified working; if disk pressure becomes a concern, prune it weeks later as a separate hygiene pass.

### Step 4 — Quarantine the legacy CLAUDE.md, seed the order manifest

Critical distinction:

- **OpenClaw's per-concern source files** — `IDENTITY.md`, `SOUL.md`, `MEMORY.md`, `HEARTBEAT.md`, `AGENTS.md`, `TOOLS.md`, `USER.md`, `WORKFLOW_AUTO.md`, etc. These are the _inputs_ to the personality assembly. Each is an independently editable artifact.
- **`CLAUDE.md`** — the _output_ file Claude Code reads. Both Claude Code's user-global `~/.claude/CLAUDE.md` and any workspace-cwd-local `<cwd>/CLAUDE.md` are read by the SDK at session start. `CLAUDE.md` is **never an OpenClaw source file** — it's what the assembly compiles _into_.

Your existing `~/.openclaw/workspace/CLAUDE.md` (now copied to `~/.sovereign/CLAUDE.md`) is your current hand-written approximation of the assembled output — a stale single-file compile, not a source. Leaving it in `~/.sovereign/` is harmful: the SDK's cwd walk-up reads it, and the user-global `~/.claude/CLAUDE.md` is also read, so the personality content doubles.

#### 4a. Quarantine the legacy workspace CLAUDE.md

```sh
mv ~/.sovereign/CLAUDE.md ~/.sovereign/CLAUDE.md.pre-migration.bak
```

(The `sovereign migrate` script does this automatically and warns if there's already a `.pre-migration.bak` in place.)

The renamed file stays available for reference (you may want to extract sections of it into the appropriate source files — anything not already captured in `IDENTITY.md` / `SOUL.md` / etc.). Claude Code won't read `*.bak`.

#### 4b. Seed `~/.sovereign/personality-order.json`

The compiler watches a manifest file that names the source files in OpenClaw's exact assembly order:

```sh
cat > ~/.sovereign/personality-order.json <<'EOF'
{
  "_comment": "Source file order for the personality compiler. NEVER list CLAUDE.md — that's the compiled output target.",
  "files": [
    "IDENTITY.md",
    "SOUL.md",
    "AGENTS.md",
    "TOOLS.md",
    "MEMORY.md",
    "USER.md",
    "WORKFLOW_AUTO.md",
    "HEARTBEAT.md"
  ],
  "separator": "\n\n---\n\n"
}
EOF
```

> **Verify the order against OpenClaw's actual assembly** before relying on it. Sources to check: OpenClaw's prompt-builder script (commonly `system_prompt.py` / `prompt_builder.py`), `~/.openclaw/openclaw.json` if it lists files, or a captured system prompt from a recent OpenClaw session. The order above is a sensible default (foundation → behaviour → context → operational) but **only authoritative if OpenClaw used it**.

You don't need to write the assembled output yourself — on the next `sovereign start`, the personality compiler:

1. Reads each listed file from `~/.sovereign/`.
2. Concatenates them in order with the configured separator.
3. Writes the result into a fenced block inside `~/.claude/CLAUDE.md`.
4. `fs.watch`es the source dir; every subsequent save to any listed `.md` or to the manifest itself triggers a debounced recompile.

#### 4c. Compiler safeguards (good to know)

- The compiler refuses to include `CLAUDE.md` even if you accidentally add it to the manifest — it logs a `WARNING: ... refusing to include` and skips it.
- It also logs `WARNING: ... doubling the personality content` on every boot/recompile if `~/.sovereign/CLAUDE.md` exists (because the SDK's cwd walk-up would read it alongside the compiled output). The quarantine in 4a prevents this; the warning catches accidental re-creation.
- If the manifest is missing entirely, the compiler falls back to lexicographic order of every `*.md` in `~/.sovereign/` _except_ `CLAUDE.md`. Usable, but not OpenClaw-fidelity.

### Step 5 — Rewrite paths inside the data files

There are 16 JSON files referencing `/Users/josh/.openclaw/workspace`. They need rewriting to `/Users/josh/.sovereign`.

```sh
NEW=~/.sovereign/data

# Targets, derived from `find ... grep -l openclaw`:
TARGETS=$(grep -rl "openclaw" "$NEW" --include="*.json" 2>/dev/null)
echo "$TARGETS"     # confirm the list looks right
```

Then rewrite. Use `sed -i ''` (BSD/macOS form):

```sh
for f in $TARGETS; do
  echo "patching $f"
  sed -i '' 's|/Users/josh/\.openclaw/workspace|/Users/josh/.sovereign|g' "$f"
done

# Verify zero references remain.
grep -rl "openclaw" "$NEW" 2>/dev/null
# Expected: no output.
```

Files this will touch:

- `data/config.json` — `workspace.root`, `workspace.globalPath`, `agentBackend.claudeCode.cwd`
- `data/secrets.json` — (whatever's there)
- `data/orgs/orgs.json` — `_global` org's `path`
- `data/agent-backend/sessions.json` — every session's `cwd` + `backendSessionFile`
- `data/agent-backend/claude-code-state/*.json` — per-session `cwd` + `sessionFile`
- `data/agent-backend/active-sessions.json` — `cwd` + `backendSessionFile` per entry
- `data/chat/live-state/*.json` — any cwd-bearing work items
- `data/scheduler/jobs.json` — cwd-bearing payloads

Also strip the dead `agentBackend.openclaw` block from config.json (the new schema rejects it with `additionalProperties: false`):

```sh
python3 -c "
import json
p = '$NEW/config.json'
c = json.load(open(p))
c.get('agentBackend', {}).pop('openclaw', None)
json.dump(c, open(p, 'w'), indent=2)
print('config.json cleaned')
"

# Same for secrets — strip openclawGatewayToken.
python3 -c "
import json
p = '$NEW/secrets.json'
try:
  c = json.load(open(p))
  if c.pop('openclawGatewayToken', None) is not None:
    json.dump(c, open(p, 'w'), indent=2)
    print('secrets.json cleaned')
except FileNotFoundError:
  pass
"
```

### Step 6 — Copy Claude Code transcripts

```sh
# The SDK derives the project-dir name from cwd. Old cwd → old dir name.
OLD_DIR=~/.claude/projects/-Users-josh--openclaw-workspace
NEW_DIR=~/.claude/projects/-Users-josh--sovereign

[ -d "$OLD_DIR" ] || { echo "ERROR: $OLD_DIR not found"; exit 1; }
[ -e "$NEW_DIR" ] && { echo "ERROR: $NEW_DIR already exists — refusing to clobber"; exit 1; }

# Copy (not move) so the old transcripts remain readable by any tool that
# still expects them at the old path.
cp -R "$OLD_DIR" "$NEW_DIR"

# The orphan `-Users-josh--openclaw` directory (from when the cwd was
# `~/.openclaw` rather than `~/.openclaw/workspace`) is OpenClaw-era residue.
# Leave it in place — the no-touch principle applies. Trash later as hygiene.
```

> **Verify the encoded name** before running. On your machine:
>
> ```sh
> node -e "console.log('/Users/josh/.sovereign'.replace(/[\\/.]/g, '-'))"
> # Should print: -Users-josh--sovereign
> ```
>
> If the SDK ever changes its encoding, the path-encoding.ts test [packages/agent-backend/src/claude-code/path-encoding.test.ts](../packages/agent-backend/src/claude-code/path-encoding.test.ts) catches it.

### Step 7 — Update the launchd plist

```sh
PLIST=~/Library/LaunchAgents/com.sovereign.server.plist
# Two values to change:
#   SOVEREIGN_DATA_DIR  → ~/.sovereign/data
#   working directory   → ~/.sovereign   (if set; some plists omit this)

sed -i '' \
  -e 's|/Users/josh/\.openclaw/workspace/\.sovereign-data|/Users/josh/.sovereign/data|g' \
  -e 's|/Users/josh/\.openclaw/workspace|/Users/josh/.sovereign|g' \
  "$PLIST"

grep -E "openclaw|sovereign" "$PLIST"   # sanity check — only sovereign refs should remain
```

### Step 8 — Restart and verify

```sh
sovereign start

# Wait for health.
until curl -sf http://127.0.0.1:5801/health > /dev/null; do sleep 1; done

# Check threads load and point at the new cwd.
curl -s http://127.0.0.1:5801/api/threads | jq '.threads[] | {key, lastActivity}' | head

# Check sessions registry survived.
cat ~/.sovereign/data/agent-backend/sessions.json | jq '. | length'
# Should match the count from before migration.

# Verify Claude Code can resume a session — pick a thread and ping it from the UI.
open https://localhost:5801/
```

### Step 9 — Confirm and (optionally) prune

After 24–48 hours of normal use without surprises:

```sh
# Drop the small backup directory (just plist + claude/CLAUDE.md).
trash ~/sovereign-migration-backup-*
```

You may also prune the OpenClaw originals once you're confident you won't roll back:

```sh
# Optional, low-priority — costs ~414 MB to keep around.
trash ~/.openclaw                                           # the workspace + OpenClaw runtime state
trash ~/.claude/projects/-Users-josh--openclaw-workspace    # the legacy JSONL tree
trash ~/.claude/projects/-Users-josh--openclaw              # earlier-cwd JSONL orphan
```

Or just leave them indefinitely — disk is cheap and they're inert as long as nothing's pointed at them.

## Rollback (if something breaks)

Because the migration is purely additive (everything was copied, nothing moved), rollback is just restoring the launchd plist and starting the old configuration:

```sh
sovereign stop                  # stop the new Sovereign
cp ~/sovereign-migration-backup-*/plist.original \
   ~/Library/LaunchAgents/com.sovereign.server.plist
cp ~/sovereign-migration-backup-*/claude-CLAUDE.md.original \
   ~/.claude/CLAUDE.md          # restore the hand-curated user-level file
sovereign start                 # boots against ~/.openclaw/workspace/.sovereign-data
```

Optionally clean up the new tree:

```sh
trash ~/.sovereign
trash ~/.claude/projects/-Users-josh--sovereign
```

…but you don't have to. The new tree is inert if nothing points at it. Leave it if you might re-attempt the migration later.

---

## Follow-up code cleanups (after migration is confirmed stable)

These are one-line-or-so changes that become safe once `~/.openclaw/` is gone.

### 1. Drop the legacy-path drift-guard

[packages/server/src/index.ts:34-46](../packages/server/src/index.ts#L34-L46) currently hardcodes `~/.openclaw/workspace/.sovereign-data` as a known sibling path. Once the old location is empty/deleted the guard's only purpose was to catch _that_ specific migration footgun. Delete the entire block, or replace with a generic "warn if a sibling data dir is more recently modified than the active one" check.

### 2. Bump the CLI's default data dir

[bin/sovereign](../bin/sovereign) currently defaults `DATA_DIR` to `$REPO_DIR/packages/server/.data` when `SOVEREIGN_DATA_DIR` is unset:

```sh
DATA_DIR="${SOVEREIGN_DATA_DIR:-$REPO_DIR/packages/server/.data}"
```

For a single-user install where the canonical data lives at `~/.sovereign/data`, change the default to:

```sh
DATA_DIR="${SOVEREIGN_DATA_DIR:-$HOME/.sovereign/data}"
```

This makes `sovereign status` / `sovereign logs` work without an env var.

### 3. Default `workspace.root` + `claudeCode.cwd` in config

[packages/config/src/defaults.ts:29,38](../packages/config/src/defaults.ts#L29) currently picks `~/workspaces` for `workspace.root` and `''` for `claudeCode.cwd`. With the migration, `~/.sovereign` is now both:

```ts
workspace: {
  root: home ? path.join(home, '.sovereign') : '',
  globalPath: ''
},
agentBackend: {
  enabled: ['claude-code'],
  default: 'claude-code',
  claudeCode: {
    cwd: home ? path.join(home, '.sovereign') : '',
    ...
  }
}
```

Existing config.json overrides win; this only affects fresh installs.

### 4. Rename the data subdirectory in code

If you also rename the on-disk directory `.sovereign-data` → `data` (step 3 above), the convention is purely path-based — nothing in code names the subdirectory; everywhere it's derived from `SOVEREIGN_DATA_DIR`. No code change needed. But the launchd plist template at [support/com.sovereign.server.plist](../support/com.sovereign.server.plist) hardcodes the path — update its placeholder so fresh installs land in the right place.

### 5. Drop `'pi'` from `AgentBackendKind`

[packages/core/src/agent-backend.ts:29](../packages/core/src/agent-backend.ts#L29) currently has:

```ts
export type AgentBackendKind = 'pi' | 'claude-code'
```

There's no `pi` adapter in the tree. If Pi is genuinely never coming back, narrow to:

```ts
export type AgentBackendKind = 'claude-code'
```

That collapses `factory.ts`'s `ALL_KINDS` to a single-element array, makes `Partial<Record<AgentBackendKind, ...>>` factories into a required record, simplifies `statusAll()`, and removes the "default is misconfigured" runtime check (only one kind possible). Roughly 30 lines of conditional logic vanish.

If Pi is still planned, leave it.

### 6. Collapse the `agentBackend` config section

With only `claude-code` ever an option (and the schema enforcing it via single-element enums), the `enabled[]` + `default` keys become noise:

```ts
agentBackend: {
  enabled: ['claude-code'],    // never anything else
  default: 'claude-code',      // never anything else
  claudeCode: { ... }
}
```

Could collapse to:

```ts
claudeCode: {
  ;(cwd, agentDir, defaultModel, modelContextWindows)
}
```

This is a real config schema break — anyone with a custom config.json would need to migrate. Worth doing in the same pass as #5 if you commit to single-backend, or skip if you want the door open for another adapter.

### 7. Remove the legacy OpenClaw runtime-context filter in `MessageBubble.tsx`

[packages/client/src/features/chat/MessageBubble.tsx:332](../packages/client/src/features/chat/MessageBubble.tsx#L332) still matches `/^OpenClaw runtime context \(internal\):/i` for hiding system-internal turns from old transcripts. Once the JSONLs you care about no longer contain that string (you can grep the transcripts to check), drop the regex. Until then, leave it — it costs nothing and keeps historical transcripts rendering cleanly.

```sh
# Are there any historical transcripts that still need this filter?
grep -l "OpenClaw runtime context" ~/.claude/projects/-Users-josh--sovereign/*.jsonl | wc -l
# If 0, you can remove the regex.
```

### 8. Audit the `~/.openclaw/workspace/.openclaw/` orphan

Inside the _workspace itself_ there used to be a nested `.openclaw/` directory (visible in pre-migration `ls -la`). It contained per-workspace OpenClaw runtime cruft. After the workspace moves to `~/.sovereign/`, that nested `.openclaw/` is still there. Inspect; if nothing reads it, delete:

```sh
ls -la ~/.sovereign/.openclaw 2>/dev/null
# If contents are just legacy state files (no current consumer in `pnpm grep`):
trash ~/.sovereign/.openclaw
```

### 9. Audit the `.sovereign-data-worktree-test` directory

The pre-migration `ls -la` showed `.sovereign-data-worktree-test/` alongside `.sovereign-data/`. After migration it's at `~/.sovereign/.sovereign-data-worktree-test/`. Looks like a one-off test artifact. Delete unless you remember why it's there:

```sh
ls -la ~/.sovereign/.sovereign-data-worktree-test
trash ~/.sovereign/.sovereign-data-worktree-test
```

### 10. Update `bin/sovereign-launchd.sh`

If the launchd shim script references `SOVEREIGN_DATA_DIR` or the workspace path explicitly, update it. Most likely it just reads the env var the plist injects, in which case no change is needed.

```sh
grep -E "openclaw|sovereign-data" /Users/josh/workspaces/hexafield/sovereign/bin/sovereign-launchd.sh
```

### 11. README / setup docs

If any README or setup guide mentions `~/.openclaw/workspace`, update to `~/.sovereign`. Likely candidates: top-level `README.md`, anything under `docs/`. (Grep first; only update what exists.)

```sh
grep -rln "\.openclaw" /Users/josh/workspaces/hexafield/sovereign --include="*.md" | grep -v plans/
```

### 12. (Optional) Move data dir out of the workspace entirely

The current arrangement nests runtime state inside the workspace cwd (`~/.sovereign/data/`). That's convenient for backup but mixes "workspace where Claude does work" with "Sovereign's internal data". A more conventional macOS layout would separate them:

- `~/.sovereign/` — workspace cwd (read/written by Claude)
- `~/Library/Application Support/Sovereign/` — Sovereign data dir

Trade-off: harder to back up the whole thing as one tree, plays better with Time Machine selection rules. Not part of this migration — flagging as a possible future step.

### 13. Retire the generic `PERSONALITY_BODY` seed

Step 4 above replaces the seeded `CLAUDE.md` with a 1:1 OpenClaw-order assembly. Once that's in place and verified, `ensurePersonalityFile` in [packages/agent-backend/src/claude-code/personality.ts](../packages/agent-backend/src/claude-code/personality.ts) is a footgun for _your_ install — if you ever rename or delete `CLAUDE.md` while the adapter is running, the seed will write a generic body that silently weakens your prompt.

Three options, pick one:

1. **Delete the seed entirely.** If every install of this Sovereign has a hand-curated personality, the seed is dead weight. Drop `ensurePersonalityFile` and its call sites in [claude-code.ts](../packages/agent-backend/src/claude-code/claude-code.ts).
2. **Gate the seed on an env var** (`SOVEREIGN_SEED_PERSONALITY=true`). Off by default; only opt-in installs (e.g. fresh demo deployments) get the seeded body.
3. **Make the seed itself write the assembly file** — generate a `CLAUDE.md` that contains the `@`-import directives for whichever `.md` files exist in the cwd. Adapts to whatever personality files are present, never overwrites user content beyond the file being missing.

Option 3 is the most aligned with the new 1:1 model. Option 1 is the simplest if this Sovereign is genuinely single-user.

## Verification checklist

After step 8, before deleting the backup:

- [ ] `sovereign status` reports healthy.
- [ ] `/api/threads` returns the same thread count as pre-migration.
- [ ] `/api/system/agents/active` returns sensibly (probably empty if nothing was mid-turn).
- [ ] Opening a thread in the UI loads its history — confirms JSONL relocation worked.
- [ ] Sending a message to a thread succeeds and the agent responds — confirms SDK can find/write to the new JSONL location.
- [ ] Cron jobs still fire on schedule (wait for the next hourly tick on a known cron-driven thread like `neural-nets`).
- [ ] AD4M integration still connects (if `ad4m.host` is configured).
- [ ] No `[data-dir] WARNING` lines in `~/.sovereign/data/sovereign.log` on startup.
- [ ] **Personality verification** — start a fresh thread, ask the agent: _"What sections compose your personality? Cite three distinct lines from three different source files."_ If the agent can name content from `IDENTITY.md`, `SOUL.md`, and (say) `MEMORY.md`, the assembly is working. If it only knows the body of one file, the `@`-imports aren't being expanded — fall back to step 4e (manual concatenation).
