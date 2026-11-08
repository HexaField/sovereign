// Presence role resolution: one live thread per role, through archive and restart.
//
// The thread manager here keeps the real one's rules (at most one live thread
// per role; archiving flags the thread and clears its role; state outlives a
// restart), so the presence module is tested against them without a build of
// @sovereign/threads.

import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createPresenceModule, type PresenceModule } from './module.js'

type Role = 'internal' | 'gateway'
interface Row {
  id: string
  label: string
  presence?: Role
  archived: boolean
}

function makeBus() {
  const emitter = new EventEmitter()
  return {
    emit(event: { type: string; [k: string]: unknown }) {
      emitter.emit(event.type, event)
    },
    on(type: string, handler: (event: { payload: unknown }) => void) {
      emitter.on(type, handler)
      return () => emitter.off(type, handler)
    }
  } as any
}

/** A thread manager over `store` (shared across "restarts"). */
function makeThreadManager(bus: any, store: Map<string, Row>) {
  let n = store.size
  const live = (role: Role) => [...store.values()].find((t) => t.presence === role && !t.archived) ?? null
  return {
    getPresenceThread: (role: Role) => live(role),
    get: (id: string) => store.get(id),
    create(opts: { label: string; presence?: Role }) {
      if (opts.presence && live(opts.presence)) throw new Error(`a '${opts.presence}' presence thread already exists`)
      const t: Row = { id: `thread-${++n}`, label: opts.label, presence: opts.presence, archived: false }
      store.set(t.id, t)
      bus.emit({ type: 'thread.created', payload: { thread: t } })
      return t
    },
    update(id: string, patch: { presence?: Role | null }) {
      const t = store.get(id)!
      if (patch.presence === null) delete t.presence
      else if (patch.presence) t.presence = patch.presence
      bus.emit({ type: 'thread.updated', payload: { threadId: id, patch } })
      return t
    },
    delete(id: string) {
      const t = store.get(id)
      if (!t) return false
      t.archived = true
      delete t.presence
      bus.emit({ type: 'thread.deleted', payload: { threadId: id } })
      return true
    }
  }
}

const dirs: string[] = []
const modules: PresenceModule[] = []

function boot(store: Map<string, Row>) {
  const bus = makeBus()
  const threadManager = makeThreadManager(bus, store)
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'presence-module-'))
  dirs.push(dataDir)
  const mod = createPresenceModule({
    bus,
    threadManager: threadManager as any,
    dataDir,
    chat: { postAssistantTurn: async () => {}, sendToThread: async () => {} }
  })
  modules.push(mod)
  return { bus, threadManager, mod }
}

const liveWithRole = (store: Map<string, Row>, role: Role) =>
  [...store.values()].filter((t) => t.presence === role && !t.archived)

afterEach(() => {
  for (const m of modules.splice(0)) m.dispose()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('presence module — role threads', () => {
  it('creates one thread per role on first boot', () => {
    const store = new Map<string, Row>()
    const { mod } = boot(store)
    expect(store.size).toBe(2)
    expect(store.get(mod.internalThreadId()!)?.presence).toBe('internal')
    expect(store.get(mod.gatewayThreadId()!)?.presence).toBe('gateway')
  })

  it('archiving the gateway thread puts a new one in its place at once, history kept', () => {
    const store = new Map<string, Row>()
    const { mod, threadManager } = boot(store)
    const before = mod.gatewayThreadId()!
    const internal = mod.internalThreadId()

    threadManager.delete(before)

    const after = mod.gatewayThreadId()
    expect(after).toBeTruthy()
    expect(after).not.toBe(before)
    expect(store.get(before)).toMatchObject({ archived: true })
    expect(store.get(before)?.presence).toBeUndefined()
    expect(liveWithRole(store, 'gateway').map((t) => t.id)).toEqual([after])
    // The other role is untouched.
    expect(mod.internalThreadId()).toBe(internal)
  })

  it('archiving the internal thread replaces it too', () => {
    const store = new Map<string, Row>()
    const { mod, threadManager } = boot(store)
    const before = mod.internalThreadId()!
    threadManager.delete(before)
    const after = mod.internalThreadId()
    expect(after).not.toBe(before)
    expect(liveWithRole(store, 'internal').map((t) => t.id)).toEqual([after])
  })

  it('never answers with a thread that lost its role, and does not create one while the role is being handed over', () => {
    const store = new Map<string, Row>()
    const { mod, threadManager } = boot(store)
    const old = mod.gatewayThreadId()!
    const other = threadManager.create({ label: 'other' })

    // Hand the role to another thread: clear it, then set it elsewhere.
    threadManager.update(old, { presence: null })
    threadManager.update(other.id, { presence: 'gateway' })

    expect(mod.gatewayThreadId()).toBe(other.id)
    expect(liveWithRole(store, 'gateway')).toHaveLength(1)
  })

  it('a restart reuses the live role threads: no duplicates, also after an archive', () => {
    const store = new Map<string, Row>()
    const first = boot(store)
    const internal = first.mod.internalThreadId()
    first.threadManager.delete(first.mod.gatewayThreadId()!)
    const gateway = first.mod.gatewayThreadId()
    first.mod.dispose()

    const second = boot(store)
    expect(second.mod.internalThreadId()).toBe(internal)
    expect(second.mod.gatewayThreadId()).toBe(gateway)
    expect(liveWithRole(store, 'internal')).toHaveLength(1)
    expect(liveWithRole(store, 'gateway')).toHaveLength(1)
    // Two first-boot threads plus the one replacement; the restart created nothing.
    expect(store.size).toBe(3)
  })

  it('stops following archives once disposed', () => {
    const store = new Map<string, Row>()
    const { mod, threadManager } = boot(store)
    const gateway = mod.gatewayThreadId()!
    mod.dispose()
    threadManager.delete(gateway)
    expect(liveWithRole(store, 'gateway')).toHaveLength(0)
  })
})
