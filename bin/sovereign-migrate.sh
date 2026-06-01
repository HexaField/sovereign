#!/usr/bin/env bash
#
# sovereign migrate — automated OpenClaw → Sovereign migration.
#
# Purely additive:
#   - COPIES (never moves) from ~/.openclaw/workspace/ to ~/.sovereign/
#   - COPIES the Claude Code JSONL tree to its new encoded-cwd path
#   - REWRITES absolute paths inside the copied data files
#   - HOISTS user-edited config.json out of data/ into ~/.sovereign/ so it can
#     be version-controlled (secrets.json + history stay in data/)
#   - REINSTALLS the launchd plist with SOVEREIGN_CONFIG_DIR + SOVEREIGN_DATA_DIR
#   - SEEDS config.personality (the assembly order for ~/.claude/CLAUDE.md)
#     and folds any legacy ~/.sovereign/personality-order.json into it
#
# Originals at ~/.openclaw/ stay intact. Rollback = restore the plist.
#
# Usage:
#   sovereign migrate                # interactive — prompts before destructive bits
#   sovereign migrate --dry-run      # print what would happen; no changes
#   sovereign migrate --yes          # non-interactive (assume yes to all prompts)
#
set -euo pipefail

DRY_RUN=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y)  ASSUME_YES=1 ;;
    --help|-h) sed -n '2,18p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

# ── Source + target paths ───────────────────────────────────────────────
OLD_WORKSPACE="$HOME/.openclaw/workspace"
OLD_DATA="$OLD_WORKSPACE/.sovereign-data"
NEW_WORKSPACE="$HOME/.sovereign"
NEW_CONFIG="$NEW_WORKSPACE"
NEW_DATA="$NEW_WORKSPACE/data"

OLD_JSONL="$HOME/.claude/projects/-Users-$(id -un)--openclaw-workspace"
NEW_JSONL="$HOME/.claude/projects/-Users-$(id -un)--sovereign"

PLIST="$HOME/Library/LaunchAgents/com.sovereign.server.plist"
GLOBAL_CLAUDE_MD="$HOME/.claude/CLAUDE.md"

BACKUP_DIR="$HOME/sovereign-migration-backup-$(date +%Y%m%d-%H%M%S)"

# ── Output helpers ──────────────────────────────────────────────────────
_step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
_note() { printf '    %s\n' "$*"; }
_warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
_die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

_run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '    [dry-run] %s\n' "$*"
  else
    eval "$@"
  fi
}

_confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  [ "$DRY_RUN" -eq 1 ] && return 0
  printf '    %s [y/N] ' "$1"
  read -r reply
  [[ "$reply" =~ ^[Yy]$ ]] || { _warn "skipped"; return 1; }
}

# ── Pre-flight ──────────────────────────────────────────────────────────
_step "Pre-flight"

[ -d "$OLD_WORKSPACE" ] || _die "Old workspace not found at $OLD_WORKSPACE — nothing to migrate."
[ -d "$OLD_DATA" ]      || _die "Old data dir not found at $OLD_DATA — workspace exists but data is missing."

if [ -d "$NEW_WORKSPACE" ]; then
  _warn "$NEW_WORKSPACE already exists."
  _confirm "Re-run migration on top of existing $NEW_WORKSPACE?" || _die "Aborted."
fi

# Check the SDK-encoded path matches expectation.
EXPECTED_JSONL="$HOME/.claude/projects/$(echo "$NEW_WORKSPACE" | sed 's|[/.]|-|g')"
if [ "$NEW_JSONL" != "$EXPECTED_JSONL" ]; then
  _warn "Encoded JSONL path mismatch — computed $EXPECTED_JSONL but hardcoded $NEW_JSONL"
  _warn "Edit this script's NEW_JSONL line, or migration will leave transcripts orphaned."
  _confirm "Continue anyway?" || _die "Aborted."
fi

# Sovereign must be stopped — running services hold open file handles + would
# clobber the rewrites when they sync state to disk.
if launchctl list 2>/dev/null | awk '{print $3}' | grep -Fxq "com.sovereign.server"; then
  _warn "Sovereign launchd service is still loaded."
  _confirm "Stop it now? (recommended)" && _run "sovereign stop"
  _confirm "Proceed with Sovereign still running?" || _die "Aborted — run 'sovereign stop' first."
fi

_note "OK — old workspace at $OLD_WORKSPACE ($(du -sh "$OLD_WORKSPACE" 2>/dev/null | awk '{print $1}'))"
_note "OK — old data dir at $OLD_DATA ($(du -sh "$OLD_DATA" 2>/dev/null | awk '{print $1}'))"
[ -d "$OLD_JSONL" ] && _note "OK — old JSONL tree at $OLD_JSONL ($(du -sh "$OLD_JSONL" 2>/dev/null | awk '{print $1}'))"

# ── Backups (only the things we'll overwrite) ───────────────────────────
_step "Backing up overwrite targets to $BACKUP_DIR"
_run "mkdir -p '$BACKUP_DIR'"
[ -f "$PLIST" ]            && _run "cp '$PLIST' '$BACKUP_DIR/plist.original'"
[ -f "$GLOBAL_CLAUDE_MD" ] && _run "cp '$GLOBAL_CLAUDE_MD' '$BACKUP_DIR/claude-CLAUDE.md.original'"

# ── Copy workspace ──────────────────────────────────────────────────────
_step "Copying $OLD_WORKSPACE → $NEW_WORKSPACE (this may take a moment)"
_run "cp -R '$OLD_WORKSPACE' '$NEW_WORKSPACE'"

_step "Renaming .sovereign-data → data inside the copy"
if [ -d "$NEW_WORKSPACE/.sovereign-data" ]; then
  _run "mv '$NEW_WORKSPACE/.sovereign-data' '$NEW_DATA'"
else
  _note "(already renamed — skipping)"
fi

# ── Rewrite absolute paths inside the copied data files ─────────────────
_step "Rewriting $OLD_WORKSPACE → $NEW_WORKSPACE in copied JSON data files"
if [ "$DRY_RUN" -eq 1 ]; then
  _note "[dry-run] would scan $NEW_DATA for *.json containing 'openclaw' and rewrite paths"
else
  TARGETS=$(grep -rl "openclaw" "$NEW_DATA" --include="*.json" 2>/dev/null || true)
  if [ -z "$TARGETS" ]; then
    _note "no files contain 'openclaw' references — skipping rewrite"
  else
    # Compute the SDK-encoded JSONL directory names. The SDK encodes cwd by
    # replacing every `/` AND `.` with `-`, so `/Users/josh/.openclaw/workspace`
    # becomes `-Users-josh--openclaw-workspace` (leading dot in `.openclaw`
    # produces the double dash).
    OLD_JSONL_DIR=$(basename "$OLD_JSONL")
    NEW_JSONL_DIR=$(basename "$NEW_JSONL")
    echo "$TARGETS" | while IFS= read -r f; do
      [ -z "$f" ] && continue
      _note "patching $(echo "$f" | sed "s|$HOME|~|")"
      # Three patterns — long-prefix first so subsequent rules don't truncate
      # paths the earlier rules didn't catch.
      #   1. data dir path (e.g. `.sovereign-data` → `data`)
      #   2. workspace cwd path
      #   3. SDK-encoded JSONL directory name inside ~/.claude/projects/
      sed -i '' \
        -e "s|$OLD_DATA|$NEW_DATA|g" \
        -e "s|$OLD_WORKSPACE|$NEW_WORKSPACE|g" \
        -e "s|$OLD_JSONL_DIR|$NEW_JSONL_DIR|g" \
        "$f"
    done
    # Post-rewrite check — anything still mentioning the old prefix means a
    # pattern we missed.
    LEFTOVER=$(grep -rl "openclaw" "$NEW_DATA" --include="*.json" 2>/dev/null || true)
    if [ -n "$LEFTOVER" ]; then
      _warn "Files still contain 'openclaw' references after rewrite — inspect:"
      echo "$LEFTOVER" | sed 's/^/      /'
    fi
  fi

  # Strip dead config keys that the post-OpenClaw schema rejects.
  if [ -f "$NEW_DATA/config.json" ] && command -v python3 >/dev/null 2>&1; then
    python3 - <<PY
import json, sys
p = "$NEW_DATA/config.json"
try:
    c = json.load(open(p))
except Exception as e:
    sys.exit(0)
changed = False
ab = c.get("agentBackend", {})
# Drop the dead openclaw sub-block (schema is additionalProperties:false).
if ab.pop("openclaw", None) is not None:
    changed = True
# Remap the enum-constrained fields — claude-code is now the only legal value,
# so leaving these as 'openclaw' would fail schema validation. Deleting the
# openclaw block alone is necessary but NOT sufficient.
if ab.get("default") == "openclaw":
    ab["default"] = "claude-code"
    changed = True
if isinstance(ab.get("enabled"), list):
    remapped = ["claude-code" if x == "openclaw" else x for x in ab["enabled"]]
    deduped = list(dict.fromkeys(remapped)) or ["claude-code"]
    if deduped != ab["enabled"]:
        ab["enabled"] = deduped
        changed = True
if changed:
    json.dump(c, open(p, "w"), indent=2)
    print(f"    cleaned dead agentBackend.openclaw config (block + default/enabled)")
PY
  fi
  if [ -f "$NEW_DATA/secrets.json" ] && command -v python3 >/dev/null 2>&1; then
    python3 - <<PY
import json, sys
p = "$NEW_DATA/secrets.json"
try:
    c = json.load(open(p))
except Exception as e:
    sys.exit(0)
if c.pop("openclawGatewayToken", None) is not None:
    json.dump(c, open(p, "w"), indent=2)
    print(f"    cleaned openclawGatewayToken from secrets.json")
PY
  fi
fi

# ── Copy Claude Code JSONL tree ─────────────────────────────────────────
_step "Copying Claude Code transcripts $OLD_JSONL → $NEW_JSONL"
if [ ! -d "$OLD_JSONL" ]; then
  _warn "Old JSONL tree not found — skipping (sessions will start fresh)"
elif [ -d "$NEW_JSONL" ]; then
  _warn "$NEW_JSONL already exists — skipping (refusing to clobber)"
else
  _run "cp -R '$OLD_JSONL' '$NEW_JSONL'"
fi

# ── Quarantine the existing workspace-local CLAUDE.md ──────────────────
# This file (the pre-migration hand-written approximation of the assembled
# personality) is NOT a source — it's a stale copy of what the compiler now
# generates into ~/.claude/CLAUDE.md. If we leave it in place, Claude Code's
# cwd walk-up will read it alongside the compiled output, doubling the
# personality content. Rename it out of the way so it stays available for
# reference but is no longer picked up by the SDK.
LEGACY_CLAUDE_MD="$NEW_WORKSPACE/CLAUDE.md"
QUARANTINED="$NEW_WORKSPACE/CLAUDE.md.pre-migration.bak"
_step "Quarantining legacy $LEGACY_CLAUDE_MD"
if [ ! -f "$LEGACY_CLAUDE_MD" ]; then
  _note "(no workspace-local CLAUDE.md — nothing to quarantine)"
elif [ -e "$QUARANTINED" ]; then
  _warn "$QUARANTINED already exists — leaving the active file in place; resolve manually"
else
  _run "mv '$LEGACY_CLAUDE_MD' '$QUARANTINED'"
  _note "renamed to $QUARANTINED (kept for reference; SDK no longer reads it)"
fi

# ── Seed config.personality (assembly order for ~/.claude/CLAUDE.md) ────
# The personality compiler reads its manifest from config.personality. There
# is no separate manifest file. CLAUDE.md is the *compiled output target* —
# it must never appear in `files`, or it would feed the compiler's own output
# back in as a source on the next save (and the SDK's cwd walk-up would read
# it alongside the compiled output, doubling the personality content).
_step "Seeding config.personality in $NEW_CONFIG/config.json"
if [ "$DRY_RUN" -eq 1 ]; then
  _note "[dry-run] would set config.personality (files + separator) if absent"
elif command -v python3 >/dev/null 2>&1; then
  python3 - <<PY
import json, os
# Config may still be in the old data location at this point in the script;
# the hoist step below will move it. Update whichever copy exists.
candidates = ["$NEW_CONFIG/config.json", "$NEW_DATA/config.json"]
target = next((p for p in candidates if os.path.exists(p)), candidates[0])
try:
    cfg = json.load(open(target))
except Exception:
    cfg = {}
if cfg.get("personality"):
    print(f"    (config.personality already present in {target} — leaving alone)")
else:
    cfg["personality"] = {
        "sourceDir": "",
        "files": ["IDENTITY.md", "SOUL.md", "AGENTS.md", "TOOLS.md", "MEMORY.md", "USER.md"],
        "separator": "\n\n---\n\n"
    }
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w") as f:
        json.dump(cfg, f, indent=2)
    print(f"    seeded config.personality in {target} — edit there to change order")
PY
else
  _warn "python3 not available — skipped config.personality seed"
fi

# Legacy: if a standalone personality-order.json exists from an earlier
# migration, fold it into config.json and remove the file.
LEGACY_ORDER="$NEW_WORKSPACE/personality-order.json"
if [ -f "$LEGACY_ORDER" ]; then
  _step "Folding legacy $LEGACY_ORDER into config.personality"
  if [ "$DRY_RUN" -eq 1 ]; then
    _note "[dry-run] would fold $LEGACY_ORDER → config.personality and remove"
  elif command -v python3 >/dev/null 2>&1; then
    python3 - <<PY
import json, os
src = "$LEGACY_ORDER"
candidates = ["$NEW_CONFIG/config.json", "$NEW_DATA/config.json"]
target = next((p for p in candidates if os.path.exists(p)), candidates[0])
try:
    legacy = json.load(open(src))
except Exception as e:
    print(f"    failed to parse {src}: {e}")
    raise SystemExit(0)
try:
    cfg = json.load(open(target))
except Exception:
    cfg = {}
cfg["personality"] = {
    "sourceDir": "",
    "files": legacy.get("files", []),
    "separator": legacy.get("separator", "\n\n---\n\n")
}
os.makedirs(os.path.dirname(target), exist_ok=True)
with open(target, "w") as f:
    json.dump(cfg, f, indent=2)
os.rename(src, src + ".pre-config-fold.bak")
print(f"    folded {len(cfg['personality']['files'])} entries into {target}")
print(f"    moved {src} → {src}.pre-config-fold.bak")
PY
  else
    _warn "python3 not available — skipped legacy manifest fold (resolve manually)"
  fi
fi

# ── Hoist user-edited config out of data/ into the config dir ───────────
# Only config.json moves — it's the version-controlled user state. secrets.json
# and config-history.jsonl are runtime/sensitive and stay in the data dir.
_step "Hoisting config.json out of $NEW_DATA into $NEW_CONFIG"
src="$NEW_DATA/config.json"
dest="$NEW_CONFIG/config.json"
if [ ! -e "$src" ]; then
  _note "(no config.json to hoist)"
elif [ -e "$dest" ]; then
  _warn "$dest already exists — leaving $src in place; resolve manually"
else
  _run "mv '$src' '$dest'"
  _note "hoisted config.json → $dest"
fi

# ── Validate the migrated config against the live schema ────────────────
# Surface any schema-invalid keys NOW, while the operator is watching — rather
# than letting the server silently drop them (and revert to defaults for those
# fields) at boot. The sanitiser above handles the known openclaw keys; this
# catches anything else the OpenClaw-era config carried that the new schema
# rejects.
_step "Validating migrated config against the current schema"
if [ "$DRY_RUN" -eq 1 ]; then
  _note "[dry-run] would run 'sovereign config-check $NEW_CONFIG/config.json'"
elif [ -f "$NEW_CONFIG/config.json" ]; then
  if "$(dirname "$0")/sovereign" config-check "$NEW_CONFIG/config.json"; then
    _note "config.json passes schema validation"
  else
    _warn "Migrated config.json has schema-invalid keys (listed above)."
    _warn "At boot the server keeps the valid keys and drops these (defaults backfill)."
    _confirm "Continue anyway?" || _die "Aborted — fix $NEW_CONFIG/config.json and re-run."
  fi
else
  _note "(no hoisted config.json to validate)"
fi

# ── Reinstall launchd plist via the canonical template ──────────────────
# The template now includes both SOVEREIGN_CONFIG_DIR and SOVEREIGN_DATA_DIR.
# bin/sovereign install re-templates from support/com.sovereign.server.plist
# using the current CONFIG_DIR / DATA_DIR defaults, so a sed-rewrite of the
# live plist would miss the new env var entirely.
_step "Reinstalling launchd plist with new config + data dir env vars"
if [ ! -f "$PLIST" ]; then
  _warn "Plist not found at $PLIST — installing fresh"
fi
_run "SOVEREIGN_CONFIG_DIR='$NEW_CONFIG' SOVEREIGN_DATA_DIR='$NEW_DATA' '$(dirname "$0")/sovereign' install"

# ── Summary ─────────────────────────────────────────────────────────────
_step "Migration complete"
cat <<EOF

    New workspace:     $NEW_WORKSPACE
    New config dir:    $NEW_CONFIG  (config.json — track in git)
    New data dir:      $NEW_DATA    (runtime state, secrets — gitignore)
    New JSONL tree:    $NEW_JSONL
    Personality order: config.personality in $NEW_CONFIG/config.json
    Backup:            $BACKUP_DIR

Original ~/.openclaw/ is untouched. Rollback at any time:
    cp $BACKUP_DIR/plist.original $PLIST
    cp $BACKUP_DIR/claude-CLAUDE.md.original $GLOBAL_CLAUDE_MD   # if present
    sovereign start

Next steps:
    1. Inspect / adjust:  the "personality" block in $NEW_CONFIG/config.json
    2. Start the new service:  sovereign start
       (the personality compiler will rewrite ~/.claude/CLAUDE.md on boot)
    3. Verify in the UI:  https://localhost:5801/
    4. After 24-48h stable, run with --prune to delete originals (see migration guide).

EOF
