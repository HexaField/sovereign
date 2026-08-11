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

// ── AD4M link helpers ─────────────────────────────────────────────
//
// AD4M stores data as flat links (source → predicate → target).
// Property predicates use bare names like "hex://name" (NOT "hex://Entity#name").
// Values carry a "literal:string:" prefix with URL-encoded content.
// IRIs use "literal://string:<id>" (double-slash).
//
// We query via the link API rather than SPARQL — more reliable for
// AD4M's non-standard URI schemes.

interface Ad4mLink {
  source: string
  predicate: string
  target: string
  timestamp: string
  author: string
}

type LinkQueryFn = (opts?: { source?: string; predicate?: string; target?: string }) => Promise<Ad4mLink[]>

/** Decode an AD4M literal value — strips "literal:string:" prefix and URL-decodes. */
function decodeLiteral(val: string): string {
  const prefix = 'literal:string:'
  if (val.startsWith(prefix)) {
    try {
      return decodeURIComponent(val.slice(prefix.length))
    } catch {
      return val.slice(prefix.length)
    }
  }
  return val
}

/** Find the hex-knowledge perspective UUID. */
async function findPerspective(
  listPerspectives: () => Promise<Array<{ uuid: string; name: string }>>
): Promise<string | null> {
  const perspectives = await listPerspectives()
  const match = perspectives.find((p) => p.name === 'hex-knowledge')
  return match?.uuid ?? null
}

/** Query all Entity subjects from the perspective. */
async function fetchEntities(queryLinks: LinkQueryFn): Promise<ForestNode[]> {
  // Find all subjects typed as hex://Entity
  const typeLinks = await queryLinks({ predicate: 'rdf://type', target: 'hex://Entity' })
  const iris = typeLinks.map((l) => l.source)
  if (iris.length === 0) return []

  // Fetch all hex:// property links in one call, then partition by subject
  const allProps = await queryLinks({ predicate: 'hex://name' })
  const allTypes = await queryLinks({ predicate: 'hex://entityType' })
  const allDescs = await queryLinks({ predicate: 'hex://description' })
  const allTags = await queryLinks({ predicate: 'hex://tags' })

  const nameMap = new Map(allProps.map((l) => [l.source, decodeLiteral(l.target)]))
  const typeMap = new Map(allTypes.map((l) => [l.source, decodeLiteral(l.target)]))
  const descMap = new Map(allDescs.map((l) => [l.source, decodeLiteral(l.target)]))

  const tagMap = new Map<string, string[]>()
  for (const l of allTags) {
    const list = tagMap.get(l.source) ?? []
    list.push(decodeLiteral(l.target))
    tagMap.set(l.source, list)
  }

  return iris
    .filter((iri) => nameMap.has(iri))
    .map((iri) => ({
      iri,
      kind: 'entity' as const,
      name: nameMap.get(iri) ?? '',
      entityType: typeMap.get(iri) ?? 'unknown',
      tags: tagMap.get(iri) ?? [],
      content: descMap.get(iri) ?? '',
      timestamp: 0,
      embedding: []
    }))
}

/** Query all Note subjects from the perspective. */
async function fetchNotes(queryLinks: LinkQueryFn): Promise<ForestNode[]> {
  const typeLinks = await queryLinks({ predicate: 'rdf://type', target: 'hex://Note' })
  const iris = typeLinks.map((l) => l.source)
  if (iris.length === 0) return []

  const allContent = await queryLinks({ predicate: 'hex://content' })
  const allTimestamp = await queryLinks({ predicate: 'hex://timestamp' })
  const allNoteType = await queryLinks({ predicate: 'hex://noteType' })

  const contentMap = new Map(allContent.map((l) => [l.source, decodeLiteral(l.target)]))
  const timestampMap = new Map(allTimestamp.map((l) => [l.source, decodeLiteral(l.target)]))
  const noteTypeMap = new Map(allNoteType.map((l) => [l.source, decodeLiteral(l.target)]))

  return iris
    .filter((iri) => contentMap.has(iri))
    .map((iri) => {
      const content = contentMap.get(iri) ?? ''
      return {
        iri,
        kind: 'note' as const,
        name: content.slice(0, 60).replace(/\n/g, ' '),
        entityType: noteTypeMap.get(iri) ?? 'note',
        tags: [],
        content,
        timestamp: Number(timestampMap.get(iri)) || 0,
        embedding: []
      }
    })
}

/** Query all hex:// relationship links (excluding property predicates). */
async function fetchLinks(queryLinks: LinkQueryFn): Promise<ForestLink[]> {
  // Fetch known relationship predicates directly
  const relationPredicates = [
    'hex://related_to',
    'hex://part_of',
    'hex://depends_on',
    'hex://works_on',
    'hex://built_with',
    'hex://supersedes',
    'hex://caused_by',
    'hex://about'
  ]

  const results: ForestLink[] = []
  for (const pred of relationPredicates) {
    const links = await queryLinks({ predicate: pred })
    for (const l of links) {
      results.push({ source: l.source, target: l.target, predicate: pred })
    }
  }

  return results
}

// ── Builder ────────────────────────────────────────────────────────

export interface Ad4mDeps {
  listPerspectives: () => Promise<Array<{ uuid: string; name: string }>>
  queryLinks: (
    perspectiveUuid: string,
    opts?: { source?: string; predicate?: string; target?: string }
  ) => Promise<Ad4mLink[]>
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

  const queryLinks: LinkQueryFn = async (opts) => {
    const result = await ad4m.queryLinks(perspectiveUuid, opts)
    return Array.isArray(result) ? result : []
  }

  // 2. Fetch data
  console.log('[forest] fetching entities...')
  const entities = await fetchEntities(queryLinks)
  console.log(`[forest] found ${entities.length} entities`)

  console.log('[forest] fetching notes...')
  const notes = await fetchNotes(queryLinks)
  console.log(`[forest] found ${notes.length} notes`)

  const allNodes = [...entities, ...notes]

  console.log('[forest] fetching links...')
  const allLinks = await fetchLinks(queryLinks)
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
