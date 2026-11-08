// Ad4mClientManager recovery: an SDK client that stops answering (as it does
// after the executor was down) is replaced, and the manager reconnects.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createAd4mClientManager } from './client.js'

type Behaviour = 'hang' | 'fail' | 'ok'

function fakeFactory(behaviours: Behaviour[]) {
  const made: Array<{ token?: string; closed: boolean }> = []
  const createClient = (_host: string, token?: string) => {
    const behaviour = behaviours[Math.min(made.length, behaviours.length - 1)]
    const rec = { token, closed: false }
    made.push(rec)
    return {
      agent: {
        status: () =>
          behaviour === 'ok'
            ? Promise.resolve({ did: 'did:key:alex' })
            : behaviour === 'fail'
              ? Promise.reject(new Error('connect ECONNREFUSED'))
              : new Promise(() => {})
      },
      close() {
        rec.closed = true
      }
    } as never
  }
  return { createClient, made }
}

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

function tokenFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-ad4m-client-'))
  dirs.push(dir)
  const file = path.join(dir, 'ad4m-token.json')
  fs.writeFileSync(file, JSON.stringify({ token: 'jwt-1' }))
  return file
}

describe('Ad4mClientManager', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('connects and fires onConnected', async () => {
    vi.useFakeTimers()
    const f = fakeFactory(['ok'])
    const m = createAd4mClientManager({ host: 'ws://ad4m:12000', tokenFile: tokenFile(), createClient: f.createClient })
    const cb = vi.fn()
    m.onConnected(cb)
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.isConnected()).toBe(true)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(f.made[0].token).toBe('jwt-1')
    m.close()
  })

  it('replaces a client whose health check never answers, then reconnects', async () => {
    vi.useFakeTimers()
    const f = fakeFactory(['hang', 'ok'])
    const m = createAd4mClientManager({
      host: 'http://ad4m:12000',
      tokenFile: tokenFile(),
      healthIntervalMs: 5000,
      statusTimeoutMs: 2000,
      createClient: f.createClient
    })
    const cb = vi.fn()
    m.onConnected(cb)
    const first = m.getClient()
    await vi.advanceTimersByTimeAsync(1000 + 2000) // first check times out
    expect(m.isConnected()).toBe(false)
    expect(f.made[0].closed).toBe(true)
    expect(m.getClient()).not.toBe(first)
    expect(f.made[1].token).toBe('jwt-1')

    await vi.advanceTimersByTimeAsync(5000) // next check, on the fresh client
    expect(m.isConnected()).toBe(true)
    expect(cb).toHaveBeenCalledTimes(1)
    m.close()
  })

  it('goes down on a failed check and comes back with a new client', async () => {
    vi.useFakeTimers()
    const f = fakeFactory(['ok', 'ok'])
    const m = createAd4mClientManager({
      host: 'http://ad4m:12000',
      tokenFile: tokenFile(),
      healthIntervalMs: 5000,
      createClient: f.createClient
    })
    const cb = vi.fn()
    m.onConnected(cb)
    await vi.advanceTimersByTimeAsync(1000)
    expect(m.isConnected()).toBe(true)

    // The executor stops: the current client's calls fail.
    ;(m.getClient() as any).agent.status = () => Promise.reject(new Error('socket closed'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(m.isConnected()).toBe(false)
    expect(f.made).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(5000)
    expect(m.isConnected()).toBe(true)
    expect(cb).toHaveBeenCalledTimes(2)
    m.close()
  })
})
