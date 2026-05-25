// rad CLI wrapper — low-level functions that exec `rad` commands and parse output

import { execFile as _execFile } from 'node:child_process'
import type { RadicleRepoInfo, RadiclePeer, RadicleIdentity } from './types.js'

export { _execFile as execFile }

function execAsync(cmd: string, args: string[], opts?: { cwd?: string }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    _execFile(cmd, args, opts ?? {}, (err, stdout, stderr) => {
      if (err) {
        ;(err as any).stderr = stderr
        reject(err)
      } else {
        resolve({ stdout: stdout as unknown as string, stderr: stderr as unknown as string })
      }
    })
  })
}

async function run(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execAsync('rad', args, cwd ? { cwd } : undefined)
    return (stdout ?? '').trim()
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string }
    const msg = (e.stderr ?? '').trim() || e.message || 'rad command failed'
    throw new Error(`rad ${args[0]} failed: ${msg}`)
  }
}

export async function isRadAvailable(): Promise<boolean> {
  try {
    await execAsync('rad', ['--version'])
    return true
  } catch {
    return false
  }
}

export async function radStatus(): Promise<{ running: boolean; identity?: RadicleIdentity; peers: number }> {
  try {
    const out = await run(['self'])
    // Parse "DID did:key:z... " line, "Node ID z..." line, "Alias ..." line
    const didMatch = out.match(/DID\s+(did:key:\S+)/)
    const nodeMatch = out.match(/Node ID\s+(\S+)/)
    const aliasMatch = out.match(/Alias\s+(.+)/)

    const identity: RadicleIdentity | undefined =
      didMatch && nodeMatch ? { did: didMatch[1], nodeId: nodeMatch[1], alias: aliasMatch?.[1]?.trim() } : undefined

    // Try to get peer count from node status
    let peers = 0
    try {
      const nodeOut = await run(['node', 'status'])
      const peerMatches = nodeOut.match(/(\d+)\s+peer/i)
      peers = peerMatches ? parseInt(peerMatches[1], 10) : 0
      return { running: true, identity, peers }
    } catch {
      return { running: false, identity, peers: 0 }
    }
  } catch {
    return { running: false, peers: 0 }
  }
}

export async function radInit(path: string, opts?: { name?: string; description?: string }): Promise<RadicleRepoInfo> {
  const args = ['init']
  if (opts?.name) args.push('--name', opts.name)
  if (opts?.description) args.push('--description', opts.description)

  const out = await run(args, path)
  // Parse RID from output like "Initialized rad:z..."
  const ridMatch = out.match(/(rad:\w+)/)
  const rid = ridMatch?.[1] ?? 'unknown'

  return {
    rid,
    name: opts?.name ?? '',
    description: opts?.description,
    defaultBranch: 'main',
    peers: [],
    delegates: [],
    seeding: false
  }
}

export async function radPush(rid: string): Promise<void> {
  await run(['push'], rid)
}

export async function radPull(rid: string): Promise<void> {
  await run(['pull'], rid)
}

export async function radClone(rid: string, path: string): Promise<void> {
  await run(['clone', rid, path])
}

export async function radSeed(rid: string): Promise<void> {
  await run(['seed', rid])
}

export async function radUnseed(rid: string): Promise<void> {
  await run(['unseed', rid])
}

export async function radListRepos(): Promise<RadicleRepoInfo[]> {
  const out = await run(['ls'])
  if (!out) return []

  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.trim().split(/\s+/)
      const rid = parts[0] ?? ''
      const name = parts.slice(1).join(' ') || rid
      return {
        rid,
        name,
        defaultBranch: 'main',
        peers: [],
        delegates: [],
        seeding: false
      }
    })
}

export async function radListPeers(): Promise<RadiclePeer[]> {
  const out = await run(['node', 'status'])
  const peers: RadiclePeer[] = []

  // Parse peer lines — format varies, look for node IDs (z-prefixed)
  const lines = out.split('\n')
  for (const line of lines) {
    const match = line.match(/(z[a-zA-Z0-9]{30,})/)
    if (match) {
      const addrMatch = line.match(/([\d.]+:\d+)/)
      const stateMatch = line.match(/(connected|disconnected)/i)
      peers.push({
        nodeId: match[1],
        address: addrMatch?.[1],
        state: stateMatch?.[1]?.toLowerCase() === 'connected' ? 'connected' : 'disconnected'
      })
    }
  }
  return peers
}

export async function radConnectPeer(nodeId: string, address?: string): Promise<void> {
  const args = ['node', 'connect', nodeId]
  if (address) args.push(address)
  await run(args)
}

export async function radGetIdentity(): Promise<RadicleIdentity | undefined> {
  try {
    const out = await run(['self'])
    const didMatch = out.match(/DID\s+(did:key:\S+)/)
    const nodeMatch = out.match(/Node ID\s+(\S+)/)
    const aliasMatch = out.match(/Alias\s+(.+)/)

    if (!didMatch || !nodeMatch) return undefined
    return {
      did: didMatch[1],
      nodeId: nodeMatch[1],
      alias: aliasMatch?.[1]?.trim()
    }
  } catch {
    return undefined
  }
}

export async function radCreateIdentity(alias: string): Promise<RadicleIdentity> {
  const out = await run(['auth', '--alias', alias])
  const didMatch = out.match(/(did:key:\S+)/)
  const nodeMatch = out.match(/Node ID\s+(\S+)/) ?? out.match(/(z\w{50,})/)

  if (!didMatch) throw new Error('Failed to parse identity DID from rad auth output')
  return {
    did: didMatch[1],
    nodeId: nodeMatch?.[1] ?? '',
    alias
  }
}
