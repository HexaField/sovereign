// The annotation store: one canonical JSON file per annotation under
// `.graphcoder/annotations/`. Sorted keys and NFC text make equal content give
// equal bytes, so git diffs show only real edits.
//
// Only the v3 format is read. The v1/v2 shapes (members as bare id strings)
// predate every annotation file in use, so a reader for them would be dead code.

import type { RepoFiles } from '../ports.js'
import { deriveShape, type Annotation, type AnnotationMember, type ModuleSpec } from './types.js'

export const ANNOTATIONS_DIR = '.graphcoder/annotations'

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** A slug names a file in the annotations directory, so nothing else may pass for one */
export function isSlug(value: string): boolean {
  return SLUG.test(value)
}

export function slugify(label: string): string {
  const slug = label
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return slug || 'untitled'
}

const annotationPath = (slug: string) => {
  if (!isSlug(slug)) throw new Error(`Not an annotation slug: ${JSON.stringify(slug)}`)
  return `${ANNOTATIONS_DIR}/${slug}.json`
}

async function uniqueSlug(files: RepoFiles, label: string): Promise<string> {
  const base = slugify(label)
  const taken = new Set(await files.list(ANNOTATIONS_DIR))
  if (!taken.has(`${base}.json`)) return base
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}.json`)) return `${base}-${i}`
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sortKeys)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key])
  }
  return sorted
}

/** Sorted keys, two-space indent, NFC, trailing newline */
export function canonicalFileJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2).normalize('NFC') + '\n'
}

interface CommittedAnnotation {
  kind: string
  label: string
  description: string
  ordered: boolean
  members: AnnotationMember[]
  status?: 'proposed'
  author?: 'agent'
  reasoning?: string
  module?: ModuleSpec
}

/** What gets committed: derived fields (shape, id, runtime status) stay out */
export function toCommitted(annotation: Annotation): CommittedAnnotation {
  const committed: CommittedAnnotation = {
    description: annotation.description,
    kind: annotation.kind,
    label: annotation.label,
    members: annotation.members.map((m) => ({ id: m.id, ref: m.ref, file: m.file, note: m.note })),
    ordered: annotation.ordered
  }
  if (annotation.status === 'proposed') committed.status = 'proposed'
  if (annotation.author === 'agent') committed.author = 'agent'
  if (annotation.reasoning) committed.reasoning = annotation.reasoning
  if (annotation.module) committed.module = annotation.module
  return committed
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : []

function normalizeModuleSpec(raw: unknown): ModuleSpec | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const m = raw as Record<string, unknown>
  const spec: ModuleSpec = {
    paths: strings(m.paths),
    lanes: strings(m.lanes).slice(0, 2),
    dependsOn: (Array.isArray(m.dependsOn) ? (m.dependsOn as Array<Record<string, unknown>>) : [])
      .filter((d) => d && typeof d.module === 'string' && d.module !== '')
      .map((d) => ({ module: String(d.module), via: String(d.via ?? '') }))
  }
  if (typeof m.layer === 'number' && Number.isInteger(m.layer) && m.layer >= 0) spec.layer = m.layer
  if (typeof m.tier === 'string' && m.tier.trim() !== '') spec.tier = m.tier.trim()
  return spec
}

/** The runtime annotation for a committed file's parsed JSON, or null when it is not a v3 annotation */
export function parseAnnotation(raw: unknown, slug: string): Annotation | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.ordered !== 'boolean' || !Array.isArray(r.members)) return null
  if (!r.members.every((m) => m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string')) return null
  const members: AnnotationMember[] = (r.members as Array<Record<string, unknown>>).map((m) => ({
    id: String(m.id),
    ref: String(m.ref ?? ''),
    file: String(m.file ?? ''),
    note: String(m.note ?? '')
  }))
  const module = normalizeModuleSpec(r.module)
  return {
    id: slug,
    shape: deriveShape(r.ordered, members.length),
    kind: String(r.kind ?? ''),
    status: r.status === 'proposed' ? 'proposed' : 'active',
    label: String(r.label ?? ''),
    description: String(r.description ?? ''),
    ordered: r.ordered,
    members,
    ...(r.author === 'agent' ? { author: 'agent' as const } : {}),
    reasoning: typeof r.reasoning === 'string' ? r.reasoning : null,
    ...(module ? { module } : {})
  }
}

export interface NewAnnotation {
  kind?: string
  description?: string
  ordered?: boolean
  status?: Annotation['status']
  author?: 'human' | 'agent'
  reasoning?: string | null
  module?: ModuleSpec
}

/** An unsaved annotation (empty id); `saveAnnotation` gives it a slug */
export function createAnnotation(label: string, members: AnnotationMember[], opts: NewAnnotation = {}): Annotation {
  const ordered = opts.ordered ?? false
  return {
    id: '',
    shape: deriveShape(ordered, members.length),
    kind: opts.kind ?? '',
    status: opts.status ?? 'active',
    label,
    description: opts.description ?? '',
    ordered,
    members,
    ...(opts.author ? { author: opts.author } : {}),
    reasoning: opts.reasoning ?? null,
    ...(opts.module ? { module: opts.module } : {})
  }
}

/** Writes the annotation; one without an id gets a fresh slug from its label. Returns the slug. */
export async function saveAnnotation(files: RepoFiles, annotation: Annotation): Promise<string> {
  const slug = annotation.id || (await uniqueSlug(files, annotation.label))
  await files.write(annotationPath(slug), canonicalFileJson(toCommitted(annotation)))
  return slug
}

/** The annotation with this slug, or null when the file is missing or not a v3 annotation */
export async function loadAnnotation(files: RepoFiles, slug: string): Promise<Annotation | null> {
  const text = await files.read(annotationPath(slug))
  if (text === null) return null
  try {
    return parseAnnotation(JSON.parse(text), slug)
  } catch {
    return null
  }
}

/** Every readable annotation, by slug; malformed files are skipped */
export async function loadAllAnnotations(files: RepoFiles): Promise<Annotation[]> {
  const slugs = (await files.list(ANNOTATIONS_DIR))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .filter(isSlug)
    .sort()
  const loaded = await Promise.all(slugs.map((slug) => loadAnnotation(files, slug)))
  return loaded.filter((a): a is Annotation => a !== null)
}

export async function deleteAnnotation(files: RepoFiles, slug: string): Promise<boolean> {
  return files.remove(annotationPath(slug))
}
