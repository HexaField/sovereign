// S49: Graphcoder P1, the structure of a change. The image's tiny-ts fixture
// (see s48) carries two branches: structure-base adds a test of add(), and
// feature edits add(), adds negate() and removes multiply() with its only
// caller Point.scale(). With the fixture an org root, the scenario asks the
// cache-only route (nothing yet), computes the structure through
// /api/graphcoder/structure (both sides indexed in one detached checkout),
// checks symbols, module, reach and tests, then reads it back from the cache.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

const ORG_ROOT = '/app/.wt-fixtures/graphcoder'
const REPO = `${ORG_ROOT}/tiny-ts`

/** What packages/graphcoder-server/src/structure.test.ts expects of the same change */
const EXPECTED = {
  added: ['negate'],
  removed: ['Point::scale', 'multiply'],
  modified: ['Point', 'add'],
  modules: [{ module: 'src', label: 'src', added: 1, removed: 2, modified: 2 }],
  reach: 4,
  parts: 1,
  tests: [{ id: 'src/math.test.ts::math adds', file: 'src/math.test.ts', depth: 1 }]
}

export const s49GraphcoderStructure: Scenario = {
  id: 's49',
  name: 'Graphcoder: structure of a change',
  description:
    'structure route: symbols added/removed/modified, module, reach and tests of a fixture branch; cached afterwards',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client } = ctx
    const base = client.baseUrl
    const metrics: Record<string, unknown> = {}
    const problems: string[] = []
    const query = (b: string, h: string) =>
      `path=${encodeURIComponent(REPO)}&base=${encodeURIComponent(b)}&head=${encodeURIComponent(h)}`

    const org = await client.post('/api/orgs', { name: 'graphcoder-wt-structure', path: ORG_ROOT })
    try {
      const started = Date.now()
      let repos: string[] = []
      while (Date.now() - started < 30_000) {
        repos = (await client.get('/api/graphcoder/status')).repos ?? []
        if (repos.includes(REPO)) break
        await new Promise((r) => setTimeout(r, 500))
      }
      if (!repos.includes(REPO)) problems.push(`status never listed ${REPO}: ${JSON.stringify(repos)}`)

      // 1. Nothing cached before the first request.
      const before = await (
        await fetch(`${base}/api/graphcoder/structure/cached?${query('structure-base', 'feature')}`)
      ).json()
      metrics.before = before
      if (before.state !== 'none') problems.push(`cached before: ${JSON.stringify(before)}`)

      // 2. Compute.
      const t0 = Date.now()
      const res = await client.timed('graphcoder.structure', () =>
        fetch(`${base}/api/graphcoder/structure?${query('structure-base', 'feature')}`)
      )
      const s = await res.json()
      metrics.computeMs = Date.now() - t0
      if (!res.ok) problems.push(`structure: HTTP ${res.status} ${JSON.stringify(s)}`)
      else {
        const names = (list: Array<{ qualifiedName: string }>) => list.map((x) => x.qualifiedName).sort()
        const got = {
          added: names(s.symbols.added),
          removed: names(s.symbols.removed),
          modified: names(s.symbols.modified),
          modules: s.modules,
          reach: s.reach,
          parts: s.parts,
          tests: s.tests
        }
        metrics.structure = got
        for (const [key, want] of Object.entries(EXPECTED)) {
          const have = got[key as keyof typeof got]
          const sorted = Array.isArray(want) && typeof want[0] === 'string' ? [...(want as string[])].sort() : want
          if (JSON.stringify(have) !== JSON.stringify(sorted))
            problems.push(`${key}: ${JSON.stringify(have)}, want ${JSON.stringify(sorted)}`)
        }
        if (!/^[0-9a-f]{40}$/.test(s.base) || !/^[0-9a-f]{40}$/.test(s.head)) problems.push(`shas: ${s.base} ${s.head}`)
      }

      // 3. The cache answers at once, by refs or by shas.
      const t1 = Date.now()
      const after = await (
        await fetch(`${base}/api/graphcoder/structure/cached?${query('structure-base', 'feature')}`)
      ).json()
      metrics.cachedMs = Date.now() - t1
      if (after.state !== 'ready' || JSON.stringify(after.structure) !== JSON.stringify(s))
        problems.push(`cached after: ${JSON.stringify(after).slice(0, 200)}`)
      const bySha = await (await fetch(`${base}/api/graphcoder/structure/cached?${query(s.base, s.head)}`)).json()
      if (bySha.state !== 'ready') problems.push(`cached by sha: ${bySha.state}`)

      // 4. Refusals: an unlisted path, a ref that reads as an option.
      const unlisted = (await fetch(`${base}/api/graphcoder/structure/cached?path=%2Fapp&base=main&head=feature`))
        .status
      const option = (await fetch(`${base}/api/graphcoder/structure?${query('--output=/tmp/x', 'feature')}`)).status
      metrics.errors = { unlisted, option }
      if (unlisted !== 404 || option !== 400) problems.push(`errors: ${JSON.stringify(metrics.errors)}`)
    } finally {
      await client.del(`/api/orgs/${encodeURIComponent(org.id)}`)
    }

    const passed = problems.length === 0
    return {
      passed,
      summary: passed
        ? `structure computed in ${metrics.computeMs} ms, cached read ${metrics.cachedMs} ms; +1 −2 ~2 symbols in src, reach 4, 1 test`
        : problems.join('; '),
      metrics,
      samples: client.samples
    }
  }
}
