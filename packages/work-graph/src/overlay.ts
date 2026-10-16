// Agent overlay — live, never stored. Who works on each node and what it
// waits on: the task's owner thread (the one source of ownership) and its
// presence, subagents mapped cwd → branch → change, and CI watches.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentOverlay, WorkNode } from '@sovereign/core'
import { primaryRepo } from '@sovereign/forges'
import type { ActiveCiWatch, ActiveSubagent, PortTask, ThreadPresence } from './types.js'

const execFileAsync = promisify(execFile)

/** `git -C <cwd> branch --show-current`; undefined on a detached head or no repo. */
export async function currentBranch(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'branch', '--show-current'], { timeout: 5000 })
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

export interface OverlayInput {
  nodes: WorkNode[]
  tasks: PortTask[]
  presence(threadId: string): ThreadPresence | undefined
  subagents: ActiveSubagent[]
  ciWatches: ActiveCiWatch[]
  /** Resolved checkout of each subagent cwd: its repo ("owner/name") and branch. */
  checkouts: Map<string, { repo?: string; branch?: string }>
}

export interface OverlayResult {
  overlays: AgentOverlay[]
  /** Subagents no change matched (listed rather than guessed). */
  unmatched: Array<{ key: string; label: string; parentThreadId: string; cwd?: string; branch?: string }>
  /** Changes an agent picked up that no thread owns yet: auto-link them to this thread. */
  claims: Array<{ nodeId: string; threadId: string; by: 'subagent' | 'ci-watch' }>
}

/** What a node waits on: CI pending → ci; review requested with CI green → review; owner idle on a question → user. */
export function waitingOn(
  node: WorkNode,
  ov: Pick<AgentOverlay, 'thread' | 'ciWatch'>,
  openQuestion: boolean
): AgentOverlay['waitingOn'] {
  if (node.ci === 'pending' || ov.ciWatch?.state === 'waiting') return 'ci'
  const reviewWanted = node.reviewers.some((r) => r.state === 'requested')
  if (reviewWanted && (node.ci === 'passing' || node.ci === 'none' || node.ci === undefined)) return 'review'
  if (ov.thread?.status === 'idle' && openQuestion) return 'user'
  return null
}

export function buildOverlay(input: OverlayInput): OverlayResult {
  const byId = new Map(input.nodes.map((n) => [n.id, n]))
  const out = new Map<string, AgentOverlay & { _q?: boolean }>()
  const slot = (nodeId: string) => {
    let o = out.get(nodeId)
    if (!o) {
      o = { nodeId, subagents: [] }
      out.set(nodeId, o)
    }
    return o
  }

  for (const t of input.tasks) {
    if (!t.threadId) continue
    const nodeId = t.key && byId.has(t.key) ? t.key : !t.key && byId.has(`task:${t.id}`) ? `task:${t.id}` : undefined
    if (!nodeId) continue
    const p = input.presence(t.threadId)
    const o = slot(nodeId)
    o.thread = { id: t.threadId, label: p?.label ?? t.threadId, status: p?.status ?? 'idle' }
    o._q = Boolean(p?.openQuestion)
  }

  // Change by repo + head branch (open first, then newest).
  const changeByBranch = new Map<string, WorkNode>()
  for (const n of input.nodes) {
    if (n.kind !== 'change' || !n.repo || !n.branch?.head) continue
    const k = `${n.repo.toLowerCase()}\u0000${n.branch.head}`
    const prev = changeByBranch.get(k)
    const open = (x: WorkNode) => x.state === 'open' || x.state === 'draft'
    if (!prev || (open(n) && !open(prev)) || (open(n) === open(prev) && n.updatedAt > prev.updatedAt))
      changeByBranch.set(k, n)
  }

  const owned = new Set(input.tasks.filter((t) => t.threadId && t.key).map((t) => t.key!))
  const claims: OverlayResult['claims'] = []
  const claim = (nodeId: string, threadId: string, by: 'subagent' | 'ci-watch') => {
    if (!owned.has(nodeId) && !claims.some((c) => c.nodeId === nodeId)) claims.push({ nodeId, threadId, by })
  }
  const unmatched: OverlayResult['unmatched'] = []
  for (const s of input.subagents) {
    const co = s.cwd ? input.checkouts.get(s.cwd) : undefined
    const node = co?.repo && co.branch ? changeByBranch.get(`${co.repo.toLowerCase()}\u0000${co.branch}`) : undefined
    if (!node) {
      unmatched.push({
        key: s.key,
        label: s.label,
        parentThreadId: s.parentThreadId,
        ...(s.cwd ? { cwd: s.cwd } : {}),
        ...(co?.branch ? { branch: co.branch } : {})
      })
      continue
    }
    slot(node.id).subagents.push({ key: s.key, label: s.label, startedAt: s.startedAt })
    claim(node.id, s.parentThreadId, 'subagent')
  }

  for (const w of input.ciWatches) {
    let node: WorkNode | undefined
    const target = w.target
    if (target.kind === 'pr') {
      node = input.nodes.find(
        (n) => n.kind === 'change' && n.repo?.toLowerCase() === w.repo.toLowerCase() && n.number === target.number
      )
    } else if (target.kind === 'branch') {
      node = changeByBranch.get(`${w.repo.toLowerCase()}\u0000${target.name}`)
    }
    if (!node) continue
    claim(node.id, w.threadKey, 'ci-watch')
    const o = slot(node.id)
    if (!o.ciWatch || w.createdAt < o.ciWatch.since) o.ciWatch = { state: 'waiting', since: w.createdAt }
  }

  const overlays: AgentOverlay[] = []
  for (const o of out.values()) {
    const node = byId.get(o.nodeId)!
    const { _q, ...ov } = o
    overlays.push({ ...ov, waitingOn: waitingOn(node, ov, Boolean(_q)) })
  }
  overlays.sort((a, b) => a.nodeId.localeCompare(b.nodeId))
  return { overlays, unmatched, claims }
}

/** Resolve each subagent cwd to its repo and branch. */
export async function resolveCheckouts(
  subagents: ActiveSubagent[],
  branchOf: (cwd: string) => Promise<string | undefined> = currentBranch
): Promise<Map<string, { repo?: string; branch?: string }>> {
  const out = new Map<string, { repo?: string; branch?: string }>()
  for (const cwd of new Set(subagents.map((s) => s.cwd).filter((c): c is string => Boolean(c)))) {
    const repo = primaryRepo(cwd)?.repo
    const branch = await branchOf(cwd)
    out.set(cwd, { ...(repo ? { repo } : {}), ...(branch ? { branch } : {}) })
  }
  return out
}
