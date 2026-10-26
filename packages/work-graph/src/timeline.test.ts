// The forge → timeline path: a sync emits `forge.events` with the events it
// admitted (after forge.trustedAuthors and triage), and the timeline turns
// that into one "sync brought N" line plus one line per event worth it.
// Made-up repos and logins only.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEventBus, trustedAuthorsOf, type BusEvent, type EventBus, type TimelineEntry } from '@sovereign/core'
import { createTimelineService, type TimelineService } from '@sovereign/timeline'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ScopeSource } from './scope.js'
import { createForgeService, type ForgeService } from './service.js'
import { change, createFakeForge, createTestTaskPort, issue, type FakeForge, type TestTaskPort } from './testing.js'
import { trusts } from './trust.js'
import type { ForgeConfig } from './types.js'

const WIDGET = 'acme-labs/widget'
const NOW = Date.parse('2026-10-16T12:00:00Z')
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString()
const flush = () => new Promise((r) => setTimeout(r, 10))

describe('forge → timeline', () => {
  let tmp: string
  let forge: FakeForge
  let port: TestTaskPort
  let bus: EventBus
  let service: ForgeService
  let timeline: TimelineService
  let now: number
  let config: Partial<ForgeConfig>
  let busEvents: BusEvent[]

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-timeline-'))
    now = NOW
    forge = createFakeForge()
    port = createTestTaskPort(path.join(tmp, 'tasks'))
    bus = createEventBus(path.join(tmp, 'bus'))
    busEvents = []
    bus.on('forge.events', (e) => void busEvents.push(e))
    const membranes = [{ id: 'acme', workspaceIds: [] }]
    const scope: ScopeSource = {
      getMembrane: (id) => membranes.find((m) => m.id === id),
      listMembranes: () => membranes,
      getOrg: () => undefined,
      listProjects: () => []
    }
    config = { enabled: true, identities: { github: 'hex-agent' }, repos: { acme: [WIDGET] } }
    forge.put(change(WIDGET, 50, { author: 'alex-dev', updatedAt: daysAgo(1), title: 'Stream teeth' }))
    forge.put(change(WIDGET, 66, { author: 'drive-by', updatedAt: daysAgo(1), title: 'Bump CI actions' }))
    forge.put(issue(WIDGET, 7, { author: 'sam-reporter', updatedAt: daysAgo(2), title: 'Gear slips' }))
    service = createForgeService({
      dataDir: path.join(tmp, 'data'),
      config: () => config,
      scope,
      forgeRegistry: { forgeFor: () => forge },
      tasks: port,
      bus,
      threads: {
        createThread: async () => 'new-thread',
        sendToThread: async () => undefined,
        presence: () => ({ label: 'T', status: 'idle' })
      },
      now: () => now,
      log: () => {}
    })
    timeline = createTimelineService({ bus, dataDir: path.join(tmp, 'data'), labelOf: () => undefined, now: () => now })
    timeline.start()
  })
  afterEach(() => {
    timeline.stop()
    service.stop()
    port.dispose()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const lines = (): TimelineEntry[] =>
    timeline
      .query({ kinds: ['forge', 'github'] })
      .entries.slice()
      .reverse()
  const later = () => {
    now += 60_000
    return new Date(now).toISOString()
  }

  it('a sync that admitted N events: one "sync brought N" line and one line per event worth it', async () => {
    await service.sync('acme')
    await flush()
    const baseline = lines().length
    const at = later()
    forge.put(
      change(WIDGET, 50, { author: 'alex-dev', updatedAt: at, title: 'Stream teeth', checks: { state: 'failing' } })
    )
    forge.put(change(WIDGET, 51, { author: 'alex-dev', updatedAt: at, title: 'Gear ratio' }))
    forge.put(issue(WIDGET, 7, { author: 'sam-reporter', updatedAt: at, title: 'Gear slips', state: 'closed' }))
    await service.sync('acme')
    await flush()

    const admitted = service.events('acme').filter((e) => Date.parse(e.at) >= Date.parse(at))
    expect(admitted.length).toBeGreaterThan(0)
    const emitted = busEvents[busEvents.length - 1]!.payload as {
      membrane: string
      via: string
      count: number
      events: unknown[]
    }
    expect(emitted).toMatchObject({ membrane: 'acme', via: 'sync', count: admitted.length })
    expect(emitted.events).toHaveLength(admitted.length)

    const fresh = lines().slice(baseline)
    expect(fresh[0]).toMatchObject({
      kind: 'forge',
      action: 'forge.sync',
      title: `Forge sync: ${admitted.length} new event${admitted.length === 1 ? '' : 's'} in acme`,
      membrane: 'acme'
    })
    const titles = fresh.slice(1).map((e) => e.title)
    expect(titles).toContain('PR opened: acme-labs/widget#51 Gear ratio')
    expect(titles).toContain('CI failed: acme-labs/widget#50 Stream teeth')
    expect(titles).toContain('Issue closed: acme-labs/widget#7 Gear slips')
    expect(fresh.find((e) => e.title.startsWith('CI failed'))).toMatchObject({
      kind: 'github',
      url: expect.stringContaining('acme-labs/widget')
    })
  })

  it("an untrusted author's item yields nothing", async () => {
    config.trustedAuthors = { acme: ['alex-dev', 'sam-reporter'] }
    // The fixture's list, resolved as the forge resolves it: drive-by is outside it.
    const ok = trusts(trustedAuthorsOf(config.trustedAuthors, 'acme'))
    expect([ok('Alex-Dev'), ok('sam-reporter'), ok('drive-by')]).toEqual([true, true, false])
    await service.sync('acme')
    await flush()
    const baseline = lines().length
    const at = later()
    forge.put(
      change(WIDGET, 66, { author: 'drive-by', updatedAt: at, title: 'Bump CI actions', checks: { state: 'failing' } })
    )
    forge.put(change(WIDGET, 67, { author: 'drive-by', updatedAt: at, title: 'Run this script' }))
    forge.put(issue(WIDGET, 8, { author: 'drive-by', updatedAt: at, title: 'Another script' }))
    await service.sync('acme')
    await flush()
    expect(lines().slice(baseline)).toEqual([])
    const all = JSON.stringify([...timeline.query({}).entries, ...busEvents])
    expect(all).not.toMatch(/drive-by|Bump CI actions|Run this script|Another script/)
  })

  it('a comment that needs an agent reaches the timeline without its text', async () => {
    await service.sync('acme')
    await service.assign({ membrane: 'acme', nodeId: `github:github.com/${WIDGET}#50`, threadId: 'th-1' })
    later()
    await service.sync('acme')
    await flush()
    const baseline = lines().length
    forge.commentsOf.set(`${WIDGET}#50`, [
      { author: 'alex-dev', body: '@hex-agent please rebase the private thing', createdAt: new Date(now).toISOString() }
    ])
    forge.put(change(WIDGET, 50, { author: 'alex-dev', title: 'Stream teeth', updatedAt: later() }))
    await service.sync('acme')
    await flush()
    const fresh = lines().slice(baseline)
    expect(fresh.find((e) => e.action === 'forge.commented')).toMatchObject({
      title: 'Comments need an agent: acme-labs/widget#50 Stream teeth',
      detail: '1 new by alex-dev'
    })
    expect(JSON.stringify(timeline.query({}).entries)).not.toContain('private thing')
    expect(JSON.stringify(busEvents)).not.toContain('private thing')
  })
})
