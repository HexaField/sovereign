// Semantic identity: a name for a symbol that survives moves between files.
//
// CodeGraph ids derive from file + qualified name, so a moved symbol gets a new
// one. A semantic id hashes kind, name and normalised signature instead. It
// leaves the file out on purpose, so same-named symbols collide (`render()` in
// two classes); `createMemberResolver` settles that for annotation members by
// the file each member records.

import type { GraphNode } from './graph.js'
import { sha256Hex } from './sha256.js'

/** Strip default parameter values and collapse whitespace. */
export function normalizeSignature(sig: string): string {
  return sig
    .replace(/\s*=\s*[^,)[\]{}]+(?=[,)\]])/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** sha256(kind \0 name \0 normalised signature), 64 hex chars. */
export function semanticId(kind: string, name: string, signature?: string): string {
  const sig = signature ? normalizeSignature(signature) : ''
  return sha256Hex(`${kind}\0${name}\0${sig}`)
}

export function nodeSemanticId(node: Pick<GraphNode, 'kind' | 'name' | 'signature' | 'filePath'>): string {
  // A file or module node stands for its path: two `index.ts` files are two entities.
  if (node.kind === 'file' || node.kind === 'module') {
    return semanticId(node.kind, node.filePath ?? node.name, node.signature)
  }
  return semanticId(node.kind, node.name, node.signature)
}

type IdentityFields = Pick<GraphNode, 'id' | 'kind' | 'name' | 'signature' | 'filePath'>

/**
 * Semantic id → CodeGraph id over two snapshots, so a view keyed by semantic
 * ids can call back into an index. Target ids win (the target is the current
 * code); base ids remain for removed nodes.
 */
export function buildDiffIdMap(baseNodes: IdentityFields[], targetNodes: IdentityFields[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const n of baseNodes) map.set(nodeSemanticId(n), n.id)
  for (const n of targetNodes) map.set(nodeSemanticId(n), n.id)
  return map
}

/** What an annotation member records about the symbol it names. */
export interface MemberRef {
  /** Semantic id */
  id: string
  /** File the symbol was in when the member was recorded */
  file: string
}

/**
 * Resolves annotation members against a graph. A member names the symbol with
 * its semantic id in its recorded file; failing that (the symbol moved), the
 * only symbol with that id; failing that (none, or a moved id that now names
 * several symbols), nothing. Import nodes never resolve: they repeat the name
 * of what they import.
 */
export function createMemberResolver<N extends GraphNode>(nodes: readonly N[]): (member: MemberRef) => N | undefined {
  const bySem = new Map<string, N[]>()
  for (const n of nodes) {
    if (n.kind === 'import') continue
    const sem = nodeSemanticId(n)
    const list = bySem.get(sem)
    if (list) list.push(n)
    else bySem.set(sem, [n])
  }
  return (member) => {
    const candidates = bySem.get(member.id) ?? []
    return candidates.find((n) => n.filePath === member.file) ?? (candidates.length === 1 ? candidates[0] : undefined)
  }
}
