/**
 * Annotation kind registry, `.graphcoder/annotation-kinds.json`.
 *
 * Kinds are user-defined and created on first use. The registry gives each a
 * stable colour and lists them for autocomplete; it never limits what a kind
 * may be. Names match case-insensitively and keep the case first typed.
 */

import type { RepoFiles } from '../ports.js'
import type { AnnotationKind } from './types.js'

export const KINDS_FILE = '.graphcoder/annotation-kinds.json'

/** Distinguishable on light and dark backgrounds */
export const KIND_PALETTE = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#14b8a6', // teal
  '#f97316', // orange
  '#6366f1', // indigo
  '#84cc16' // lime
]

const normalizeName = (name: string) => name.trim().toLowerCase()

/** A palette colour seeded by the name, skipping colours already taken while any are free */
function colorForName(name: string, taken: Set<string>): string {
  let hash = 0
  const key = normalizeName(name)
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  const start = hash % KIND_PALETTE.length
  for (let i = 0; i < KIND_PALETTE.length; i++) {
    const candidate = KIND_PALETTE[(start + i) % KIND_PALETTE.length]
    if (!taken.has(candidate)) return candidate
  }
  return KIND_PALETTE[start]
}

/** The registry; empty when the file is missing or unreadable */
export async function loadKinds(files: RepoFiles): Promise<AnnotationKind[]> {
  const text = await files.read(KINDS_FILE)
  if (text === null) return []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  return raw
    .filter((k): k is Record<string, unknown> => typeof k === 'object' && k !== null)
    .map((k) => ({
      name: typeof k.name === 'string' ? k.name : '',
      color: typeof k.color === 'string' ? k.color : KIND_PALETTE[0],
      description: typeof k.description === 'string' ? k.description : '',
      createdAt: typeof k.createdAt === 'string' ? k.createdAt : ''
    }))
    .filter((k) => k.name.length > 0)
}

export async function saveKinds(files: RepoFiles, kinds: AnnotationKind[]): Promise<void> {
  await files.write(KINDS_FILE, JSON.stringify(kinds, null, 2) + '\n')
}

export function findKind(kinds: AnnotationKind[], name: string): AnnotationKind | null {
  const key = normalizeName(name)
  return kinds.find((k) => normalizeName(k.name) === key) ?? null
}

/** The kind with this name, registered with a colour when new. Null for a blank name. */
export async function ensureKind(files: RepoFiles, name: string, description = ''): Promise<AnnotationKind | null> {
  const trimmed = name.trim()
  if (trimmed.length === 0) return null
  const kinds = await loadKinds(files)
  const existing = findKind(kinds, trimmed)
  if (existing) return existing
  const created: AnnotationKind = {
    name: trimmed,
    color: colorForName(trimmed, new Set(kinds.map((k) => k.color))),
    description,
    createdAt: new Date().toISOString()
  }
  await saveKinds(files, [...kinds, created])
  return created
}

/** Changes a kind's name, colour or description. Null when it does not exist or the new name is blank or taken. */
export async function updateKind(
  files: RepoFiles,
  name: string,
  updates: Partial<Pick<AnnotationKind, 'name' | 'color' | 'description'>>
): Promise<AnnotationKind | null> {
  const kinds = await loadKinds(files)
  const existing = findKind(kinds, name)
  if (!existing) return null
  if (updates.name !== undefined) {
    const renamed = updates.name.trim()
    const collision = findKind(kinds, renamed)
    if (renamed.length === 0 || (collision && collision !== existing)) return null
    existing.name = renamed
  }
  if (updates.color !== undefined) existing.color = updates.color
  if (updates.description !== undefined) existing.description = updates.description
  await saveKinds(files, kinds)
  return existing
}

/** Removes a kind from the registry; annotations keep their kind string */
export async function deleteKind(files: RepoFiles, name: string): Promise<boolean> {
  const kinds = await loadKinds(files)
  const key = normalizeName(name)
  const next = kinds.filter((k) => normalizeName(k.name) !== key)
  if (next.length === kinds.length) return false
  await saveKinds(files, next)
  return true
}

/**
 * Registers every kind in use that the registry lacks (hand-edited files, kinds an agent coined), so each shows a
 * stable colour. Writes only when something was added. Returns the registry.
 */
export async function syncKindsFromAnnotations(files: RepoFiles, usedKinds: string[]): Promise<AnnotationKind[]> {
  const kinds = await loadKinds(files)
  const taken = new Set(kinds.map((k) => k.color))
  let changed = false
  for (const name of usedKinds) {
    const trimmed = name.trim()
    if (trimmed.length === 0 || findKind(kinds, trimmed)) continue
    const color = colorForName(trimmed, taken)
    taken.add(color)
    kinds.push({ name: trimmed, color, description: '', createdAt: new Date().toISOString() })
    changed = true
  }
  if (changed) await saveKinds(files, kinds)
  return kinds
}
