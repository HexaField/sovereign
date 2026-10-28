// Node categories — feature, bug, design, future (tech debt and enabling
// work). Pure. The rules below decide what a node's own data settles; they
// abstain on the rest, which rethink (forge_categorize) fills in. The user's
// choice beats both: user > rule > rethink.

import {
  WORK_CATEGORIES,
  type NodeCategoryRecord,
  type WorkCategory,
  type WorkCategorySource,
  type WorkNode
} from '@sovereign/core'

/** Forge labels (lower case, exact), checked in this order. A label match beats a title prefix. */
export const CATEGORY_LABELS: ReadonlyArray<readonly [WorkCategory, readonly string[]]> = [
  ['bug', ['bug', 'defect', 'regression']],
  ['feature', ['enhancement', 'feature']],
  ['design', ['design', 'rfc', 'proposal', 'spec', 'documentation', 'docs']],
  [
    'future',
    ['tech-debt', 'tech debt', 'debt', 'refactor', 'infrastructure', 'infra', 'chore', 'dependencies', 'maintenance']
  ]
]

/** Conventional-commit types at the start of a title (`type:`, `type(scope):`, `type!:`), any case. */
export const CATEGORY_PREFIXES: ReadonlyArray<readonly [WorkCategory, readonly string[]]> = [
  ['feature', ['feat']],
  ['bug', ['fix', 'revert', 'hotfix']],
  // "plan" also covers the planned-task titles ("Plan: …").
  ['design', ['docs', 'design', 'spec', 'rfc', 'plan', 'proposal']],
  ['future', ['refactor', 'chore', 'perf', 'test', 'ci', 'build', 'style', 'deps']]
]

const PREFIX_OF = new Map(CATEGORY_PREFIXES.flatMap(([c, ps]) => ps.map((p) => [p, c] as const)))
const PREFIX_RE = /^\s*([a-z]+)\s*(?:\([^)]*\))?\s*!?\s*:/i

export function isWorkCategory(x: unknown): x is WorkCategory {
  return typeof x === 'string' && (WORK_CATEGORIES as readonly string[]).includes(x)
}

/** The category the rules give a node, or undefined (abstain). */
export function ruleCategory(n: Pick<WorkNode, 'kind' | 'title' | 'labels'>): WorkCategory | undefined {
  if (n.kind === 'plan') return 'design'
  const labels = new Set(n.labels.map((l) => l.trim().toLowerCase()))
  for (const [category, names] of CATEGORY_LABELS) if (names.some((l) => labels.has(l))) return category
  const prefix = PREFIX_RE.exec(n.title)?.[1]
  return prefix ? PREFIX_OF.get(prefix.toLowerCase()) : undefined
}

/** user > rule > rethink. */
export function resolveCategory(
  n: Pick<WorkNode, 'kind' | 'title' | 'labels'>,
  stored: { user?: WorkCategory; rethink?: WorkCategory } = {}
): { category: WorkCategory; source: WorkCategorySource } | undefined {
  if (stored.user) return { category: stored.user, source: 'user' }
  const rule = ruleCategory(n)
  if (rule) return { category: rule, source: 'rule' }
  if (stored.rethink) return { category: stored.rethink, source: 'rethink' }
  return undefined
}

/** Set `category` / `categorySource` on every node (in place) from the rules and the stored choices. */
export function applyCategories(nodes: WorkNode[], records: NodeCategoryRecord[]): void {
  const stored = new Map<string, { user?: WorkCategory; rethink?: WorkCategory }>()
  for (const r of records) stored.set(r.nodeId, { ...stored.get(r.nodeId), [r.source]: r.category })
  for (const n of nodes) {
    const c = resolveCategory(n, stored.get(n.id))
    if (c) {
      n.category = c.category
      n.categorySource = c.source
    } else {
      delete n.category
      delete n.categorySource
    }
  }
}
