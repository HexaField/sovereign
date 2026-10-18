// The Forge's link to Graphcoder: the code structure of every open change.
//
// The host passes a `StructureOf` (Graphcoder's, at bootstrap); the work graph
// never imports Graphcoder. After each membrane sync, every open change whose
// head is new gets one request, queued one at a time behind the others (the
// host computes at low priority and caches by commit, so after a restart the
// first sync reads every structure back from its cache). Errors are kept on
// the node and logged; they never reach the sync. Nodes carry only the state
// and the card's numbers; the client reads the full structure from
// Graphcoder's own route.

import { refKey, type WorkNode, type WorkNodeStructure } from '@sovereign/core'
import type { ChangeStructure, StructureOf } from '@sovereign/graphcoder-core/contract'
import type { CachedChange } from './types.js'

export interface StructureHook {
  /**
   * Asks for the structure of each open change of one repo whose head it has not asked for yet, in the repo's first
   * checkout (`<remote>/<base branch>` against the head sha). `onReady` runs when one arrives or fails.
   */
  request(
    checkouts: ReadonlyArray<{ path: string; remote: string }>,
    changes: Iterable<CachedChange>,
    onReady: () => void
  ): void
  /** The node with its structure, when it has one */
  attach(node: WorkNode): WorkNode
}

function summary(s: ChangeStructure, path: string): WorkNodeStructure {
  return {
    state: 'ready',
    path,
    base: s.base,
    head: s.head,
    reach: s.reach,
    parts: s.parts,
    modules: s.modules.length,
    symbols: s.symbols.added.length + s.symbols.removed.length + s.symbols.modified.length,
    tests: s.tests.length
  }
}

export function createStructureHook(structureOf: StructureOf, log: (msg: string) => void): StructureHook {
  const byNode = new Map<string, WorkNodeStructure>()
  let chain: Promise<unknown> = Promise.resolve()

  return {
    request(checkouts, changes, onReady) {
      const checkout = checkouts[0]
      if (!checkout) return
      for (const c of changes) {
        if ((c.state !== 'open' && c.state !== 'draft') || !c.head.sha || !c.base.branch) continue
        const id = refKey(c.ref)
        if (byNode.get(id)?.head === c.head.sha) continue
        const base = `${checkout.remote}/${c.base.branch}`
        const head = c.head.sha
        byNode.set(id, { state: 'computing', path: checkout.path, base, head })
        const current = () => byNode.get(id)?.head === head
        // Never rejects, so one failure cannot stop the requests queued behind it
        chain = chain.then(async () => {
          if (!current()) return // a newer head was asked for meanwhile
          try {
            const s = await structureOf(checkout.path, base, head)
            if (current()) byNode.set(id, summary(s, checkout.path))
          } catch (err) {
            log(`structure of ${id} at ${head.slice(0, 8)}: ${(err as Error).message}`)
            if (current())
              byNode.set(id, { state: 'failed', path: checkout.path, base, head, error: (err as Error).message })
          }
          try {
            onReady()
          } catch (err) {
            log(`structure of ${id}: ${(err as Error).message}`)
          }
        })
      }
    },
    attach(node) {
      const structure = node.kind === 'change' ? byNode.get(node.id) : undefined
      return structure ? { ...node, structure } : node
    }
  }
}
