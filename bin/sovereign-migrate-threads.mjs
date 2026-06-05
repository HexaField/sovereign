#!/usr/bin/env node
// One-shot migration: legacy human thread "key" → bare UUID id.
//
// Rewrites every Sovereign data file that references a thread by its old
// human-chosen key so it instead uses the thread's UUID. Matches the SHIPPED
// bare-UUID runtime:
//
//   • threads.json is already v2 ({ version: 2, threads: [{ id, label, … }] }).
//     This script does NOT rewrite it; it reads it to build a label → id map.
//   • A session's canonical key IS its bare id end-to-end. The registry keeps
//     its field NAMES (`threadKey` / `sessionKey` / `parentSessionKey`) but
//     their VALUES become bare UUIDs (threads) / bare SDK ids (subagents).
//     The legacy `agent:main:thread:<x>` / `agent:main:subagent:<x>` /
//     `agent:main:main` compound forms are gone.
//
// Idempotent: re-running on already-migrated files is a no-op. Refuses to run
// while the Sovereign daemon is alive. Every file written gets a
// `.bak.<timestamp>` sibling — restore them to revert.
//
// Usage:
//   node bin/sovereign-migrate-threads.mjs            # dry-run, prints plan
//   node bin/sovereign-migrate-threads.mjs --apply    # write changes
//   node bin/sovereign-migrate-threads.mjs --apply --data-dir /custom/path
//   node bin/sovereign-migrate-threads.mjs --apply --force   # skip daemon check

import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync, copyFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const args = process.argv.slice(2)
const DRY_RUN = !args.includes('--apply')
const FORCE = args.includes('--force')
const DATA_DIR = (() => {
  const i = args.indexOf('--data-dir')
  if (i >= 0 && args[i + 1]) return args[i + 1]
  return process.env.SOVEREIGN_DATA_DIR || join(process.env.HOME ?? '', '.sovereign', 'data')
})()

const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const THREAD_PREFIX = 'agent:main:thread:'
const SUBAGENT_PREFIX = 'agent:main:subagent:'

function log(...a) {
  console.log(...a)
}
function die(msg) {
  console.error(`ERROR: ${msg}`)
  process.exit(1)
}

// ─────────────────────────────────────────────────────────────────────────
// Safety gate: refuse to run while the daemon is up. It hot-reads + write-
// throughs these files; migrating under it would race and lose writes.
// ─────────────────────────────────────────────────────────────────────────
function ensureDaemonDown() {
  if (FORCE) return
  try {
    const out = execSync('curl -fsS --max-time 1 http://127.0.0.1:5801/health 2>/dev/null', { encoding: 'utf-8' })
    if (out.includes('"ok"')) {
      die(
        'Sovereign daemon is currently running (responded on :5801/health). ' +
          'Migration must run against quiescent state. Stop the service first:\n' +
          '   bin/sovereign stop\n' +
          'or pass --force to override (at your own risk).'
      )
    }
  } catch {
    /* daemon down → proceed */
  }
}

function readJson(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    die(`failed to parse ${path}: ${err.message}`)
  }
}

function writeJson(path, obj) {
  if (DRY_RUN) {
    log(`   [dry-run] would write ${path}`)
    return
  }
  if (existsSync(path)) copyFileSync(path, `${path}.bak.${STAMP}`)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(obj, null, 2))
  renameSync(tmp, path)
  log(`   wrote     ${path}`)
}

// ─────────────────────────────────────────────────────────────────────────
// Build label → UUID from the already-v2 threads.json. Errors on duplicate
// labels so the migration never silently mis-maps (clean the dupes first).
// ─────────────────────────────────────────────────────────────────────────
function buildLabelMap() {
  const path = join(DATA_DIR, 'threads.json')
  const root = readJson(path)
  if (!root || !Array.isArray(root.threads)) die(`threads.json missing or malformed at ${path}`)
  if (root.version !== 2) die(`threads.json is v${root.version ?? 1}, expected v2 (run the app once to upgrade it first)`)
  const map = new Map()
  const dupes = []
  for (const t of root.threads) {
    if (!t.id || !t.label) continue
    if (map.has(t.label)) dupes.push(t.label)
    else map.set(t.label, t.id)
  }
  if (dupes.length) {
    die(
      `threads.json has duplicate labels: ${[...new Set(dupes)].join(', ')}. ` +
        `Resolve the duplicates before migrating (the label → id map would be ambiguous).`
    )
  }
  log(`[map] ${map.size} thread label(s) → id`)
  return map
}

// Resolve any thread/session reference to its bare id.
//   `agent:main:subagent:<id>`     → <id>
//   `agent:main:main`              → <main thread id>
//   `agent:main:thread:<label>`    → <id> (via label map; pass-through if uuid)
//   `<label>`                      → <id> (via label map)
//   `<uuid>` / unknown             → unchanged
function resolve(value, labelMap) {
  if (typeof value !== 'string' || !value) return value
  if (value.startsWith(SUBAGENT_PREFIX)) return value.slice(SUBAGENT_PREFIX.length)
  if (value === 'agent:main:main') return labelMap.get('main') ?? value
  if (value.startsWith(THREAD_PREFIX)) {
    const bare = value.slice(THREAD_PREFIX.length)
    return labelMap.get(bare) ?? bare
  }
  return labelMap.get(value) ?? value
}

// ─────────────────────────────────────────────────────────────────────────
// [1/4] agent-backend/sessions.json — re-key + rewrite field VALUES to bare.
// Field names stay (threadKey / sessionKey / parentSessionKey); a session's
// canonical key IS its bare id, so all three collapse to the same bare value.
// ─────────────────────────────────────────────────────────────────────────
function migrateSessions(labelMap) {
  const path = join(DATA_DIR, 'agent-backend', 'sessions.json')
  const root = readJson(path)
  if (!root) {
    log(`[1/4] sessions.json — not found, skipping`)
    return
  }
  let changed = 0
  const out = {}
  for (const [oldKey, rec] of Object.entries(root)) {
    const newKey = resolve(oldKey, labelMap)
    const updated = { ...rec }
    if (typeof rec.threadKey === 'string') updated.threadKey = resolve(rec.threadKey, labelMap)
    // Canonical key == bare id == the (resolved) top-level key.
    if ('sessionKey' in rec) updated.sessionKey = newKey
    if (typeof rec.parentSessionKey === 'string') updated.parentSessionKey = resolve(rec.parentSessionKey, labelMap)
    if (newKey !== oldKey || JSON.stringify(updated) !== JSON.stringify(rec)) changed++
    out[newKey] = updated
  }
  log(`[1/4] sessions.json — ${Object.keys(root).length} record(s), ${changed} changed`)
  if (changed > 0) writeJson(path, out)
}

// ─────────────────────────────────────────────────────────────────────────
// [2/4] agent-backend/claude-code-state/<encodedKey>.json — rename each file
// so its (decoded) key becomes the bare id, and resolve any embedded
// parentSessionKey inside the persisted state.
// ─────────────────────────────────────────────────────────────────────────
function migrateClaudeCodeState(labelMap) {
  const dir = join(DATA_DIR, 'agent-backend', 'claude-code-state')
  if (!existsSync(dir)) {
    log(`[2/4] claude-code-state/ — not found, skipping`)
    return
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.includes('.bak.'))
  let renamed = 0
  for (const fname of files) {
    const decoded = decodeURIComponent(fname.slice(0, -'.json'.length))
    const bare = resolve(decoded, labelMap)
    const newFname = `${encodeURIComponent(bare)}.json`
    const oldPath = join(dir, fname)
    const blob = readJson(oldPath)
    let contentChanged = false
    if (blob?.data && typeof blob.data.parentSessionKey === 'string') {
      const resolved = resolve(blob.data.parentSessionKey, labelMap)
      if (resolved !== blob.data.parentSessionKey) {
        blob.data.parentSessionKey = resolved
        contentChanged = true
      }
    }
    if (newFname === fname && !contentChanged) continue
    renamed++
    if (DRY_RUN) {
      log(`   [dry-run] would ${newFname === fname ? 'rewrite' : `rename ${fname} →`} ${newFname}`)
      continue
    }
    copyFileSync(oldPath, `${oldPath}.bak.${STAMP}`)
    writeFileSync(join(dir, newFname), JSON.stringify(blob, null, 2))
    if (newFname !== fname) unlinkSync(oldPath)
    log(`   ${newFname === fname ? 'rewrote' : `renamed   ${fname} →`} ${newFname}`)
  }
  log(`[2/4] claude-code-state/ — ${files.length} file(s), ${renamed} changed`)
}

// ─────────────────────────────────────────────────────────────────────────
// [3/4] scheduler/jobs.json — cron payloads carry `threadKey`. Keep the field
// name (cron-service reads payload.threadKey) but rewrite the value to bare.
// ─────────────────────────────────────────────────────────────────────────
function migrateSchedulerJobs(labelMap) {
  const path = join(DATA_DIR, 'scheduler', 'jobs.json')
  const root = readJson(path)
  const jobs = Array.isArray(root) ? root : Array.isArray(root?.jobs) ? root.jobs : null
  if (!jobs) {
    log(`[3/4] scheduler/jobs.json — not found or unexpected shape, skipping`)
    return
  }
  let touched = 0
  for (const job of jobs) {
    const tk = job?.payload?.threadKey
    if (typeof tk !== 'string') continue
    const bare = resolve(tk, labelMap)
    if (bare !== tk) {
      job.payload.threadKey = bare
      touched++
    }
  }
  log(`[3/4] scheduler/jobs.json — ${jobs.length} job(s), ${touched} re-pointed`)
  if (touched > 0) writeJson(path, root)
}

// ─────────────────────────────────────────────────────────────────────────
// [4/4] agent-backend/active-session-pointer.json + active-sessions.json —
// transient liveness state. Re-key so a daemon resume after migration sees
// consistent bare ids without a flush.
// ─────────────────────────────────────────────────────────────────────────
function migrateActiveState(labelMap) {
  // active-session-pointer.json: { version, data: "<sessionKey>" | null }
  const ptrPath = join(DATA_DIR, 'agent-backend', 'active-session-pointer.json')
  const ptr = readJson(ptrPath)
  if (ptr && typeof ptr.data === 'string') {
    const bare = resolve(ptr.data, labelMap)
    if (bare !== ptr.data) {
      log(`[4/4] active-session-pointer — "${ptr.data}" → "${bare}"`)
      writeJson(ptrPath, { ...ptr, data: bare })
    } else {
      log(`[4/4] active-session-pointer — already bare, skipping`)
    }
  } else {
    log(`[4/4] active-session-pointer — empty/null, skipping`)
  }

  // active-sessions.json: { version, data: { [sessionKey]: { threadKey, sessionKey, … } } }
  const asPath = join(DATA_DIR, 'agent-backend', 'active-sessions.json')
  const as = readJson(asPath)
  if (as?.data && Object.keys(as.data).length > 0) {
    const out = { ...as, data: {} }
    let touched = 0
    for (const [oldKey, entry] of Object.entries(as.data)) {
      const newKey = resolve(oldKey, labelMap)
      const updated = { ...entry }
      if (typeof entry.threadKey === 'string') updated.threadKey = resolve(entry.threadKey, labelMap)
      if ('sessionKey' in entry) updated.sessionKey = newKey
      if (typeof entry.parentSessionKey === 'string') updated.parentSessionKey = resolve(entry.parentSessionKey, labelMap)
      out.data[newKey] = updated
      touched++
    }
    log(`      active-sessions.json — ${touched} record(s) re-keyed`)
    writeJson(asPath, out)
  } else {
    log(`      active-sessions.json — empty, skipping`)
  }
}

// ─────────────────────────────────────────────────────────────────────────
console.log(`Sovereign threads migration → bare UUID  (${DRY_RUN ? 'DRY RUN' : 'APPLY'})`)
console.log(`Data dir: ${DATA_DIR}`)
console.log()

ensureDaemonDown()

const labelMap = buildLabelMap()
migrateSessions(labelMap)
migrateClaudeCodeState(labelMap)
migrateSchedulerJobs(labelMap)
migrateActiveState(labelMap)

console.log()
console.log(DRY_RUN ? 'Dry run complete. Re-run with --apply to write changes.' : 'Migration complete.')
if (!DRY_RUN) {
  console.log(`Back-out: every changed file has a sibling \`*.bak.${STAMP}\`. Restore them + restart to revert.`)
}
console.log()
console.log('label → id:')
console.log(JSON.stringify(Object.fromEntries(labelMap), null, 2))
