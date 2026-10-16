// Test helpers for @sovereign/tasks: an event bus, a fake AD4M perspective
// that can be taken down, and temp data dirs. Not exported from the package.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { LinkGraph, LinkTriple } from '../link-graph.js'
import { createInMemoryLinkGraph } from '../link-graph.js'

export function makeBus() {
  const emitter = new EventEmitter()
  emitter.setMaxListeners(100)
  const events: Array<{ type: string; payload: unknown }> = []
  const bus = {
    emit(event: { type: string; timestamp: string; source: string; payload: unknown }) {
      events.push({ type: event.type, payload: event.payload })
      emitter.emit(event.type, event)
    },
    on(type: string, handler: (event: any) => void) {
      emitter.on(type, handler)
      return () => emitter.off(type, handler)
    },
    once(type: string, handler: (event: any) => void) {
      emitter.once(type, handler)
      return () => emitter.off(type, handler)
    },
    async *replay() {
      yield* []
    },
    history() {
      return []
    }
  }
  return { bus: bus as any, events }
}

/** A logger that records instead of printing. */
export function quietLog() {
  const lines: string[] = []
  const rec = (...args: unknown[]) => void lines.push(args.map(String).join(' '))
  return { log: rec, warn: rec, error: rec, lines }
}

const dirs: string[] = []

export function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-tasks-test-'))
  dirs.push(dir)
  return dir
}

/** Remove the temp dirs this test file created. Call from afterAll. */
export function cleanupTempDirs(): void {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
}

export class Ad4mDownError extends Error {
  constructor() {
    super('connect ECONNREFUSED 127.0.0.1:12000')
  }
}

/** A fake AD4M perspective: an in-memory link graph that can go down,
 *  hang, or fail a given number of mutations. Every mutation is recorded. */
export function createFakeAd4m(id = 'fake-perspective') {
  const graph = createInMemoryLinkGraph(id)
  const state = {
    down: false,
    /** Mutations that succeed before every later one hangs forever (a crash mid-replay). */
    hangAfter: Infinity,
    /** Reject the next N mutations while staying reachable (a poison op). */
    rejectNext: 0,
    mutations: 0,
    connects: 0
  }
  const reconnectCbs = new Set<() => void>()

  function check(): void {
    if (state.down) throw new Ad4mDownError()
  }

  const link: LinkGraph = {
    id,
    async all() {
      check()
      return graph.all()
    },
    async mutate(m) {
      check()
      if (state.mutations >= state.hangAfter) return new Promise<void>(() => {})
      if (state.rejectNext > 0) {
        state.rejectNext--
        throw new Error('invalid link target')
      }
      state.mutations++
      await graph.mutate(m)
    },
    async ping() {
      check()
    }
  }

  return {
    state,
    links: graph.links as LinkTriple[],
    async connect(): Promise<LinkGraph> {
      state.connects++
      check()
      return link
    },
    onReconnect(cb: () => void) {
      reconnectCbs.add(cb)
      return () => reconnectCbs.delete(cb)
    },
    /** Bring AD4M back and fire the reconnect callbacks. */
    up() {
      state.down = false
      for (const cb of reconnectCbs) cb()
    },
    down() {
      state.down = true
    },
    /** Count of links equal to a triple. */
    count(l: Partial<LinkTriple>): number {
      return graph.links.filter(
        (x) =>
          (l.source === undefined || x.source === l.source) &&
          (l.predicate === undefined || x.predicate === l.predicate) &&
          (l.target === undefined || x.target === l.target)
      ).length
    }
  }
}

export type FakeAd4m = ReturnType<typeof createFakeAd4m>

/** Wait until `cond` holds (polling), or fail after `ms`. */
export async function until(cond: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('condition not met in time')
}
