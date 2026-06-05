import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

// Guards the one-shot thread-UUID migration (bin/sovereign-migrate-threads.mjs).
// It rewrites legacy human thread keys → bare UUIDs across sessions registry,
// claude-code state files, scheduler payloads and the active-session pointer.
// These assertions are the contract the live runtime reads after migrating.

const SCRIPT = fileURLToPath(new URL('../../../bin/sovereign-migrate-threads.mjs', import.meta.url))

const ID_A = '11111111-1111-1111-1111-111111111111' // label "alpha"
const ID_B = '22222222-2222-2222-2222-222222222222' // label "beta"

function readJson(p: string): any {
  return JSON.parse(readFileSync(p, 'utf-8'))
}

function seedDataDir(dir: string): void {
  const ab = join(dir, 'agent-backend')
  const state = join(ab, 'claude-code-state')
  const sched = join(dir, 'scheduler')
  mkdirSync(state, { recursive: true })
  mkdirSync(sched, { recursive: true })

  // threads.json already v2 (the app upgrades it on boot); the script reads it
  // only to build label → id.
  writeFileSync(
    join(dir, 'threads.json'),
    JSON.stringify({
      version: 2,
      threads: [
        {
          id: ID_A,
          label: 'alpha',
          workspaceIds: [],
          entities: [],
          lastActivity: 0,
          unreadCount: 0,
          agentStatus: 'idle',
          createdAt: 0,
          archived: false
        },
        {
          id: ID_B,
          label: 'beta',
          workspaceIds: [],
          entities: [],
          lastActivity: 0,
          unreadCount: 0,
          agentStatus: 'idle',
          createdAt: 0,
          archived: false
        }
      ]
    })
  )

  // sessions.json — legacy human keys + a subagent whose parent is a label.
  writeFileSync(
    join(ab, 'sessions.json'),
    JSON.stringify({
      alpha: {
        threadKey: 'alpha',
        sessionKey: 'agent:main:thread:alpha',
        backendKind: 'claude-code',
        backendSessionId: 'bsid-alpha'
      },
      'agent:main:subagent:sub1': {
        threadKey: 'agent:main:subagent:sub1',
        sessionKey: 'agent:main:subagent:sub1',
        parentSessionKey: 'agent:main:thread:alpha',
        backendKind: 'claude-code',
        backendSessionId: 'sub1'
      }
    })
  )

  // A claude-code-state file named with the URL-encoded compound key.
  writeFileSync(
    join(state, `${encodeURIComponent('agent:main:thread:alpha')}.json`),
    JSON.stringify({ version: 1, data: { backendSessionId: 'bsid-alpha' } })
  )

  // scheduler job addressing a thread by label.
  writeFileSync(
    join(sched, 'jobs.json'),
    JSON.stringify([
      {
        name: 'j',
        schedule: { kind: 'cron', expr: '* * * * *' },
        payload: { kind: 'sovereign.userMessage', threadKey: 'beta', prompt: 'x' }
      }
    ])
  )

  // active-session pointer in the legacy compound form.
  writeFileSync(
    join(ab, 'active-session-pointer.json'),
    JSON.stringify({ version: 1, data: 'agent:main:thread:alpha' })
  )
}

function runMigration(dir: string): void {
  // --force skips the live-daemon health probe (this is an isolated temp dir).
  execFileSync('node', [SCRIPT, '--apply', '--force', '--data-dir', dir], { encoding: 'utf-8' })
}

describe('sovereign-migrate-threads (bare-UUID migration)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sov-migrate-'))
    seedDataDir(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('re-keys sessions, state files, scheduler payloads and the active pointer to bare UUIDs', () => {
    runMigration(dir)

    const sessions = readJson(join(dir, 'agent-backend', 'sessions.json'))
    // Thread record re-keyed to its UUID; field VALUES are bare (field NAMES kept).
    expect(sessions[ID_A]).toBeDefined()
    expect(sessions['alpha']).toBeUndefined()
    expect(sessions[ID_A].threadKey).toBe(ID_A)
    expect(sessions[ID_A].sessionKey).toBe(ID_A)
    expect(sessions[ID_A].backendSessionId).toBe('bsid-alpha')
    // Subagent keyed by its bare SDK id, parent resolved to the thread UUID.
    expect(sessions['sub1']).toBeDefined()
    expect(sessions['sub1'].parentSessionKey).toBe(ID_A)
    // No compound keys anywhere.
    expect(Object.keys(sessions).some((k) => k.startsWith('agent:main:'))).toBe(false)

    // claude-code-state file renamed to <uuid>.json.
    const stateFiles = readdirSync(join(dir, 'agent-backend', 'claude-code-state'))
    expect(stateFiles).toContain(`${ID_A}.json`)
    expect(stateFiles.some((f) => f.startsWith('agent%3A') && !f.includes('.bak.'))).toBe(false)

    // scheduler payload threadKey rewritten to the UUID (field name kept — cron-service reads payload.threadKey).
    const jobs = readJson(join(dir, 'scheduler', 'jobs.json'))
    expect(jobs[0].payload.threadKey).toBe(ID_B)

    // active-session pointer → bare UUID.
    expect(readJson(join(dir, 'agent-backend', 'active-session-pointer.json')).data).toBe(ID_A)
  })

  it('is idempotent — a second run changes nothing', () => {
    runMigration(dir)
    const after1 = readJson(join(dir, 'agent-backend', 'sessions.json'))
    const jobs1 = readJson(join(dir, 'scheduler', 'jobs.json'))
    runMigration(dir)
    const after2 = readJson(join(dir, 'agent-backend', 'sessions.json'))
    const jobs2 = readJson(join(dir, 'scheduler', 'jobs.json'))
    expect(after2).toEqual(after1)
    expect(jobs2).toEqual(jobs1)
    expect(existsSync(join(dir, 'agent-backend', 'sessions.json'))).toBe(true)
  })
})
