// Radicle Repo Management — Types

export interface RadicleRepoInfo {
  rid: string
  name: string
  description?: string
  defaultBranch: string
  peers: RadiclePeer[]
  delegates: string[]
  seeding: boolean
  lastSynced?: string
}

export interface RadiclePeer {
  nodeId: string
  alias?: string
  address?: string
  state: 'connected' | 'disconnected'
  lastSeen?: string
}

export interface RadicleIdentity {
  did: string
  alias?: string
  nodeId: string
}

export interface RadicleManager {
  getStatus(): Promise<{ running: boolean; identity?: RadicleIdentity; peers: number }>
  initRepo(path: string, opts?: { name?: string; description?: string }): Promise<RadicleRepoInfo>
  listRepos(): Promise<RadicleRepoInfo[]>
  push(rid: string): Promise<void>
  pull(rid: string): Promise<void>
  clone(rid: string, path: string): Promise<void>
  seed(rid: string): Promise<void>
  unseed(rid: string): Promise<void>
  listPeers(): Promise<RadiclePeer[]>
  connectPeer(nodeId: string, address?: string): Promise<void>
  getIdentity(): Promise<RadicleIdentity | undefined>
  createIdentity(alias: string): Promise<RadicleIdentity>
}
