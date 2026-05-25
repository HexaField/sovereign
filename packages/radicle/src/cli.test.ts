import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock at the module level before imports
vi.mock('node:child_process', () => ({
  execFile: vi.fn()
}))

import { execFile } from 'node:child_process'
import {
  isRadAvailable,
  radStatus,
  radInit,
  radPush,
  radPull,
  radClone,
  radSeed,
  radUnseed,
  radListRepos,
  radListPeers,
  radConnectPeer,
  radGetIdentity,
  radCreateIdentity
} from './cli.js'

const mockedExecFile = vi.mocked(execFile)

function setupMock(fn: (cmd: string, args: string[], opts: any) => { stdout: string; stderr: string } | Error) {
  mockedExecFile.mockImplementation((cmd: any, args: any, opts: any, cb?: any) => {
    const callback = typeof opts === 'function' ? opts : cb
    try {
      const result = fn(cmd, args, typeof opts === 'function' ? undefined : opts)
      if (result instanceof Error) {
        callback(result, '', (result as any).stderr || '')
      } else {
        callback(null, result.stdout, result.stderr)
      }
    } catch (e: any) {
      e.stderr = e.stderr ?? ''
      callback(e, '', e.stderr)
    }
    return undefined as any
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('isRadAvailable', () => {
  it('returns true when rad CLI is installed', async () => {
    setupMock(() => ({ stdout: 'rad 0.9.0', stderr: '' }))
    expect(await isRadAvailable()).toBe(true)
  })

  it('returns false when rad CLI is not found', async () => {
    setupMock(() => {
      throw Object.assign(new Error('ENOENT'), { stderr: '' })
    })
    expect(await isRadAvailable()).toBe(false)
  })
})

describe('radStatus', () => {
  it('returns identity and running state', async () => {
    setupMock((_cmd, args) => {
      if (args[0] === 'self') {
        return { stdout: 'DID did:key:z6Mktest123\nNode ID z6Mknode456\nAlias alice', stderr: '' }
      }
      if (args[0] === 'node' && args[1] === 'status') {
        return { stdout: '3 peers connected', stderr: '' }
      }
      throw new Error('unexpected')
    })

    const result = await radStatus()
    expect(result.running).toBe(true)
    expect(result.identity?.did).toBe('did:key:z6Mktest123')
    expect(result.identity?.nodeId).toBe('z6Mknode456')
    expect(result.identity?.alias).toBe('alice')
    expect(result.peers).toBe(3)
  })

  it('returns running: false when node status fails', async () => {
    setupMock((_cmd, args) => {
      if (args[0] === 'self') {
        return { stdout: 'DID did:key:z6Mktest123\nNode ID z6Mknode456', stderr: '' }
      }
      throw Object.assign(new Error('not running'), { stderr: 'node not running' })
    })

    const result = await radStatus()
    expect(result.running).toBe(false)
    expect(result.identity?.did).toBe('did:key:z6Mktest123')
    expect(result.peers).toBe(0)
  })

  it('returns running: false with no identity when self fails', async () => {
    setupMock(() => {
      throw Object.assign(new Error('no identity'), { stderr: 'no identity' })
    })
    const result = await radStatus()
    expect(result.running).toBe(false)
    expect(result.identity).toBeUndefined()
    expect(result.peers).toBe(0)
  })
})

describe('radInit', () => {
  it('initializes a new repo and returns info', async () => {
    setupMock(() => ({ stdout: 'Initialized rad:z3gqcJUoA1 in /tmp/repo', stderr: '' }))
    const result = await radInit('/tmp/repo', { name: 'test', description: 'a test repo' })
    expect(result.rid).toBe('rad:z3gqcJUoA1')
    expect(result.name).toBe('test')
    expect(result.description).toBe('a test repo')
  })

  it('throws on failure', async () => {
    setupMock(() => {
      throw Object.assign(new Error('fail'), { stderr: 'git repo not found' })
    })
    await expect(radInit('/tmp/bad')).rejects.toThrow('rad init failed')
  })
})

describe('radPush', () => {
  it('pushes to radicle', async () => {
    setupMock(() => ({ stdout: 'ok', stderr: '' }))
    await radPush('rad:z123')
  })

  it('throws on error', async () => {
    setupMock(() => {
      throw Object.assign(new Error('fail'), { stderr: 'not a rad repo' })
    })
    await expect(radPush('rad:z123')).rejects.toThrow('rad push failed')
  })
})

describe('radPull', () => {
  it('pulls from radicle', async () => {
    setupMock(() => ({ stdout: 'ok', stderr: '' }))
    await radPull('rad:z123')
  })

  it('throws on error', async () => {
    setupMock(() => {
      throw Object.assign(new Error('fail'), { stderr: 'error' })
    })
    await expect(radPull('rad:z123')).rejects.toThrow('rad pull failed')
  })
})

describe('radClone', () => {
  it('clones a repo', async () => {
    setupMock(() => ({ stdout: 'ok', stderr: '' }))
    await radClone('rad:z123', '/tmp/dest')
  })

  it('throws on error', async () => {
    setupMock(() => {
      throw Object.assign(new Error('fail'), { stderr: 'not found' })
    })
    await expect(radClone('rad:z123', '/tmp/dest')).rejects.toThrow('rad clone failed')
  })
})

describe('radSeed', () => {
  it('seeds a repo', async () => {
    setupMock(() => ({ stdout: 'ok', stderr: '' }))
    await radSeed('rad:z123')
  })

  it('throws on error', async () => {
    setupMock(() => {
      throw Object.assign(new Error('fail'), { stderr: 'err' })
    })
    await expect(radSeed('rad:z123')).rejects.toThrow('rad seed failed')
  })
})

describe('radUnseed', () => {
  it('unseeds a repo', async () => {
    setupMock(() => ({ stdout: 'ok', stderr: '' }))
    await radUnseed('rad:z123')
  })

  it('throws on error', async () => {
    setupMock(() => {
      throw Object.assign(new Error('fail'), { stderr: 'err' })
    })
    await expect(radUnseed('rad:z123')).rejects.toThrow('rad unseed failed')
  })
})

describe('radListRepos', () => {
  it('lists repos', async () => {
    setupMock(() => ({ stdout: 'rad:z111 my-repo\nrad:z222 another', stderr: '' }))
    const repos = await radListRepos()
    expect(repos).toHaveLength(2)
    expect(repos[0].rid).toBe('rad:z111')
    expect(repos[0].name).toBe('my-repo')
  })

  it('returns empty array for empty output', async () => {
    setupMock(() => ({ stdout: '', stderr: '' }))
    const repos = await radListRepos()
    expect(repos).toEqual([])
  })
})

describe('radListPeers', () => {
  it('lists peers from node status', async () => {
    setupMock(() => ({
      stdout:
        'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK connected 1.2.3.4:8776\nz6MksFqXN3Eons9Pi85XhLEn6zzzzzzzzzzzzzzzzzzzzzzz disconnected',
      stderr: ''
    }))
    const peers = await radListPeers()
    expect(peers).toHaveLength(2)
    expect(peers[0].state).toBe('connected')
    expect(peers[0].address).toBe('1.2.3.4:8776')
    expect(peers[1].state).toBe('disconnected')
  })
})

describe('radConnectPeer', () => {
  it('connects to a peer', async () => {
    setupMock(() => ({ stdout: 'ok', stderr: '' }))
    await radConnectPeer('z6Mknode', '1.2.3.4:8776')
  })

  it('connects without address', async () => {
    setupMock(() => ({ stdout: 'ok', stderr: '' }))
    await radConnectPeer('z6Mknode')
  })
})

describe('radGetIdentity', () => {
  it('returns identity', async () => {
    setupMock(() => ({ stdout: 'DID did:key:z6Mktest\nNode ID z6Mknode\nAlias bob', stderr: '' }))
    const id = await radGetIdentity()
    expect(id?.did).toBe('did:key:z6Mktest')
    expect(id?.alias).toBe('bob')
  })

  it('returns undefined on failure', async () => {
    setupMock(() => {
      throw new Error('no identity')
    })
    const id = await radGetIdentity()
    expect(id).toBeUndefined()
  })
})

describe('radCreateIdentity', () => {
  it('creates identity', async () => {
    setupMock(() => ({ stdout: 'did:key:z6Mknew123\nNode ID z6Mknode789', stderr: '' }))
    const id = await radCreateIdentity('alice')
    expect(id.did).toBe('did:key:z6Mknew123')
    expect(id.alias).toBe('alice')
  })

  it('throws on failure', async () => {
    setupMock(() => {
      throw Object.assign(new Error('fail'), { stderr: 'already exists' })
    })
    await expect(radCreateIdentity('alice')).rejects.toThrow('rad auth failed')
  })
})
