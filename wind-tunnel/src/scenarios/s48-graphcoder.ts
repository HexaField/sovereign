// S48: Graphcoder P0. `graphcoder.enabled` is on in docker/config.json. The
// image bakes an indexed checkout (the tiny-ts fixture of graphcoder-server,
// committed and `codegraph init`-ed at build time) under /app/.wt-fixtures.
// The scenario makes that directory an org root, waits for the code index to
// discover the checkout, then reads it through /api/graphcoder: the status
// lists it, the stats count it, and unlisted or missing paths are refused.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

const ORG_ROOT = '/app/.wt-fixtures/graphcoder'
const REPO = `${ORG_ROOT}/tiny-ts`

/** What codegraph 1.5 extracts from the fixture (see packages/graphcoder-server/src/service.test.ts) */
const EXPECTED = {
  nodeCount: 10,
  fileCount: 3,
  nodesByKind: { class: 1, file: 3, function: 2, import: 1, method: 3 },
  annotations: 1
}

export const s48Graphcoder: Scenario = {
  id: 's48',
  name: 'Graphcoder',
  description:
    'graphcoder.enabled: status lists an indexed checkout the code index found; stats count it; bad paths refused',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client } = ctx
    const base = client.baseUrl
    const metrics: Record<string, unknown> = {}
    const problems: string[] = []

    const org = await client.post('/api/orgs', { name: 'graphcoder-wt', path: ORG_ROOT })
    try {
      // 1. The code index discovers the checkout under the new org root (org.created → rediscover).
      const started = Date.now()
      let repos: string[] = []
      while (Date.now() - started < 30_000) {
        repos = (await client.timed('graphcoder.status', () => client.get('/api/graphcoder/status'))).repos ?? []
        if (repos.includes(REPO)) break
        await new Promise((r) => setTimeout(r, 500))
      }
      metrics.discoveredMs = Date.now() - started
      metrics.repos = repos
      if (!repos.includes(REPO)) problems.push(`status never listed ${REPO}: ${JSON.stringify(repos)}`)

      // 2. Stats for the fixture.
      const res = await fetch(`${base}/api/graphcoder/repos/stats?path=${encodeURIComponent(REPO)}`)
      const stats = await res.json()
      metrics.stats = stats
      if (!res.ok) problems.push(`stats: HTTP ${res.status} ${JSON.stringify(stats)}`)
      else {
        for (const [key, want] of Object.entries(EXPECTED)) {
          if (JSON.stringify(stats[key]) !== JSON.stringify(want))
            problems.push(`stats.${key}: ${JSON.stringify(stats[key])}, want ${JSON.stringify(want)}`)
        }
        if (!(stats.edgeCount > 0)) problems.push(`stats.edgeCount: ${stats.edgeCount}`)
        if (stats.path !== REPO) problems.push(`stats.path: ${stats.path}`)
      }

      // 3. Paths the GraphSource does not list never open.
      const status = async (query: string) => (await fetch(`${base}/api/graphcoder/repos/stats${query}`)).status
      const errors = {
        unlisted: await status(`?path=${encodeURIComponent('/app')}`),
        orgRoot: await status(`?path=${encodeURIComponent(ORG_ROOT)}`),
        missing: await status('')
      }
      metrics.errors = errors
      if (errors.unlisted !== 404 || errors.orgRoot !== 404 || errors.missing !== 400)
        problems.push(`errors: ${JSON.stringify(errors)}`)
    } finally {
      await client.del(`/api/orgs/${encodeURIComponent(org.id)}`)
    }

    const passed = problems.length === 0
    return {
      passed,
      summary: passed
        ? `checkout discovered in ${metrics.discoveredMs} ms; ${EXPECTED.nodeCount} nodes, ${EXPECTED.fileCount} files, 1 annotation; unlisted 404, missing 400`
        : problems.join('; '),
      metrics,
      samples: client.samples
    }
  }
}
