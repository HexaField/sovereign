// S20: Forest Index — verify the forest knowledge-graph API returns a
// well-formed ForestIndex shape from both the cached-or-build GET and
// the forced POST rebuild.
//
// The Docker wind tunnel has no AD4M perspective wired up, so the index
// legitimately comes back empty (0 nodes, 0 links) — this scenario
// validates the SHAPE of the response, not the data. Self-skips when the
// endpoints return 404 (pre-implementation baseline) — same pattern as
// s15/s17.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

const skip = (summary: string): ScenarioResult => ({
  passed: true,
  summary,
  metrics: { skipped: true },
  samples: []
})

function is404(err: any): boolean {
  return String(err?.message ?? '').includes('→ 404')
}

/** Validate the top-level ForestIndex shape. Returns a list of problems (empty = valid). */
function validateForestIndex(data: any): string[] {
  const errors: string[] = []
  if (data == null || typeof data !== 'object') {
    return ['response not an object']
  }
  if (!Array.isArray(data.nodes)) errors.push('nodes not an array')
  if (!Array.isArray(data.links)) errors.push('links not an array')
  if (data.pcaBasis !== null && !Array.isArray(data.pcaBasis)) {
    errors.push('pcaBasis neither array nor null')
  }
  if (data.pcaMean !== null && !Array.isArray(data.pcaMean)) {
    errors.push('pcaMean neither array nor null')
  }
  if (typeof data.embeddingDim !== 'number') errors.push('embeddingDim not a number')
  if (typeof data.buildTime !== 'number') errors.push('buildTime not a number')
  return errors
}

const POLL_INTERVAL_MS = 500
const POLL_MAX_ATTEMPTS = 30 // 15s total

/**
 * GET /api/forest/index with 202 polling.
 * The server returns 202 while the index builds in the background.
 * Poll until a 200 arrives or the attempt limit expires.
 */
async function getIndexWithPolling(baseUrl: string): Promise<{ status: number; body: any }> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${baseUrl}/api/forest/index`)
    const body = await res.json()
    if (res.status !== 202) return { status: res.status, body }
    // 202 — build still running, wait and retry
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  return { status: 202, body: { building: true, message: 'poll timeout' } }
}

export const s20ForestIndex: Scenario = {
  id: 's20',
  name: 'Forest Index',
  description: 'Forest knowledge graph API — index, rebuild, and response shape',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client } = ctx
    const metrics: Record<string, unknown> = {}

    // ── 1. POST /api/forest/rebuild first ──────────────────────────
    // The POST blocks until the build completes, which ensures the
    // cache exists before we test the GET path. In Docker (no AD4M)
    // the build returns an empty-but-valid ForestIndex almost instantly.
    let rebuildRes: any
    try {
      rebuildRes = await client.timed('forest-rebuild', () => client.post('/api/forest/rebuild'))
    } catch (err: any) {
      if (is404(err)) {
        return skip('skipped — /api/forest/rebuild endpoint not available (pre-implementation baseline)')
      }
      return {
        passed: false,
        summary: `POST /api/forest/rebuild failed: ${err?.message}`,
        metrics,
        samples: client.samples
      }
    }

    const rebuildErrors = validateForestIndex(rebuildRes)
    metrics.rebuildErrors = rebuildErrors
    metrics.rebuildNodeCount = Array.isArray(rebuildRes?.nodes) ? rebuildRes.nodes.length : null
    metrics.rebuildLinkCount = Array.isArray(rebuildRes?.links) ? rebuildRes.links.length : null
    metrics.rebuildEmbeddingDim = rebuildRes?.embeddingDim
    metrics.rebuildBuildTime = rebuildRes?.buildTime

    // ── 2. GET /api/forest/index ──────────────────────────────────
    // Now the cache exists. If the server still returns 202, poll
    // until it resolves (handles the first-request lazy-build path).
    let indexRes: any
    try {
      const { status, body } = await client.timed('forest-index', () => getIndexWithPolling(client.baseUrl))
      if (status === 404) {
        return skip('skipped — /api/forest/index endpoint not available (pre-implementation baseline)')
      }
      if (status === 202) {
        return {
          passed: false,
          summary: 'GET /api/forest/index still 202 after polling — build did not complete',
          metrics,
          samples: client.samples
        }
      }
      indexRes = body
    } catch (err: any) {
      if (is404(err)) {
        return skip('skipped — /api/forest/index endpoint not available (pre-implementation baseline)')
      }
      return {
        passed: false,
        summary: `GET /api/forest/index failed: ${err?.message}`,
        metrics,
        samples: client.samples
      }
    }

    const indexErrors = validateForestIndex(indexRes)
    metrics.indexErrors = indexErrors
    metrics.indexNodeCount = Array.isArray(indexRes?.nodes) ? indexRes.nodes.length : null
    metrics.indexLinkCount = Array.isArray(indexRes?.links) ? indexRes.links.length : null
    metrics.indexEmbeddingDim = indexRes?.embeddingDim
    metrics.indexBuildTime = indexRes?.buildTime

    // ── 3. Assertions ────────────────────────────────────────────
    // Both responses must satisfy the ForestIndex shape. In Docker
    // (no AD4M), an empty index (0 nodes, 0 links, null pcaBasis/
    // pcaMean) counts as a correct, passing result — only the shape
    // matters here, not data volume.
    const passed = rebuildErrors.length === 0 && indexErrors.length === 0

    return {
      passed,
      summary: passed
        ? `forest index OK — POST(rebuild) nodes=${metrics.rebuildNodeCount} links=${metrics.rebuildLinkCount}, ` +
          `GET nodes=${metrics.indexNodeCount} links=${metrics.indexLinkCount}, ` +
          `embeddingDim=${metrics.indexEmbeddingDim}`
        : `forest index shape invalid — POST: [${rebuildErrors.join(', ')}], GET: [${indexErrors.join(', ')}]`,
      metrics,
      samples: client.samples
    }
  }
}
