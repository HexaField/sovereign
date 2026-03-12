import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EventBus, BusEvent } from '@template/core'
import { createWorktreeStore } from './store.js'
import { createLinkManager } from './links.js'

let tmpDir: string
let events: BusEvent[]
let bus: EventBus

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'links-test-'))
  events = []
  bus = {
    emit: (e: BusEvent) => {
      events.push(e)
    },
    on: () => () => {},
    once: () => () => {},
    replay: () => (async function* () {})(),
    history: () => []
  }
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('Worktree Links', () => {
  it('creates a linked set across multiple projects', () => {
    const store = createWorktreeStore(tmpDir)
    const knownIds = new Set(['wt-1', 'wt-2'])
    const mgr = createLinkManager(bus, store, (id) => knownIds.has(id))
    const link = mgr.createLink('org1', { name: 'feature-x', worktreeIds: ['wt-1', 'wt-2'] })
    expect(link.name).toBe('feature-x')
    expect(link.worktreeIds).toEqual(['wt-1', 'wt-2'])
    expect(link.orgId).toBe('org1')
  })

  it('persists links to worktree-links.json', () => {
    const store = createWorktreeStore(tmpDir)
    const knownIds = new Set(['wt-1'])
    const mgr = createLinkManager(bus, store, (id) => knownIds.has(id))
    mgr.createLink('org1', { name: 'link1', worktreeIds: ['wt-1'] })
    const linksFile = path.join(tmpDir, 'orgs', 'org1', 'worktree-links.json')
    expect(fs.existsSync(linksFile)).toBe(true)
    const data = JSON.parse(fs.readFileSync(linksFile, 'utf-8'))
    expect(data).toHaveLength(1)
    expect(data[0].name).toBe('link1')
  })

  it('lists all links for an org', () => {
    const store = createWorktreeStore(tmpDir)
    const knownIds = new Set(['wt-1', 'wt-2'])
    const mgr = createLinkManager(bus, store, (id) => knownIds.has(id))
    mgr.createLink('org1', { name: 'a', worktreeIds: ['wt-1'] })
    mgr.createLink('org1', { name: 'b', worktreeIds: ['wt-2'] })
    expect(mgr.listLinks('org1')).toHaveLength(2)
  })

  it('gets a link by id', () => {
    const store = createWorktreeStore(tmpDir)
    const knownIds = new Set(['wt-1'])
    const mgr = createLinkManager(bus, store, (id) => knownIds.has(id))
    const link = mgr.createLink('org1', { name: 'x', worktreeIds: ['wt-1'] })
    const found = mgr.getLink('org1', link.id)
    expect(found).toBeDefined()
    expect(found!.id).toBe(link.id)
  })

  it('removes a link', () => {
    const store = createWorktreeStore(tmpDir)
    const knownIds = new Set(['wt-1'])
    const mgr = createLinkManager(bus, store, (id) => knownIds.has(id))
    const link = mgr.createLink('org1', { name: 'x', worktreeIds: ['wt-1'] })
    mgr.removeLink('org1', link.id)
    expect(mgr.listLinks('org1')).toHaveLength(0)
  })

  it('validates all referenced worktree ids exist', () => {
    const store = createWorktreeStore(tmpDir)
    const knownIds = new Set(['wt-1'])
    const mgr = createLinkManager(bus, store, (id) => knownIds.has(id))
    expect(() => mgr.createLink('org1', { name: 'bad', worktreeIds: ['wt-1', 'wt-missing'] })).toThrow(
      'Worktree not found: wt-missing'
    )
  })
})
