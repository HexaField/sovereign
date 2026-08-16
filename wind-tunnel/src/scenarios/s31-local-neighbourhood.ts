// S31: Local Neighbourhood — proves neighbourhoods work end-to-end on the
// local link language, with no Holochain involved.
//
// Only runs when the ad4m lane is active (docker-compose.ad4m.yml + the
// provision step, or explicit AD4M_* env). Otherwise it self-skips as a
// pass, so the core s1–s9 run is unaffected — same convention as s10.
//
// Given the provisioned user (the same identity s10 uses) and the link
// language template address the provision step discovered via
// `list_link_language_templates` (sourced from the local bootstrap seed's
// knownLinkLanguages, not a Holochain DNA), this:
//   1. creates a fresh local perspective;
//   2. publishes it as a neighbourhood using that local link language
//      template — the executor clones a unique sync instance from it. No
//      Holochain conductor is involved; RUN_HOLOCHAIN stays "false" for the
//      whole container, so a successful publish is direct proof the
//      clone + publish path never touches it;
//   3. adds links to the now-shared perspective;
//   4. queries them back and asserts they round-trip; and
//   5. leaves the perspective + neighbourhood in place — see the note above
//      the "Clean up" step in run() for why.
//
// This is the "no Holochain needed for neighbourhoods" counterpart to s10's
// waker proof: s10 shows Sovereign's native ad4m client works end-to-end on
// this lane, s31 shows neighbourhood creation + sync do too.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'
// @ts-expect-error — plain .mjs helper shared with the docker provision step
import { McpClient, pick } from '../../ad4m/mcp-client.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_PROVISION = path.resolve(HERE, '../../ad4m/.provision/provision.json')
const MARKER = 'SWT_S31_LOCAL_NH_OK'
const ROOT = 'swt-s31://root'

interface Provision {
  jwt: string
  did: string
  uuid: string
  channel: string
  linkLanguageTemplate?: string
}

function loadProvision(): Provision | null {
  const file = process.env.AD4M_PROVISION_FILE || DEFAULT_PROVISION
  try {
    const raw = fs.readFileSync(file, 'utf-8')
    const p = JSON.parse(raw)
    if (p?.jwt && p?.uuid) return p
  } catch {
    /* lane not active */
  }
  return null
}

const skip = (summary: string): ScenarioResult => ({ passed: true, summary, metrics: { skipped: true }, samples: [] })

export const s31LocalNeighbourhood: Scenario = {
  id: 's31',
  name: 'Local Neighbourhood',
  description:
    'A perspective publishes as a neighbourhood on the local link language and its links round-trip — no Holochain involved',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client } = ctx
    const prov = loadProvision()
    if (!prov) return skip('skipped — ad4m lane not active (no provision manifest)')

    const mcpUrl = process.env.AD4M_MCP_URL || 'http://localhost:14561'
    const metrics: Record<string, unknown> = { mcpUrl }
    const mcp = new McpClient(mcpUrl, prov.jwt)
    // A stale manifest from a torn-down lane must not fail a plain run — if
    // the node is unreachable, the lane is not active, so skip (same as s10).
    try {
      await mcp.initialize('swt-s31')
    } catch {
      return skip(`skipped — ad4m node unreachable at ${mcpUrl}`)
    }

    const template = prov.linkLanguageTemplate
    metrics.linkLanguageTemplate = template || null
    if (!template) {
      return {
        passed: false,
        summary:
          'no link language template in the provision manifest — provision.mjs found none via ' +
          'list_link_language_templates (the node has no local bootstrap link language)',
        metrics,
        samples: client.samples
      }
    }

    // 1. Create a fresh local perspective for this scenario.
    const persp: any = await client.timed('add-perspective', () =>
      mcp.callToolJson('add_perspective', { name: 'swt-s31-local-neighbourhood' })
    )
    const uuid = persp?.uuid || pick(persp, 'uuid', 'perspectiveUuid')
    if (!uuid) {
      return {
        passed: false,
        summary: `add_perspective returned no uuid: ${JSON.stringify(persp).slice(0, 200)}`,
        metrics,
        samples: client.samples
      }
    }
    metrics.uuid = uuid

    // 2. Publish it as a neighbourhood using the local link language
    //    template. The executor clones a unique sync instance from it.
    const publish: any = await client.timed('publish-neighbourhood', () =>
      mcp.callToolJson('neighbourhood_publish_from_perspective', {
        perspective_uuid: uuid,
        link_language: template,
        name: 'swt-s31-neighbourhood'
      })
    )
    metrics.publish = publish
    const neighbourhoodUrl = pick(publish, 'neighbourhood_url', 'neighbourhoodUrl', 'url')
    if (!neighbourhoodUrl) {
      return {
        passed: false,
        summary: `neighbourhood_publish_from_perspective did not return a neighbourhood_url: ${JSON.stringify(publish).slice(0, 300)}`,
        metrics,
        samples: client.samples
      }
    }
    metrics.neighbourhoodUrl = neighbourhoodUrl

    // 3. Add links to the now-shared perspective (structural child + a
    //    literal marker on it — same has_child/literal shape s10 uses to
    //    inject its mention).
    const itemAddr = `${ROOT}/item/${Date.now()}`
    const literal = `literal://string:${encodeURIComponent(MARKER)}`
    await client.timed('add-links', async () => {
      await mcp.callToolJson('add_link', {
        perspective_id: uuid,
        source: ROOT,
        predicate: 'ad4m://has_child',
        target: itemAddr
      })
      await mcp.callToolJson('add_link', {
        perspective_id: uuid,
        source: itemAddr,
        predicate: 'swt://marker',
        target: literal
      })
    })

    // 4. Query links back and verify they exist.
    const childLinks = await client.timed('query-child-link', () =>
      mcp.callToolJson('query_links', { perspective_id: uuid, source: ROOT, predicate: 'ad4m://has_child' })
    )
    const markerLinks = await client.timed('query-marker-link', () =>
      mcp.callToolJson('query_links', { perspective_id: uuid, source: itemAddr, predicate: 'swt://marker' })
    )
    const childLinked = JSON.stringify(childLinks).includes(itemAddr)
    const markerLinked = JSON.stringify(markerLinks).includes(MARKER)
    metrics.childLinked = childLinked
    metrics.markerLinked = markerLinked

    // 5. Clean up. The executor's MCP surface exposes add_perspective /
    //    add_link / query_links but no remove_link or delete_perspective
    //    (rust-executor/src/mcp/tools/perspectives.rs) — links and
    //    perspectives are additive from this API. There is nothing to
    //    retract: the perspective and its cloned neighbourhood language live
    //    in this container's /data volume, which run.sh wipes before every
    //    ad4m-lane run and `docker compose down -v` discards on teardown, so
    //    no state leaks into the next run.

    if (!childLinked) {
      return {
        passed: false,
        summary: 'link added to the neighbourhood-published perspective did not read back via query_links',
        metrics,
        samples: client.samples
      }
    }
    if (!markerLinked) {
      return {
        passed: false,
        summary: 'marker link on the child did not read back via query_links',
        metrics,
        samples: client.samples
      }
    }

    return {
      passed: true,
      summary:
        'perspective published as a neighbourhood on the local link language (no Holochain) and its links round-tripped',
      metrics,
      samples: client.samples
    }
  }
}
