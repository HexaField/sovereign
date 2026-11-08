// Timeline HTTP client. Takes a fetch, so tests can pass their own.

import type { TimelinePage } from '@sovereign/core/timeline'

export interface TimelineRequest {
  kinds?: string
  origins?: string
  before?: string
  limit?: number
}

export async function fetchTimeline(
  req: TimelineRequest,
  f: typeof fetch = (...a) => fetch(...a)
): Promise<TimelinePage> {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(req)) if (v !== undefined && v !== '') qs.set(k, String(v))
  const res = await f(`/api/timeline${qs.size ? `?${qs}` : ''}`)
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg
    } catch {
      /* not JSON */
    }
    throw new Error(msg)
  }
  return (await res.json()) as TimelinePage
}
