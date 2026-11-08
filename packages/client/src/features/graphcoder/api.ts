// Graphcoder HTTP client. Every call takes a fetch, so tests pass their own.

import type { ChangeStructure, ConceptMapReport } from '@sovereign/graphcoder-core/contract'

type Fetch = typeof fetch

/** `GET /api/graphcoder/structure/cached`: what the server knows now, never waiting on a computation */
export type CachedStructure =
  | { state: 'ready'; structure: ChangeStructure }
  | { state: 'computing' }
  | { state: 'failed'; error: string }
  | { state: 'none' }

/** `GET /api/graphcoder/concepts`: a checkout's concept map at one commit */
export type ConceptsResult = { state: 'ready'; report: ConceptMapReport } | { state: 'failed'; error: string }

export interface ChangeKey {
  /** Local checkout */
  path: string
  base: string
  head: string
}

/** The server's error message, or the HTTP status */
async function errorOf(res: Response): Promise<string> {
  try {
    return ((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

export function createGraphcoderApi(f: Fetch = (...a) => fetch(...a)) {
  return {
    async cachedStructure(key: ChangeKey): Promise<CachedStructure> {
      const q = new URLSearchParams({ path: key.path, base: key.base, head: key.head })
      const res = await f(`/api/graphcoder/structure/cached?${q}`)
      if (!res.ok) return { state: 'failed', error: await errorOf(res) }
      return (await res.json()) as CachedStructure
    },

    /** The concept map of a checkout at `ref` (default its HEAD). Another commit may take seconds: it is indexed first. */
    async concepts(path: string, ref?: string): Promise<ConceptsResult> {
      const q = new URLSearchParams(ref ? { path, ref } : { path })
      const res = await f(`/api/graphcoder/concepts?${q}`)
      if (!res.ok) return { state: 'failed', error: await errorOf(res) }
      return { state: 'ready', report: (await res.json()) as ConceptMapReport }
    }
  }
}

export type GraphcoderApi = ReturnType<typeof createGraphcoderApi>
