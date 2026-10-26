// GET /api/timeline?since=&until=&kinds=&origins=&limit=&before= — newest first.

import { Router, type Request, type Response } from 'express'
import { TIMELINE_KINDS, TURN_ORIGINS } from '@sovereign/core'
import type { TimelineService } from './service.js'
import { DEFAULT_LIMIT, idTime, MAX_LIMIT, type TimelineQuery } from './store.js'

export type Auth = (req: Request, res: Response, next: () => void) => void

class BadQuery extends Error {}

/** One query parameter as a string; a repeated one is an error. */
function one(req: Request, k: string): string | undefined {
  const v = req.query[k]
  if (v === undefined) return undefined
  if (typeof v !== 'string') throw new BadQuery(`${k} must be given once`)
  return v
}

function time(req: Request, k: string): string | undefined {
  const v = one(req, k)
  if (v === undefined) return undefined
  // ISO 8601 only: Date.parse alone accepts free-form dates.
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v) || !Number.isFinite(Date.parse(v)))
    throw new BadQuery(`${k} must be an ISO time`)
  return new Date(Date.parse(v)).toISOString()
}

function list(req: Request, k: string, allowed: readonly string[]): string[] | undefined {
  const v = one(req, k)
  if (v === undefined || v === '') return undefined
  const items = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const bad = items.filter((s) => !allowed.includes(s))
  if (bad.length) throw new BadQuery(`${k}: unknown ${bad.join(', ')} (one of ${allowed.join(', ')})`)
  return items
}

export function parseTimelineQuery(req: Request): TimelineQuery {
  const q: TimelineQuery = {}
  const since = time(req, 'since')
  const until = time(req, 'until')
  if (since) q.since = since
  if (until) q.until = until
  const kinds = list(req, 'kinds', TIMELINE_KINDS)
  const origins = list(req, 'origins', TURN_ORIGINS)
  if (kinds) q.kinds = kinds
  if (origins) q.origins = origins
  const limit = one(req, 'limit')
  if (limit !== undefined) {
    const n = Number(limit)
    if (!/^\d+$/.test(limit) || n < 1 || n > MAX_LIMIT) throw new BadQuery(`limit must be 1–${MAX_LIMIT}`)
    q.limit = n
  } else q.limit = DEFAULT_LIMIT
  const before = one(req, 'before')
  if (before !== undefined) {
    if (idTime(before) === undefined) throw new BadQuery('before must be an entry id (a page’s next)')
    q.before = before
  }
  return q
}

export function createTimelineRouter(service: TimelineService, auth: Auth): Router {
  const router = Router()
  router.get('/api/timeline', auth, (req, res) => {
    let q: TimelineQuery
    try {
      q = parseTimelineQuery(req)
    } catch (err) {
      if (err instanceof BadQuery) return res.status(400).json({ error: err.message })
      throw err
    }
    res.json(service.query(q))
  })
  return router
}
