// Loop 1's decision-model tier: a ForgeClassifier over llama.cpp's native
// decision-model endpoint, POST <url>/v1/systemone (llama.cpp PR #29818,
// TypeSafe-compatible). One `choice` question per event:
//
//   → { state: "<event + node card>", questions: { triage: { type: 'choice',
//       instructions, criteria: { 'needs-agent': …, info: … } } }, model? }
//   ← { answers: { triage: { type: 'choice', choice, probabilities, confidence } } }
//
// The confidence handed to triage is the probability of the chosen option
// (the response's `confidence` is 0 when every option is equally likely, so
// for two options it is not a probability). Every failure (no url, transport,
// HTTP status, timeout, a malformed answer) returns undefined, so triage
// falls through to needs-agent and sync never waits on a dead server: after a
// failure the classifier stays quiet for `retryAfterMs`.

import type { WorkNode } from '@sovereign/core'
import type { ForgeClassifier, ForgeEvent, TriageVerdict } from './types.js'

export interface SystemOneConfig {
  url: string
  model?: string
  timeoutMs?: number
}

export interface SystemOneClassifierOptions {
  /** Read on every call, so a config change applies at once. Undefined (or no url): no classifier answer. */
  config: () => SystemOneConfig | undefined
  fetch?: typeof fetch
  now?: () => number
  /** Pause after a failure. Default 60 s. */
  retryAfterMs?: number
  log?: (msg: string) => void
}

export const SYSTEMONE_QUESTION = {
  type: 'choice',
  instructions:
    'This is an event from a software work graph (GitHub pull requests, issues, branches, plans). Does it need an agent to act on it (fix, rebase, reply, decide, tell the owner), or is it information only?',
  criteria: {
    'needs-agent':
      'Someone has to act: a question or request in a comment, a failure or conflict on work someone owns, a decision to make.',
    info: 'Nothing to do: progress, routine activity, a change that needs no reply.'
  }
} as const

const DEFAULT_TIMEOUT_MS = 5000
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function detailText(detail: Record<string, unknown>): string {
  const out: string[] = []
  for (const [k, v] of Object.entries(detail)) {
    if (v === undefined || v === null || v === '') continue
    const text = Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' | ') : v
    out.push(`${k}: ${clip(typeof text === 'string' ? text : JSON.stringify(text), 400)}`)
  }
  return out.join('\n')
}

/** The node card as plain lines (also used by the rethink prompt). */
export function nodeCardLines(node: WorkNode): string[] {
  const lines: string[] = []
  const ref = node.number !== undefined ? `${node.repo}#${node.number}` : node.id
  lines.push(`${node.kind} ${ref} "${node.title}" (${node.state})`)
  if (node.ci && node.ci !== 'none') lines.push(`CI: ${node.ci}`)
  const reviews = node.reviewers.map((r) => `${r.login} ${r.state.replace('_', ' ')}`)
  if (reviews.length) lines.push(`Reviews: ${reviews.join(', ')}`)
  if (node.branch) {
    const b = node.branch
    const parts = [`${b.head} → ${b.base}`]
    if (b.ahead !== undefined) parts.push(`ahead ${b.ahead}`)
    if (b.behind !== undefined) parts.push(`behind ${b.behind}`)
    if (b.conflict) parts.push('conflict')
    lines.push(`Branch: ${parts.join(', ')}`)
  }
  if (node.author) lines.push(`Author: ${node.author}`)
  if (node.assignees.length) lines.push(`Assignees: ${node.assignees.join(', ')}`)
  if (node.labels.length) lines.push(`Labels: ${node.labels.join(', ')}`)
  if (node.status) lines.push(`Status: ${node.status}`)
  return lines
}

/** The `state` the decision model reads: the event, then the node card. */
export function classifierState(input: { event: ForgeEvent; node?: WorkNode; owned: boolean }): string {
  const { event, node, owned } = input
  const lines = [`Event: ${event.type.replace(/_/g, ' ')}`]
  const detail = detailText(event.detail)
  if (detail) lines.push(detail)
  lines.push('')
  if (node) lines.push(...nodeCardLines(node))
  else lines.push(`Item: ${event.nodeId}`)
  lines.push(owned ? 'An agent thread owns this item.' : 'No agent thread owns this item.')
  return lines.join('\n')
}

/** Parse one /v1/systemone answer; undefined unless it is a well-formed needs-agent | info choice. */
export function parseSystemOneAnswer(body: unknown): { choice: TriageVerdict; confidence: number } | undefined {
  const a = (body as { answers?: Record<string, any> } | null)?.answers?.triage
  if (!a || typeof a !== 'object') return undefined
  const choice = a.choice
  if (choice !== 'needs-agent' && choice !== 'info') return undefined
  const p = a.probabilities?.[choice]
  const confidence = typeof p === 'number' ? p : a.confidence
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    return undefined
  return { choice, confidence }
}

export function createSystemOneClassifier(opts: SystemOneClassifierOptions): ForgeClassifier {
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const now = opts.now ?? Date.now
  const retryAfter = opts.retryAfterMs ?? 60_000
  let quietUntil = 0

  const failed = (msg: string) => {
    quietUntil = now() + retryAfter
    opts.log?.(`classifier: ${msg}; skipping the model for ${Math.round(retryAfter / 1000)} s`)
    return undefined
  }

  return {
    async classify(input) {
      const c = opts.config()
      const base = c?.url?.trim()
      if (!base || now() < quietUntil) return undefined
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), c?.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      try {
        const res = await doFetch(`${base.replace(/\/+$/, '')}/v1/systemone`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(c?.model ? { model: c.model } : {}),
            state: classifierState(input),
            questions: { triage: SYSTEMONE_QUESTION }
          }),
          signal: ctl.signal
        })
        if (!res.ok) return failed(`HTTP ${res.status}`)
        const answer = parseSystemOneAnswer(await res.json())
        return answer ?? failed('malformed answer')
      } catch (err) {
        return failed(ctl.signal.aborted ? 'timed out' : (err as Error).message)
      } finally {
        clearTimeout(timer)
      }
    }
  }
}
