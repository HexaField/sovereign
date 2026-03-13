// Planning Module — Dependency Parser

import type { DependencyEdge, EntityRef } from './types.js'

const PATTERNS = [
  // "depends on" / "blocked by" → depends_on (this issue depends on the referenced one)
  {
    regex: /(?:depends\s+on|blocked\s+by)\s+((?:rad:[a-zA-Z0-9]+|[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)#(\d+)|#(\d+))/gi,
    type: 'depends_on' as const
  },
  // "blocks" → blocks (this issue blocks the referenced one, i.e., referenced depends on this)
  {
    regex: /\bblocks\s+((?:rad:[a-zA-Z0-9]+|[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)#(\d+)|#(\d+))/gi,
    type: 'blocks' as const
  }
]

function parseRef(
  match: RegExpExecArray,
  context: { orgId: string; projectId: string; remote: string }
): { ref: EntityRef; crossRepo: boolean } {
  // match[1] = full cross-repo ref or undefined
  // match[2] = issue number for cross-repo
  // match[3] = issue number for bare #N
  if (match[3]) {
    // Bare #N reference
    return {
      ref: { orgId: context.orgId, projectId: context.projectId, remote: context.remote, issueId: match[3] },
      crossRepo: false
    }
  }

  const full = match[1]!
  const issueNum = match[2]!

  if (full.startsWith('rad:')) {
    // Radicle: rad:z...#42
    const radId = full.split('#')[0]!
    return {
      ref: { orgId: context.orgId, projectId: radId, remote: 'radicle', issueId: issueNum },
      crossRepo: true
    }
  }

  // Cross-repo: org/repo#42
  const parts = full.split('#')[0]!
  const [org, repo] = parts.split('/')
  return {
    ref: { orgId: org!, projectId: repo!, remote: context.remote, issueId: issueNum },
    crossRepo: true
  }
}

export function parseDependencies(
  body: string,
  context: { orgId: string; projectId: string; remote: string }
): DependencyEdge[] {
  const edges: DependencyEdge[] = []
  const thisRef: EntityRef = {
    orgId: context.orgId,
    projectId: context.projectId,
    remote: context.remote,
    issueId: '0'
  }

  for (const pattern of PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags)
    let match: RegExpExecArray | null
    while ((match = regex.exec(body)) !== null) {
      const { ref } = parseRef(match, context)

      if (pattern.type === 'depends_on') {
        // This issue depends on ref
        edges.push({ from: thisRef, to: ref, type: 'depends_on', source: 'body' })
      } else {
        // This issue blocks ref → ref depends on this
        edges.push({ from: ref, to: thisRef, type: 'blocks', source: 'body' })
      }
    }
  }

  return edges
}
