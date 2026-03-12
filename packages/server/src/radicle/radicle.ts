// Core Radicle manager — wraps CLI functions with bus event emission

import type { EventBus, ModuleStatus } from '@template/core'
import type { RadicleManager, RadicleRepoInfo, RadiclePeer, RadicleIdentity } from './types.js'
import * as cli from './cli.js'

export function createRadicleManager(bus: EventBus, _dataDir: string): RadicleManager & { status(): ModuleStatus } {
  function emitEvent(type: string, payload: unknown) {
    bus.emit({ type, timestamp: new Date().toISOString(), source: 'radicle', payload })
  }

  async function ensureAvailable() {
    if (!(await cli.isRadAvailable())) {
      throw new Error('Radicle CLI (rad) is not installed or not in PATH')
    }
  }

  const manager: RadicleManager & { status(): ModuleStatus } = {
    async getStatus() {
      await ensureAvailable()
      return cli.radStatus()
    },

    async initRepo(path: string, opts?: { name?: string; description?: string }): Promise<RadicleRepoInfo> {
      await ensureAvailable()
      const info = await cli.radInit(path, opts)
      emitEvent('radicle.repo.init', { rid: info.rid, path, ...opts })
      return info
    },

    async listRepos(): Promise<RadicleRepoInfo[]> {
      await ensureAvailable()
      return cli.radListRepos()
    },

    async push(rid: string): Promise<void> {
      await ensureAvailable()
      await cli.radPush(rid)
      emitEvent('radicle.repo.pushed', { rid })
    },

    async pull(rid: string): Promise<void> {
      await ensureAvailable()
      await cli.radPull(rid)
      emitEvent('radicle.repo.pulled', { rid })
    },

    async clone(rid: string, path: string): Promise<void> {
      await ensureAvailable()
      await cli.radClone(rid, path)
      emitEvent('radicle.repo.cloned', { rid, path })
    },

    async seed(rid: string): Promise<void> {
      await ensureAvailable()
      await cli.radSeed(rid)
    },

    async unseed(rid: string): Promise<void> {
      await ensureAvailable()
      await cli.radUnseed(rid)
    },

    async listPeers(): Promise<RadiclePeer[]> {
      await ensureAvailable()
      return cli.radListPeers()
    },

    async connectPeer(nodeId: string, address?: string): Promise<void> {
      await ensureAvailable()
      await cli.radConnectPeer(nodeId, address)
      emitEvent('radicle.peer.connected', { nodeId, address })
    },

    async getIdentity(): Promise<RadicleIdentity | undefined> {
      await ensureAvailable()
      return cli.radGetIdentity()
    },

    async createIdentity(alias: string): Promise<RadicleIdentity> {
      await ensureAvailable()
      return cli.radCreateIdentity(alias)
    },

    status(): ModuleStatus {
      return { name: 'radicle', status: 'ok' }
    }
  }

  return manager
}
