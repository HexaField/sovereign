import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { createEventBus } from '@sovereign/core'
import type { BusEvent } from '@sovereign/core'
import { createMembraneManager, MEMBRANE_CONTEXT_FILENAME, type MembraneManager } from './membranes.js'
import { createMembraneStore } from './store.js'
import { createMembraneRoutes } from './routes.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-membranes-test-'))
}

let dataDir: string
let bus: ReturnType<typeof createEventBus>
let manager: MembraneManager
let events: BusEvent[]

beforeEach(() => {
  dataDir = tmpDir()
  bus = createEventBus(dataDir)
  events = []
  bus.on('membrane.*', (e) => {
    events.push(e)
  })
  manager = createMembraneManager(bus, dataDir)
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('§Membranes — Manager CRUD', () => {
  it('creates a membrane with sensible defaults', () => {
    const m = manager.createMembrane({ name: 'Personal' })
    expect(m.id).toBe('personal')
    expect(m.name).toBe('Personal')
    expect(m.visibility).toBe('private')
    expect(m.workspaceIds).toEqual([])
    expect(m.createdAt).toBeTruthy()
    expect(m.updatedAt).toBeTruthy()
  })

  it('auto-slugifies id from name and de-dupes collisions', () => {
    const a = manager.createMembrane({ name: 'Atlas Research' })
    const b = manager.createMembrane({ name: 'Atlas Research' })
    expect(a.id).toBe('atlas-research')
    expect(b.id).toBe('atlas-research-2')
  })

  it('accepts an explicit id and full input', () => {
    const m = manager.createMembrane({
      id: 'philosophy',
      name: 'Philosophy',
      visibility: 'shared',
      contentPath: '/tmp/mem/philosophy',
      workspaceIds: ['hexafield', 'coasys'],
      icon: '☯',
      color: '#a855f7'
    })
    expect(m.id).toBe('philosophy')
    expect(m.visibility).toBe('shared')
    expect(m.workspaceIds).toEqual(['hexafield', 'coasys'])
  })

  it('rejects duplicate explicit ids', () => {
    manager.createMembrane({ id: 'personal', name: 'Personal' })
    expect(() => manager.createMembrane({ id: 'personal', name: 'Other' })).toThrow(/already exists/)
  })

  it('dedupes workspaceIds on create', () => {
    const m = manager.createMembrane({ name: 'X', workspaceIds: ['a', 'a', 'b'] })
    expect(m.workspaceIds).toEqual(['a', 'b'])
  })

  it('updates fields in place and bumps updatedAt', async () => {
    const m = manager.createMembrane({ name: 'X' })
    const initial = m.updatedAt
    await new Promise((r) => setTimeout(r, 5))
    const updated = manager.updateMembrane(m.id, { name: 'Y', visibility: 'public' })
    expect(updated.name).toBe('Y')
    expect(updated.visibility).toBe('public')
    expect(updated.updatedAt).not.toBe(initial)
  })

  it('throws on update of unknown id', () => {
    expect(() => manager.updateMembrane('nope', { name: 'X' })).toThrow(/not found/)
  })

  it('deletes a membrane', () => {
    const m = manager.createMembrane({ name: 'X' })
    manager.deleteMembrane(m.id)
    expect(manager.getMembrane(m.id)).toBeUndefined()
  })
})

describe('§Membranes — Workspace mapping (many-to-many)', () => {
  it('listMembranesForWorkspace returns every membrane that contains the org', () => {
    manager.createMembrane({ id: 'personal', name: 'Personal', workspaceIds: ['hexafield'] })
    manager.createMembrane({ id: 'philosophy', name: 'Philosophy', workspaceIds: ['hexafield', 'coasys'] })
    manager.createMembrane({ id: 'coasys-team', name: 'Coasys Team', workspaceIds: ['coasys'] })

    const inHexafield = manager.listMembranesForWorkspace('hexafield').map((m) => m.id)
    expect(inHexafield.sort()).toEqual(['personal', 'philosophy'])

    const inCoasys = manager.listMembranesForWorkspace('coasys').map((m) => m.id)
    expect(inCoasys.sort()).toEqual(['coasys-team', 'philosophy'])

    const inUnknown = manager.listMembranesForWorkspace('does-not-exist')
    expect(inUnknown).toEqual([])
  })

  it('addWorkspace is idempotent', () => {
    manager.createMembrane({ id: 'x', name: 'X' })
    manager.addWorkspace('x', 'org-a')
    manager.addWorkspace('x', 'org-a')
    expect(manager.getMembrane('x')!.workspaceIds).toEqual(['org-a'])
  })

  it('removeWorkspace removes only the named org', () => {
    manager.createMembrane({ id: 'x', name: 'X', workspaceIds: ['a', 'b', 'c'] })
    manager.removeWorkspace('x', 'b')
    expect(manager.getMembrane('x')!.workspaceIds).toEqual(['a', 'c'])
  })
})

describe('§Membranes — Persistence', () => {
  it('writes membranes.json at <dataDir>/membranes.json', () => {
    manager.createMembrane({ id: 'personal', name: 'Personal' })
    const file = path.join(dataDir, 'membranes.json')
    expect(fs.existsSync(file)).toBe(true)
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(parsed.version).toBe(1)
    expect(parsed.membranes).toHaveLength(1)
    expect(parsed.membranes[0].id).toBe('personal')
  })

  it('round-trips state through a fresh manager instance', () => {
    manager.createMembrane({ id: 'personal', name: 'Personal', workspaceIds: ['hexafield'] })

    const second = createMembraneManager(bus, dataDir)
    expect(second.listMembranes()).toHaveLength(1)
    expect(second.getMembrane('personal')?.workspaceIds).toEqual(['hexafield'])
  })

  it('silently drops a legacy activeMembraneId field on read', () => {
    const file = path.join(dataDir, 'membranes.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        membranes: [{ id: 'x', name: 'X', visibility: 'private', workspaceIds: [], createdAt: '', updatedAt: '' }],
        activeMembraneId: 'x'
      })
    )
    const fresh = createMembraneManager(bus, dataDir)
    // No exception; membrane loads; the active field is just ignored.
    expect(fresh.listMembranes()).toHaveLength(1)
    expect((fresh as any).getActive).toBeUndefined()
  })

  it('tolerates a hand-edited file missing `version`', () => {
    const file = path.join(dataDir, 'membranes.json')
    fs.writeFileSync(
      file,
      JSON.stringify(
        { membranes: [{ id: 'x', name: 'X', visibility: 'private', workspaceIds: [], createdAt: '', updatedAt: '' }] },
        null,
        2
      )
    )
    const fresh = createMembraneManager(bus, dataDir)
    expect(fresh.listMembranes()).toHaveLength(1)
  })

  it('returns empty data when file is corrupt JSON', () => {
    const file = path.join(dataDir, 'membranes.json')
    fs.writeFileSync(file, 'not-json{{{')
    const store = createMembraneStore(dataDir)
    expect(store.read().membranes).toEqual([])
  })
})

// ──────────────────────────────────────────────────────────────────────
// §Membranes — Context rendering (CONTEXT.md → appendSystemPrompt)
//
// Per-membrane context is the third layer of agent personality. The
// global personality (~/.claude/CLAUDE.md) covers identity + general
// principles. Each membrane's CONTEXT.md adds project-specific framing
// — "what is this membrane about, what are we trying to do here." Read
// at session creation, passed through to the SDK as appendSystemPrompt.
//
// Threads with no membrane (or a membrane without a CONTEXT.md file)
// silently get no extra context — by design. The global personality
// alone is sufficient; per-membrane context is opt-in.
describe('§Membranes — renderContext', () => {
  function withMembraneDir(): { membraneDir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'membrane-content-'))
    return { membraneDir: dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
  }

  it('returns null when the membrane id is unknown', () => {
    expect(manager.renderContext('does-not-exist')).toBeNull()
  })

  it('returns null when the membrane has no contentPath', () => {
    manager.createMembrane({ id: 'x', name: 'X' })
    expect(manager.renderContext('x')).toBeNull()
  })

  it('returns null when contentPath exists but CONTEXT.md does not', () => {
    const { membraneDir, cleanup } = withMembraneDir()
    try {
      manager.createMembrane({ id: 'x', name: 'X', contentPath: membraneDir })
      expect(manager.renderContext('x')).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('reads CONTEXT.md and returns its contents verbatim', () => {
    const { membraneDir, cleanup } = withMembraneDir()
    const body = '# ADAM\n\nWorking on AD4M Layer protocol.\n'
    try {
      fs.writeFileSync(path.join(membraneDir, MEMBRANE_CONTEXT_FILENAME), body)
      manager.createMembrane({ id: 'adam', name: 'ADAM', contentPath: membraneDir })
      expect(manager.renderContext('adam')).toBe(body)
    } finally {
      cleanup()
    }
  })

  it('caches by mtime — repeated reads do NOT re-stat-then-read when unchanged', () => {
    const { membraneDir, cleanup } = withMembraneDir()
    const file = path.join(membraneDir, MEMBRANE_CONTEXT_FILENAME)
    try {
      fs.writeFileSync(file, 'first')
      // Pin to a whole-second mtime so sub-second precision doesn't
      // sabotage the restore step below. `fs.utimesSync` rounds to
      // seconds on macOS so this is the only safe way to compare.
      const frozen = new Date(Math.floor(Date.now() / 1000) * 1000)
      fs.utimesSync(file, frozen, frozen)

      manager.createMembrane({ id: 'x', name: 'X', contentPath: membraneDir })
      const first = manager.renderContext('x')

      // Mutate the file underneath without bumping mtime — cache should
      // win and we still see the original body.
      fs.writeFileSync(file, 'second-but-mtime-frozen')
      fs.utimesSync(file, frozen, frozen) // restore exact mtime
      expect(manager.renderContext('x')).toBe(first)
    } finally {
      cleanup()
    }
  })

  it('picks up new file contents when mtime changes', async () => {
    const { membraneDir, cleanup } = withMembraneDir()
    const file = path.join(membraneDir, MEMBRANE_CONTEXT_FILENAME)
    try {
      fs.writeFileSync(file, 'v1')
      manager.createMembrane({ id: 'x', name: 'X', contentPath: membraneDir })
      expect(manager.renderContext('x')).toBe('v1')
      // Ensure mtime actually advances on filesystems with low-res timestamps.
      await new Promise((r) => setTimeout(r, 20))
      fs.writeFileSync(file, 'v2')
      expect(manager.renderContext('x')).toBe('v2')
    } finally {
      cleanup()
    }
  })

  it('invalidateContext drops the cached body', () => {
    const { membraneDir, cleanup } = withMembraneDir()
    const file = path.join(membraneDir, MEMBRANE_CONTEXT_FILENAME)
    try {
      const frozen = new Date(Math.floor(Date.now() / 1000) * 1000)
      fs.writeFileSync(file, 'v1')
      fs.utimesSync(file, frozen, frozen)
      manager.createMembrane({ id: 'x', name: 'X', contentPath: membraneDir })
      expect(manager.renderContext('x')).toBe('v1')
      // Mutate the file and freeze mtime — without invalidation, cache wins.
      fs.writeFileSync(file, 'v2')
      fs.utimesSync(file, frozen, frozen)
      manager.invalidateContext('x')
      expect(manager.renderContext('x')).toBe('v2')
    } finally {
      cleanup()
    }
  })

  it('invalidateContext() with no arg clears all entries', () => {
    const a = withMembraneDir()
    const b = withMembraneDir()
    try {
      fs.writeFileSync(path.join(a.membraneDir, MEMBRANE_CONTEXT_FILENAME), 'A')
      fs.writeFileSync(path.join(b.membraneDir, MEMBRANE_CONTEXT_FILENAME), 'B')
      manager.createMembrane({ id: 'a', name: 'A', contentPath: a.membraneDir })
      manager.createMembrane({ id: 'b', name: 'B', contentPath: b.membraneDir })
      manager.renderContext('a')
      manager.renderContext('b')
      manager.invalidateContext()
      // After clear, both reads still work — just from disk.
      expect(manager.renderContext('a')).toBe('A')
      expect(manager.renderContext('b')).toBe('B')
    } finally {
      a.cleanup()
      b.cleanup()
    }
  })

  it('membrane.updated bus event invalidates the cached context', async () => {
    const { membraneDir, cleanup } = withMembraneDir()
    const file = path.join(membraneDir, MEMBRANE_CONTEXT_FILENAME)
    try {
      const frozen = new Date(Math.floor(Date.now() / 1000) * 1000)
      fs.writeFileSync(file, 'before-rename')
      fs.utimesSync(file, frozen, frozen)
      manager.createMembrane({ id: 'x', name: 'X', contentPath: membraneDir })
      expect(manager.renderContext('x')).toBe('before-rename')

      // Mutate file underneath, freezing mtime so cache would normally win.
      fs.writeFileSync(file, 'after-rename')
      fs.utimesSync(file, frozen, frozen)

      // Trigger membrane.updated — cache should drop.
      manager.updateMembrane('x', { name: 'X (renamed)' })
      expect(manager.renderContext('x')).toBe('after-rename')
    } finally {
      cleanup()
    }
  })

  it('membrane.deleted bus event invalidates the cached context', () => {
    const { membraneDir, cleanup } = withMembraneDir()
    const file = path.join(membraneDir, MEMBRANE_CONTEXT_FILENAME)
    try {
      fs.writeFileSync(file, 'body')
      manager.createMembrane({ id: 'x', name: 'X', contentPath: membraneDir })
      manager.renderContext('x')
      manager.deleteMembrane('x')
      // After delete, renderContext should return null (unknown id).
      expect(manager.renderContext('x')).toBeNull()
    } finally {
      cleanup()
    }
  })
})

describe('§Membranes — Bus events', () => {
  it('emits membrane.created on create', () => {
    manager.createMembrane({ id: 'x', name: 'X' })
    const created = events.find((e) => e.type === 'membrane.created')
    expect(created).toBeDefined()
    expect((created!.payload as any).id).toBe('x')
  })

  it('emits membrane.updated on update', () => {
    manager.createMembrane({ id: 'x', name: 'X' })
    events.length = 0
    manager.updateMembrane('x', { name: 'Y' })
    expect(events.some((e) => e.type === 'membrane.updated')).toBe(true)
  })

  it('emits membrane.deleted on delete', () => {
    manager.createMembrane({ id: 'x', name: 'X' })
    events.length = 0
    manager.deleteMembrane('x')
    expect(events.some((e) => e.type === 'membrane.deleted')).toBe(true)
  })

  it('emits membrane.workspace.added / removed', () => {
    manager.createMembrane({ id: 'x', name: 'X' })
    events.length = 0
    manager.addWorkspace('x', 'org-a')
    manager.removeWorkspace('x', 'org-a')
    expect(events.map((e) => e.type)).toContain('membrane.workspace.added')
    expect(events.map((e) => e.type)).toContain('membrane.workspace.removed')
  })

  it('does NOT re-emit workspace.added when org already present', () => {
    manager.createMembrane({ id: 'x', name: 'X', workspaceIds: ['org-a'] })
    events.length = 0
    manager.addWorkspace('x', 'org-a')
    expect(events.filter((e) => e.type === 'membrane.workspace.added')).toHaveLength(0)
  })
})

describe('§Membranes — REST routes', () => {
  function app() {
    const a = express()
    a.use(express.json())
    a.use(
      '/api',
      createMembraneRoutes(manager, (_req, _res, next) => next())
    )
    return a
  }

  it('GET /api/membranes returns empty list initially', async () => {
    const res = await request(app()).get('/api/membranes')
    expect(res.status).toBe(200)
    expect(res.body.membranes).toEqual([])
    expect(res.body.active).toBeUndefined()
  })

  it('POST /api/membranes creates one', async () => {
    const res = await request(app()).post('/api/membranes').send({ name: 'Personal' })
    expect(res.status).toBe(201)
    expect(res.body.id).toBe('personal')
  })

  it('PUT /api/membranes/:id updates fields', async () => {
    manager.createMembrane({ id: 'x', name: 'X' })
    const res = await request(app()).put('/api/membranes/x').send({ visibility: 'public' })
    expect(res.status).toBe(200)
    expect(res.body.visibility).toBe('public')
  })

  it('DELETE /api/membranes/:id removes', async () => {
    manager.createMembrane({ id: 'x', name: 'X' })
    const res = await request(app()).delete('/api/membranes/x')
    expect(res.status).toBe(204)
    expect(manager.getMembrane('x')).toBeUndefined()
  })

  it('POST /api/membranes/:id/workspaces/:orgId adds workspace', async () => {
    manager.createMembrane({ id: 'x', name: 'X' })
    const res = await request(app()).post('/api/membranes/x/workspaces/org-a')
    expect(res.status).toBe(200)
    expect(res.body.workspaceIds).toEqual(['org-a'])
  })

  it('DELETE /api/membranes/:id/workspaces/:orgId removes workspace', async () => {
    manager.createMembrane({ id: 'x', name: 'X', workspaceIds: ['org-a'] })
    const res = await request(app()).delete('/api/membranes/x/workspaces/org-a')
    expect(res.status).toBe(200)
    expect(res.body.workspaceIds).toEqual([])
  })

  it('returns 404 on unknown membrane', async () => {
    const res = await request(app()).get('/api/membranes/nope')
    expect(res.status).toBe(404)
  })
})
