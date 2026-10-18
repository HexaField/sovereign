// Graphcoder HTTP client. Every call takes a fetch, so tests pass their own.

import type { ChangeStructure } from '@sovereign/graphcoder-core/contract'

type Fetch = typeof fetch

/** `GET /api/graphcoder/structure/cached`: what the server knows now, never waiting on a computation */
export type CachedStructure =
  | { state: 'ready'; structure: ChangeStructure }
  | { state: 'computing' }
  | { state: 'failed'; error: string }
  | { state: 'none' }

export interface ChangeKey {
  /** Local checkout */
  path: string
  base: string
  head: string
}

export function createGraphcoderApi(f: Fetch = (...a) => fetch(...a)) {
  return {
    async cachedStructure(key: ChangeKey): Promise<CachedStructure> {
      const q = new URLSearchParams({ path: key.path, base: key.base, head: key.head })
      const res = await f(`/api/graphcoder/structure/cached?${q}`)
      if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try {
          msg = ((await res.json()) as { error?: string }).error ?? msg
        } catch {
          /* not JSON */
        }
        return { state: 'failed', error: msg }
      }
      return (await res.json()) as CachedStructure
    }
  }
}

export type GraphcoderApi = ReturnType<typeof createGraphcoderApi>
