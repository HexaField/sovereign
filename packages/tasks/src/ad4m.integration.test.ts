// Opt-in integration test against a real AD4M executor.
//
//   SOVEREIGN_AD4M_IT=1 \
//   SOVEREIGN_AD4M_HOST=http://127.0.0.1:12000 \
//   SOVEREIGN_AD4M_TOKEN_FILE=<data dir>/ad4m-token.json \
//   pnpm --filter @sovereign/tasks test
//
// It creates its own perspective (sovereign-forge-it-<random>), writes and
// reads tasks, views and edges through it, then removes that perspective.
// Skipped unless SOVEREIGN_AD4M_IT=1 and the executor answers.

import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Ad4mClient } from '@coasys/ad4m'
import type { Ad4mClientManager } from '@sovereign/ad4m'
import { createForgePerspective } from './ad4m-perspective.js'
import { createForgeMetaStore } from './meta.js'
import { createResilientTaskStore } from './store.js'
import { createTaskService } from './service.js'
import { cleanupTempDirs, makeBus, quietLog, tempDir, until } from './testing/helpers.js'

const enabled = process.env.SOVEREIGN_AD4M_IT === '1'
const host = process.env.SOVEREIGN_AD4M_HOST ?? 'http://127.0.0.1:12000'
const tokenFile = process.env.SOVEREIGN_AD4M_TOKEN_FILE

function readToken(): string | undefined {
  if (!tokenFile) return undefined
  try {
    return (JSON.parse(fs.readFileSync(tokenFile, 'utf-8')) as { token?: string }).token
  } catch {
    return undefined
  }
}

let client: Ad4mClient | null = null
let reachable = false

beforeAll(async () => {
  if (!enabled) return
  client = new Ad4mClient(host, readToken())
  try {
    await Promise.race([client.agent.status(), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 5000))])
    reachable = true
  } catch (err) {
    reachable = false
    console.warn(`[ad4m-it] executor at ${host} unreachable, skipping: ${(err as Error)?.message}`)
  }
})

const name = `sovereign-forge-it-${randomUUID().slice(0, 8)}`

afterAll(async () => {
  if (client && reachable) {
    const all = await client.perspective.all()
    for (const p of all.filter((x) => x.name === name)) await client.perspective.remove(p.uuid)
  }
  client?.close()
  cleanupTempDirs()
})

function manager(): Ad4mClientManager {
  return {
    getClient: () => client,
    isConnected: () => reachable,
    setToken() {},
    close() {},
    onConnected: () => () => {}
  }
}

describe.runIf(enabled)('AD4M integration (real executor)', () => {
  it('writes and reads tasks, streams, links, views and edges through the perspective', async (ctx) => {
    if (!reachable) ctx.skip()
    const dir = tempDir()
    const fp = createForgePerspective({ ad4m: manager(), dataDir: dir, name, log: quietLog() })
    const store = createResilientTaskStore({ dir, connect: () => fp.connect(), snapshotDelayMs: 1, log: quietLog() })
    await store.settled()
    expect(store.status().backend).toBe('connected')

    const svc = createTaskService({ store, bus: makeBus().bus })
    const stream = await svc.createStream({ name: 'IT stream', membrane: 'it-membrane', sourceThreadId: 'it' })
    const { task: pr } = await svc.ensureTask('github:github.com/example-org/example-repo#7', {
      name: 'PR #7: ünïcode & "quotes" / slashes',
      description: 'line one\nline two',
      tags: ['it', 'forge'],
      membrane: 'it-membrane',
      parentTaskIds: [stream.id],
      sourceThreadId: 'it',
      provider: {
        kind: 'change',
        refs: [{ forge: 'github', host: 'github.com', repo: 'example-org/example-repo', kind: 'change', id: '7' }],
        url: 'https://github.com/example-org/example-repo/pull/7',
        status: 'open',
        checksStatus: 'pending',
        reviewDecision: 'unknown',
        unresolvedComments: 0,
        lastPolledAt: '2026-10-16T00:00:00.000Z'
      }
    })
    await svc.update(pr.id, {
      state: 'in_progress',
      threadId: 'thread-it',
      transientState: 'CI pending',
      sourceThreadId: 'it'
    })
    await until(() => store.status().pending === 0, 30_000)

    const meta = createForgeMetaStore({ dir, connect: () => fp.connect(), snapshotDelayMs: 1, log: quietLog() })
    await meta.settled()
    const view = meta.saveView({ membrane: 'it-membrane', title: 'IT view', repos: ['example-org/example-repo'] })
    const edge = meta.addEdge({ from: `task:${pr.id}`, to: 'plan:it/plans/x.md', reason: 'test', source: 'rethink' })
    await until(() => meta.status().pending === 0, 30_000)

    // A second store with an empty data dir loads it all back from AD4M.
    const dir2 = tempDir()
    const fp2 = createForgePerspective({ ad4m: manager(), dataDir: dir2, name, log: quietLog() })
    const reread = createResilientTaskStore({ dir: dir2, connect: () => fp2.connect(), log: quietLog() })
    await reread.settled()
    expect(reread.status().loadedFromBackend).toBe(true)
    const got = await reread.get(pr.id)
    expect(got).toMatchObject({
      name: 'PR #7: ünïcode & "quotes" / slashes',
      description: 'line one\nline two',
      state: 'in_progress',
      threadId: 'thread-it',
      transientState: 'CI pending',
      membrane: 'it-membrane',
      isStream: false,
      provider: { kind: 'change', status: 'open' }
    })
    expect(got!.tags.sort()).toEqual(['forge', 'it'])
    expect(got!.parentTasks.map((p) => p.id)).toEqual([stream.id])
    expect((await reread.get(stream.id))!.isStream).toBe(true)

    const meta2 = createForgeMetaStore({ dir: dir2, connect: () => fp2.connect(), log: quietLog() })
    await meta2.settled()
    expect(meta2.getView(view.id)).toEqual(view)
    expect(meta2.listEdges()).toEqual([edge])

    store.dispose()
    meta.dispose()
    reread.dispose()
    meta2.dispose()
  }, 60_000)
})
