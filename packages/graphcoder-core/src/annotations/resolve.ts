import type { MemberRef } from '../identity.js'
import type { Annotation, AnnotationMember } from './types.js'

export interface ResolutionResult {
  resolved: AnnotationMember[]
  unresolved: AnnotationMember[]
}

/** Splits members into those the graph still holds and those it lost. `resolve`: see `createMemberResolver`. */
export function resolveAnnotation(annotation: Annotation, resolve: (m: MemberRef) => unknown): ResolutionResult {
  const resolved: AnnotationMember[] = []
  const unresolved: AnnotationMember[] = []
  for (const member of annotation.members) (resolve(member) ? resolved : unresolved).push(member)
  return { resolved, unresolved }
}

/** The annotations with at least one member the graph lost, by slug */
export function findStaleAnnotations(
  annotations: Annotation[],
  resolve: (m: MemberRef) => unknown
): Map<string, ResolutionResult> {
  const stale = new Map<string, ResolutionResult>()
  for (const annotation of annotations) {
    const result = resolveAnnotation(annotation, resolve)
    if (result.unresolved.length > 0) stale.set(annotation.id, result)
  }
  return stale
}
