// forge.trustedAuthors: which forge items and which actors' text may enter
// the Forge. Pure. The resolution (membrane list, else "*", else none) is
// `trustedAuthorsOf` in @sovereign/core, shared with the task importer.

import type { TrustedAuthors } from '@sovereign/core'
import type { ForgeEvent, RepoCache } from './types.js'

/** Whether a login may put an item or its text into the Forge. */
export type Trusts = (login: string) => boolean

/** No list: every author passes. */
export const trusts = (list: TrustedAuthors | undefined): Trusts => (list ? (login) => list.has(login) : () => true)

/** The error an untrusted author's item answers with (import, pollTask). */
export const untrustedMessage = (repo: string, id: string, login: string) =>
  `${repo}#${id} by ${login}: author not in forge.trustedAuthors`

/**
 * The cache with only trusted authors' changes and issues, and on each change
 * only reviews by trusted logins (an outsider's review is neither a card line
 * nor a status; a review request stays: the item's side asked for it); the
 * same object when nothing is dropped.
 */
export function trustedCache(c: RepoCache, ok: Trusts): RepoCache {
  const reviewOk = (r: { login: string; state: string }) => r.state === 'requested' || ok(r.login)
  const dirty =
    Object.values(c.changes).some((x) => !ok(x.author) || !x.reviewers.every(reviewOk)) ||
    Object.values(c.issues).some((i) => !ok(i.author))
  if (!dirty) return c
  const out: RepoCache = { ...c, changes: {}, issues: {} }
  for (const [id, x] of Object.entries(c.changes)) {
    if (!ok(x.author)) continue
    out.changes[id] = x.reviewers.every(reviewOk) ? x : { ...x, reviewers: x.reviewers.filter(reviewOk) }
  }
  for (const [id, i] of Object.entries(c.issues)) if (ok(i.author)) out.issues[id] = i
  return out
}

/**
 * Whether an event may be logged, triaged or shown: its item's author is
 * trusted (an unknown author counts as trusted: the item never entered a
 * cache), and so is every actor whose text or verdict it carries: commenters
 * (`commented` holds their text; one untrusted author drops the whole event,
 * since texts are not kept per author), reviewers (`reviewed`) and the item
 * that referenced it (`referenced`).
 */
export function admitsEvent(e: ForgeEvent, ok: Trusts, authorOf: (nodeId: string) => string | undefined): boolean {
  const known = (id: unknown) => (typeof id === 'string' ? authorOf(id) : undefined)
  const author = authorOf(e.nodeId)
  if (author !== undefined && !ok(author)) return false
  const d = e.detail
  switch (e.type) {
    case 'commented': {
      const authors: unknown[] = Array.isArray(d.authors) ? d.authors : []
      return authors.every((a) => typeof a === 'string' && ok(a))
    }
    case 'reviewed':
      return typeof d.login === 'string' && ok(d.login)
    // review_requested names who was asked, not who wrote anything: it stays
    case 'referenced': {
      const by = known(d.by)
      return by === undefined || ok(by)
    }
    default:
      return true
  }
}
