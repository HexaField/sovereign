// ── Forest index builder ────────────────────────────────────────────
// Fetches all entities and notes from the hex-knowledge AD4M
// perspective, embeds their text content, computes PCA, and produces
// the ForestIndex JSON. Results get cached to disk.

import fs from 'node:fs'
import path from 'node:path'
import { computePca } from './pca.js'
import { embedTexts, embeddingDim } from './embedding.js'

// ── Types (mirrored from client, kept independent) ─────────────────

interface ForestNode {
  iri: string
  kind: 'entity' | 'note'
  name: string
  entityType: string
  tags: string[]
  content: string
  timestamp: number
  embedding: number[]
}

interface ForestLink {
  source: string
  target: string
  predicate: string
}

interface ForestIndex {
  nodes: ForestNode[]
  links: ForestLink[]
  pcaBasis: number[][] | null
  pcaMean: number[] | null
  embeddingDim: number
  buildTime: number
}

// ── AD4M SPARQL helpers ────────────────────────────────────────────

type SparqlFn = (query: string) => Promise<Record<string, string>[]>

/** Find the hex-knowledge perspective UUID. */
async function findPerspective(
  listPerspectives: () => Promise<Array<{ uuid: string; name: string }>>
): Promise<string | null> {
  const perspectives = await listPerspectives()
  const match = perspectives.find((p) => p.name === 'hex-knowledge')
  return match?.uuid ?? null
}

/** Query all Entity subjects from the perspective. */
async function fetchEntities(sparql: SparqlFn): Promise<ForestNode[]> {
  const rows = await sparql(`
    SELECT ?s ?name ?entityType ?description WHERE {
      ?s <hex://Entity#name> ?name .
      ?s <hex://Entity#entityType> ?entityType .
      OPTIONAL { ?s <hex://Entity#description> ?description . }
    }
  `)

  const nodes: ForestNode[] = []
  for (const row of rows) {
    const iri = row.s ?? ''
    if (!iri) continue
    nodes.push({
      iri,
      kind: 'entity',
      name: row.name ?? '',
      entityType: row.entityType ?? 'unknown',
      tags: [],
      content: row.description ?? '',
      timestamp: 0,
      embedding: []
    })
  }

  // Fetch tags separately (collection properties produce multiple rows)
  if (nodes.length > 0) {
    try {
      const tagRows = await sparql(`
        SELECT ?s ?tag WHERE {
          ?s <hex://Entity#tags> ?tag .
        }
      `)
      const tagMap = new Map<string, string[]>()
      for (const r of tagRows) {
        if (!r.s || !r.tag) continue
        const list = tagMap.get(r.s) ?? []
        list.push(r.tag)
        tagMap.set(r.s, list)
      }
      for (const n of nodes) {
        n.tags = tagMap.get(n.iri) ?? []
      }
    } catch {
      // Tags optional — SPARQL may fail if no tags exist
    }
  }

  return nodes
}

/** Query all Note subjects from the perspective. */
async function fetchNotes(sparql: SparqlFn): Promise<ForestNode[]> {
  const rows = await sparql(`
    SELECT ?s ?content ?timestamp ?noteType ?source WHERE {
      ?s <hex://Note#content> ?content .
      ?s <hex://Note#timestamp> ?timestamp .
      OPTIONAL { ?s <hex://Note#noteType> ?noteType . }
      OPTIONAL { ?s <hex://Note#source> ?source . }
    }
  `)

  return rows
    .filter((r) => r.s)
    .map((r) => ({
      iri: r.s,
      kind: 'note' as const,
      name: (r.content ?? '').slice(0, 60).replace(/\n/g, ' '),
      entityType: r.noteType ?? 'note',
      tags: [],
      content: r.content ?? '',
      timestamp: Number(r.timestamp) || 0,
      embedding: []
    }))
}

/** Query all links (predicates starting with hex://) from the perspective. */
async function fetchLinks(sparql: SparqlFn): Promise<ForestLink[]> {
  const rows = await sparql(`
    SELECT ?source ?predicate ?target WHERE {
      ?source ?predicate ?target .
      FILTER(STRSTARTS(STR(?predicate), "hex://"))
    }
  `)

  return rows
    .filter((r) => r.source && r.predicate && r.target)
    .map((r) => ({
      source: r.source,
      target: r.target,
      predicate: r.predicate
    }))
}

// Also fetch Note → Entity "about" links
async function fetchAboutLinks(sparql: SparqlFn): Promise<ForestLink[]> {
  const rows = await sparql(`
    SELECT ?s ?about WHERE {
      ?s <hex://Note#about> ?about .
    }
  `)

  return rows
    .filter((r) => r.s && r.about)
    .map((r) => ({
      source: r.s,
      target: r.about,
      predicate: 'hex://about'
    }))
}

// ── Builder ────────────────────────────────────────────────────────

export interface Ad4mDeps {
  listPerspectives: () => Promise<Array<{ uuid: string; name: string }>>
  querySparql: (perspectiveUuid: string, query: string) => Promise<any>
}

export interface BuilderOptions {
  dataDir: string
  ad4m: Ad4mDeps | null
}

const CACHE_FILE = 'forest-index.json'
const PCA_COMPONENTS = 10

function cachePath(dataDir: string): string {
  return path.join(dataDir, CACHE_FILE)
}

/** Load cached index from disk (returns null if stale or missing). */
export function loadCachedIndex(dataDir: string): ForestIndex | null {
  const p = cachePath(dataDir)
  try {
    if (!fs.existsSync(p)) return null
    const raw = fs.readFileSync(p, 'utf-8')
    return JSON.parse(raw) as ForestIndex
  } catch {
    return null
  }
}

/** Build a fresh index from AD4M data, embed, compute PCA, and cache. */
export async function buildForestIndex(opts: BuilderOptions): Promise<ForestIndex> {
  const { dataDir, ad4m } = opts

  // No AD4M → return empty index
  if (!ad4m) {
    const empty: ForestIndex = {
      nodes: [],
      links: [],
      pcaBasis: null,
      pcaMean: null,
      embeddingDim: embeddingDim(),
      buildTime: Date.now()
    }
    writeCache(dataDir, empty)
    return empty
  }

  // 1. Find the hex-knowledge perspective
  const perspectiveUuid = await findPerspective(ad4m.listPerspectives)
  if (!perspectiveUuid) {
    console.warn('[forest] hex-knowledge perspective not found — returning empty index')
    const empty: ForestIndex = {
      nodes: [],
      links: [],
      pcaBasis: null,
      pcaMean: null,
      embeddingDim: embeddingDim(),
      buildTime: Date.now()
    }
    writeCache(dataDir, empty)
    return empty
  }

  const sparql: SparqlFn = async (query) => {
    const result = await ad4m.querySparql(perspectiveUuid, query)
    // AD4M returns a flat array of row objects
    return Array.isArray(result) ? result : []
  }

  // 2. Fetch data
  console.log('[forest] fetching entities...')
  const entities = await fetchEntities(sparql)
  console.log(`[forest] found ${entities.length} entities`)

  console.log('[forest] fetching notes...')
  const notes = await fetchNotes(sparql)
  console.log(`[forest] found ${notes.length} notes`)

  const allNodes = [...entities, ...notes]

  console.log('[forest] fetching links...')
  const [hexLinks, aboutLinks] = await Promise.all([fetchLinks(sparql), fetchAboutLinks(sparql)])
  const allLinks = [...hexLinks, ...aboutLinks]
  console.log(`[forest] found ${allLinks.length} links`)

  // 3. Embed — concatenate name + content for each node
  if (allNodes.length > 0) {
    const texts = allNodes.map((n) => `${n.name} ${n.content}`.trim())
    console.log(`[forest] embedding ${texts.length} nodes...`)
    const embeddings = await embedTexts(texts)
    for (let i = 0; i < allNodes.length; i++) {
      allNodes[i].embedding = embeddings[i] ?? []
    }
    console.log('[forest] embedding complete')
  }

  // 4. PCA — compute basis from embeddings
  let pcaBasis: number[][] | null = null
  let pcaMean: number[] | null = null

  const validEmbeddings = allNodes.filter((n) => n.embedding.length > 0).map((n) => n.embedding)
  if (validEmbeddings.length >= 3) {
    console.log(`[forest] computing PCA (${PCA_COMPONENTS} components from ${validEmbeddings.length} vectors)...`)
    const pca = computePca(validEmbeddings, PCA_COMPONENTS)
    pcaBasis = pca.basis
    pcaMean = pca.mean
    console.log('[forest] PCA complete')
  }

  // 5. Filter links to only reference existing node IRIs
  const nodeIris = new Set(allNodes.map((n) => n.iri))
  const validLinks = allLinks.filter((l) => nodeIris.has(l.source) && nodeIris.has(l.target))

  const index: ForestIndex = {
    nodes: allNodes,
    links: validLinks,
    pcaBasis,
    pcaMean,
    embeddingDim: embeddingDim(),
    buildTime: Date.now()
  }

  writeCache(dataDir, index)
  console.log(`[forest] index built — ${allNodes.length} nodes, ${validLinks.length} links`)
  return index
}

function writeCache(dataDir: string, index: ForestIndex): void {
  const p = cachePath(dataDir)
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(index))
  } catch (err) {
    console.warn('[forest] cache write failed:', (err as Error)?.message)
  }
}
