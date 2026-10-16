// LinkGraph — the narrow slice of an AD4M perspective the Forge stores use.
//
// The real one wraps a PerspectiveProxy (ad4m-perspective.ts); tests use the
// in-memory one below. Keeping the seam this small lets the store contract
// tests drive the exact link writes that reach AD4M.

export interface LinkTriple {
  source: string
  predicate: string
  target: string
}

export interface LinkPattern {
  /** Required: a mutation never removes links across subjects. */
  source: string
  predicate?: string
  target?: string
}

export interface LinkGraph {
  /** Identity of the underlying perspective (its uuid). */
  id: string
  /** Every link in the perspective. */
  all(): Promise<LinkTriple[]>
  /** Remove every link matching each pattern, then add `add`, as one mutation. */
  mutate(m: { add?: LinkTriple[]; removeMatching?: LinkPattern[] }): Promise<void>
  /** Cheap reachability probe. */
  ping(): Promise<void>
}

export function matches(l: LinkTriple, p: LinkPattern): boolean {
  return (
    l.source === p.source &&
    (p.predicate === undefined || l.predicate === p.predicate) &&
    (p.target === undefined || l.target === p.target)
  )
}

/** A LinkGraph held in memory. Like AD4M, it keeps duplicate links if asked
 *  to add the same triple twice, so idempotency bugs in a store show up. */
export function createInMemoryLinkGraph(id = 'memory'): LinkGraph & { links: LinkTriple[] } {
  const links: LinkTriple[] = []
  return {
    id,
    links,
    async all() {
      return links.map((l) => ({ ...l }))
    },
    async mutate(m) {
      for (const p of m.removeMatching ?? []) {
        if (!p.source) throw new Error('removeMatching needs a source')
        for (let i = links.length - 1; i >= 0; i--) if (matches(links[i], p)) links.splice(i, 1)
      }
      for (const l of m.add ?? []) links.push({ ...l })
    },
    async ping() {}
  }
}

// ── Literals ──────────────────────────────────────────────────────────
// Same encoding as @coasys/ad4m's Literal for strings ("literal:string:<rfc3986>"),
// kept local so the stores and their tests need no SDK build.

function encodeRfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

export function toLiteral(value: string): string {
  return `literal:string:${encodeRfc3986(value)}`
}

/** Decode a string literal; other literal kinds decode to their text; non-literals pass through. */
export function fromLiteral(url: string): string {
  if (!url.startsWith('literal:')) return url
  const body = url.slice('literal:'.length)
  const colon = body.indexOf(':')
  if (colon < 0) return url
  return decodeURIComponent(body.slice(colon + 1))
}
