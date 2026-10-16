// The `sovereign-forge` perspective — opened through the server's AD4M client
// manager (the same `ad4mService.client()` every other AD4M feature uses).
//
// connect() finds the perspective (cached uuid → by name → create), registers
// the Forge SHACL classes once per perspective, and returns a LinkGraph over
// it. It throws while AD4M is unreachable; the durable stores retry.

import fs from 'node:fs'
import path from 'node:path'
import { LinkQuery } from '@coasys/ad4m'
import type { Ad4mClientManager } from '@sovereign/ad4m'
import type { LinkGraph, LinkPattern, LinkTriple } from './link-graph.js'
import { matches } from './link-graph.js'
import { FORGE_PERSPECTIVE_NAME, FORGE_SHACL_CLASSES } from './ontology.js'

const TAG = '[forge-perspective]'
const STATE_FILE = 'forge-perspective.json'

export interface ForgePerspectiveOptions {
  ad4m: Ad4mClientManager
  /** Directory for the cached perspective uuid (forge-perspective.json). */
  dataDir: string
  /** Perspective name. Default "sovereign-forge". */
  name?: string
  log?: Pick<Console, 'log' | 'warn'>
}

export interface ForgePerspective {
  connect(): Promise<LinkGraph>
  /** Fires on every AD4M (re)connect. Returns an unsubscriber. */
  onReconnect(cb: () => void): () => void
}

/** The PerspectiveProxy methods used here. */
interface ProxyLike {
  uuid: string
  name?: string | null
  get(q: LinkQuery): Promise<Array<{ data: LinkTriple; [k: string]: unknown }>>
  linkMutations(m: { additions: LinkTriple[]; removals: unknown[] }): Promise<unknown>
  subjectClasses(): Promise<string[]>
  addSubjectClass(name: string, shaclJson: string): Promise<unknown>
}

interface CachedState {
  perspectiveName: string
  perspectiveUuid: string
}

function readCache(dir: string): CachedState | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf-8')) as CachedState
  } catch {
    return null
  }
}

function writeCache(dir: string, state: CachedState): void {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, STATE_FILE)
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2))
  fs.renameSync(`${file}.tmp`, file)
}

/** Strip GraphQL typenames the executor rejects on input. */
function toInput(expr: any): unknown {
  const { __typename: _t, ...rest } = expr
  const out: Record<string, unknown> = { ...rest }
  if (rest.data) {
    const { __typename: _d, ...data } = rest.data
    out.data = data
  }
  if (rest.proof) {
    const { __typename: _p, ...proof } = rest.proof
    out.proof = proof
  }
  return out
}

export function createLinkGraph(p: ProxyLike): LinkGraph {
  return {
    id: p.uuid,
    async all() {
      const exprs = await p.get(new LinkQuery({}))
      return exprs.map((e) => ({ source: e.data.source, predicate: e.data.predicate, target: e.data.target }))
    },
    async mutate(m) {
      // One query per subject; patterns are matched here.
      const bySource = new Map<string, LinkPattern[]>()
      for (const pattern of m.removeMatching ?? []) {
        if (!pattern.source) throw new Error('removeMatching needs a source')
        const list = bySource.get(pattern.source) ?? []
        list.push(pattern)
        bySource.set(pattern.source, list)
      }
      const removals: unknown[] = []
      for (const [source, patterns] of bySource) {
        const found = await p.get(new LinkQuery({ source }))
        for (const e of found) {
          if (patterns.some((pt) => matches(e.data, pt))) removals.push(toInput(e))
        }
      }
      const additions = (m.add ?? []).map((l) => ({ source: l.source, predicate: l.predicate, target: l.target }))
      if (additions.length === 0 && removals.length === 0) return
      await p.linkMutations({ additions, removals })
    },
    async ping() {
      await p.get(new LinkQuery({ source: 'forge://ping', predicate: 'forge://ping' }))
    }
  }
}

export function createForgePerspective(opts: ForgePerspectiveOptions): ForgePerspective {
  const log = opts.log ?? console
  const name = opts.name ?? FORGE_PERSPECTIVE_NAME
  const registered = new Set<string>()
  let inflight: Promise<LinkGraph> | null = null

  async function open(): Promise<LinkGraph> {
    const client = opts.ad4m.getClient()
    if (!client || !opts.ad4m.isConnected()) throw new Error('AD4M not connected')

    let proxy: ProxyLike | null = null
    const cached = readCache(opts.dataDir)
    if (cached?.perspectiveUuid && cached.perspectiveName === name) {
      proxy = (await client.perspective.byUUID(cached.perspectiveUuid)) as unknown as ProxyLike | null
      if (!proxy) log.warn(TAG, `cached perspective ${cached.perspectiveUuid} is gone — looking up "${name}"`)
    }
    if (!proxy) {
      const all = (await client.perspective.all()) as unknown as ProxyLike[]
      proxy = all.find((p) => p.name === name) ?? null
      if (!proxy) {
        proxy = (await client.perspective.add(name)) as unknown as ProxyLike
        log.log(TAG, `created perspective ${name} (${proxy.uuid})`)
      }
      writeCache(opts.dataDir, { perspectiveName: name, perspectiveUuid: proxy.uuid })
    }

    if (!registered.has(proxy.uuid)) {
      const existing = await proxy.subjectClasses()
      for (const [className, shape] of Object.entries(FORGE_SHACL_CLASSES)) {
        if (existing.includes(className)) continue
        try {
          await proxy.addSubjectClass(className, JSON.stringify(shape))
          log.log(TAG, `registered subject class ${className}`)
        } catch (err) {
          log.warn(TAG, `failed to register ${className}: ${(err as Error)?.message}`)
        }
      }
      registered.add(proxy.uuid)
    }
    return createLinkGraph(proxy)
  }

  return {
    connect() {
      // Both durable stores connect at once; share one lookup.
      if (!inflight) inflight = open().finally(() => (inflight = null))
      return inflight
    },
    onReconnect: (cb) => opts.ad4m.onConnected(cb)
  }
}
