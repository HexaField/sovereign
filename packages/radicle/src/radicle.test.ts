import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { EventBus, BusEvent } from '@sovereign/core'

vi.mock('./cli.js', () => ({
  isRadAvailable: vi.fn(),
  radStatus: vi.fn(),
  radInit: vi.fn(),
  radPush: vi.fn(),
  radPull: vi.fn(),
  radClone: vi.fn(),
  radSeed: vi.fn(),
  radUnseed: vi.fn(),
  radListRepos: vi.fn(),
  radListPeers: vi.fn(),
  radConnectPeer: vi.fn(),
  radGetIdentity: vi.fn(),
  radCreateIdentity: vi.fn()
}))

import * as cli from './cli.js'
import { createRadicleManager } from './radicle.js'

const mockedCli = vi.mocked(cli)

function makeBus(): EventBus & { events: BusEvent[] } {
  const events: BusEvent[] = []
  return {
    events,
    emit(e: BusEvent) {
      events.push(e)
    },
    on() {
      return () => {}
    },
    once() {
      return () => {}
    },
    async *replay() {},
    history() {
      return []
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedCli.isRadAvailable.mockResolvedValue(true)
})

describe('RadicleManager', () => {
  describe('CLI detection', () => {
    it('works when rad CLI is available', async () => {
      mockedCli.radStatus.mockResolvedValue({
        running: true,
        peers: 2,
        identity: { did: 'did:key:z1', nodeId: 'z1', alias: 'a' }
      })
      const bus = makeBus()
      const mgr = createRadicleManager(bus, '/tmp')
      const s = await mgr.getStatus()
      expect(s.running).toBe(true)
    })

    it('gracefully degrades with clear error when rad is not available', async () => {
      mockedCli.isRadAvailable.mockResolvedValue(false)
      const bus = makeBus()
      const mgr = createRadicleManager(bus, '/tmp')
      await expect(mgr.getStatus()).rejects.toThrow('Radicle CLI (rad) is not installed')
      await expect(mgr.listRepos()).rejects.toThrow('Radicle CLI (rad) is not installed')
      await expect(mgr.push('rid')).rejects.toThrow('Radicle CLI (rad) is not installed')
    })
  })

  describe('initRepo', () => {
    it('initializes a new Radicle repo and emits event', async () => {
      const info = { rid: 'rad:z1', name: 'test', defaultBranch: 'main', peers: [], delegates: [], seeding: false }
      mockedCli.radInit.mockResolvedValue(info)
      const bus = makeBus()
      const mgr = createRadicleManager(bus, '/tmp')
      const result = await mgr.initRepo('/path', { name: 'test', description: 'desc' })
      expect(result.rid).toBe('rad:z1')
      expect(mockedCli.radInit).toHaveBeenCalledWith('/path', { name: 'test', description: 'desc' })
      expect(bus.events.some((e) => e.type === 'radicle.repo.init')).toBe(true)
    })
  })

  describe('listRepos', () => {
    it('lists all Radicle repos', async () => {
      const repos = [{ rid: 'rad:z1', name: 'r1', defaultBranch: 'main', peers: [], delegates: [], seeding: false }]
      mockedCli.radListRepos.mockResolvedValue(repos)
      const bus = makeBus()
      const mgr = createRadicleManager(bus, '/tmp')
      const result = await mgr.listRepos()
      expect(result).toEqual(repos)
    })
  })

  describe('push', () => {
    it('pushes and emits event', async () => {
      mockedCli.radPush.mockResolvedValue(undefined)
      const bus = makeBus()
      const mgr = createRadicleManager(bus, '/tmp')
      await mgr.push('rad:z1')
      expect(mockedCli.radPush).toHaveBeenCalledWith('rad:z1')
      expect(bus.events.some((e) => e.type === 'radicle.repo.pushed')).toBe(true)
    })
  })

  describe('pull', () => {
    it('pulls and emits event', async () => {
      mockedCli.radPull.mockResolvedValue(undefined)
      const bus = makeBus()
      const mgr = createRadicleManager(bus, '/tmp')
      await mgr.pull('rad:z1')
      expect(bus.events.some((e) => e.type === 'radicle.repo.pulled')).toBe(true)
    })
  })

  describe('clone', () => {
    it('clones and emits event', async () => {
      mockedCli.radClone.mockResolvedValue(undefined)
      const bus = makeBus()
      const mgr = createRadicleManager(bus, '/tmp')
      await mgr.clone('rad:z1', '/dest')
      expect(mockedCli.radClone).toHaveBeenCalledWith('rad:z1', '/dest')
      expect(bus.events.some((e) => e.type === 'radicle.repo.cloned')).toBe(true)
    })
  })

  describe('seed/unseed', () => {
    it('seeds a repo', async () => {
      mockedCli.radSeed.mockResolvedValue(undefined)
      const bus = makeBus()
      const mgr = createRadicleManager(bus, '/tmp')
      await mgr.seed('rad:z1')
      expect(mockedCli.radSeed).toHaveBeenCalledWith('rad:z1')
    })

    it('unseeds a repo', async () => {
      mockedCli.radUnseed.mockResolvedValue(undefined)
      const bus = makeBus()
      const mgr = createRadicleManager(bus, '/tmp')
      await mgr.unseed('rad:z1')
      expect(mockedCli.radUnseed).toHaveBeenCalledWith('rad:z1')
    })
  })

  describe('identity management', () => {
    it('gets current identity', async () => {
      const id = { did: 'did:key:z1', nodeId: 'z1', alias: 'bob' }
      mockedCli.radGetIdentity.mockResolvedValue(id)
      const bus = makeBus()
      const mgr = createRadicleManager(bus, '/tmp')
      expect(await mgr.getIdentity()).toEqual(id)
    })

    it('returns undefined when no identity exists', async () => {
      mockedCli.radGetIdentity.mockResolvedValue(undefined)
      const bus = makeBus()
      const mgr = createRadicleManager(bus, '/tmp')
      expect(await mgr.getIdentity()).toBeUndefined()
    })

    it('creates a new identity with alias', async () => {
      const id = { did: 'did:key:z2', nodeId: 'z2', alias: 'alice' }
      mockedCli.radCreateIdentity.mockResolvedValue(id)
      const bus = makeBus()
      const mgr = createRadicleManager(bus, '/tmp')
      const result = await mgr.createIdentity('alice')
      expect(result.alias).toBe('alice')
    })
  })

  describe('peer discovery', () => {
    it('lists known peers', async () => {
      const peers = [{ nodeId: 'z1', state: 'connected' as const }]
      mockedCli.radListPeers.mockResolvedValue(peers)
      const bus = makeBus()
      const mgr = createRadicleManager(bus, '/tmp')
      expect(await mgr.listPeers()).toEqual(peers)
    })

    it('connects to a peer and emits event', async () => {
      mockedCli.radConnectPeer.mockResolvedValue(undefined)
      const bus = makeBus()
      const mgr = createRadicleManager(bus, '/tmp')
      await mgr.connectPeer('z1', '1.2.3.4:8776')
      expect(mockedCli.radConnectPeer).toHaveBeenCalledWith('z1', '1.2.3.4:8776')
      expect(bus.events.some((e) => e.type === 'radicle.peer.connected')).toBe(true)
    })
  })

  describe('getStatus', () => {
    it('returns running state, identity, and peer count', async () => {
      mockedCli.radStatus.mockResolvedValue({
        running: true,
        identity: { did: 'did:key:z1', nodeId: 'z1', alias: 'a' },
        peers: 5
      })
      const bus = makeBus()
      const mgr = createRadicleManager(bus, '/tmp')
      const s = await mgr.getStatus()
      expect(s.running).toBe(true)
      expect(s.peers).toBe(5)
    })

    it('returns running: false when node is not running', async () => {
      mockedCli.radStatus.mockResolvedValue({ running: false, peers: 0 })
      const bus = makeBus()
      const mgr = createRadicleManager(bus, '/tmp')
      const s = await mgr.getStatus()
      expect(s.running).toBe(false)
    })
  })

  describe('status()', () => {
    it('returns module status', () => {
      const bus = makeBus()
      const mgr = createRadicleManager(bus, '/tmp')
      expect(mgr.status()).toEqual({ name: 'radicle', status: 'ok' })
    })
  })
})
