// GitHub transport — GraphQL and REST over fetch, with the token resolved
// once, retries on transient failures and an ETag cache for REST GETs.
//
// The API base is configurable so the wind tunnel can point the adapter at
// its mock GitHub; a GitHub Enterprise host works the same way
// (https://<host>/api/v3, GraphQL at https://<host>/api/graphql).

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const DEFAULT_GITHUB_API = 'https://api.github.com'

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface GithubTransportOpts {
  /** REST base, default https://api.github.com (or $SOVEREIGN_GITHUB_API_URL). */
  apiUrl?: string
  /** GraphQL endpoint; default `<apiUrl>/graphql`, or `<host>/api/graphql` for an Enterprise `/api/v3` base. */
  graphqlUrl?: string
  /** A fixed token. Otherwise $GITHUB_TOKEN, $GH_TOKEN, then `gh auth token`. */
  token?: string
  /** Reads the token from `gh` (injectable for tests). */
  ghToken?: () => Promise<string>
  env?: Record<string, string | undefined>
  fetch?: FetchFn
  /** Attempts after the first (default 4). */
  retries?: number
  /** First backoff (default 1 s), doubled per attempt. */
  backoffMs?: number
  /** Longest single wait, also the cap on a Retry-After or a rate-limit reset (default 60 s). */
  maxWaitMs?: number
  /** REST GET responses kept for ETag reuse (default 500). */
  etagCacheSize?: number
}

export interface RestResponse<T = any> {
  status: number
  body: T
  /** True when the server answered 304 and the cached body was reused. */
  cached: boolean
  headers: Headers
}

export class GithubError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'GithubError'
    this.status = status
  }
}

export interface GraphqlResult<T> {
  data: T
  /** Points this query cost, when the query asked for `rateLimit { cost }`. */
  cost?: number
}

export interface GithubTransport {
  apiUrl: string
  graphqlUrl: string
  graphql<T = any>(query: string, variables?: Record<string, unknown>): Promise<GraphqlResult<T>>
  rest<T = any>(method: string, apiPath: string, body?: unknown): Promise<RestResponse<T>>
  /** GET a list endpoint and follow its `Link: rel="next"` pages. */
  restPages<T = any>(apiPath: string, maxPages?: number): Promise<T[]>
  token(): Promise<string>
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function defaultGhToken(): Promise<string> {
  return execFileAsync('gh', ['auth', 'token']).then((r) => r.stdout.trim())
}

/** GraphQL lives at /api/graphql on Enterprise (REST at /api/v3), at /graphql on github.com. */
export function graphqlUrlFor(apiUrl: string): string {
  const base = apiUrl.replace(/\/+$/, '')
  return base.endsWith('/api/v3') ? `${base.slice(0, -'/v3'.length)}/graphql` : `${base}/graphql`
}

/**
 * Is this a response GitHub wants retried later? Returns the wait it asked for
 * (`hard` = the primary limit is spent until its reset), or undefined.
 */
function rateLimitWait(res: Response, bodyText: string, now: number): { ms: number; hard: boolean } | undefined {
  if (res.status !== 403 && res.status !== 429) return undefined
  const retryAfter = res.headers.get('retry-after')
  if (retryAfter && /^\d+$/.test(retryAfter)) return { ms: Number(retryAfter) * 1000, hard: false }
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'))
    if (reset) return { ms: Math.max(0, reset * 1000 - now), hard: true }
  }
  // Secondary limits without Retry-After: GitHub asks for at least a minute.
  if (/secondary rate limit|abuse detection/i.test(bodyText)) return { ms: 60_000, hard: false }
  if (res.status === 429) return { ms: 0, hard: false }
  return undefined
}

export function createGithubTransport(opts: GithubTransportOpts = {}): GithubTransport {
  const env = opts.env ?? process.env
  const apiUrl = (opts.apiUrl ?? env.SOVEREIGN_GITHUB_API_URL ?? DEFAULT_GITHUB_API).replace(/\/+$/, '')
  const graphqlUrl = opts.graphqlUrl ?? graphqlUrlFor(apiUrl)
  const doFetch: FetchFn = opts.fetch ?? ((url, init) => fetch(url, init))
  const retries = opts.retries ?? 4
  const backoffMs = opts.backoffMs ?? 1000
  const maxWaitMs = opts.maxWaitMs ?? 60_000
  const etagCacheSize = opts.etagCacheSize ?? 500
  const ghToken = opts.ghToken ?? defaultGhToken
  const etags = new Map<string, { etag: string; body: unknown }>()

  let token: string | undefined = opts.token ?? env.GITHUB_TOKEN ?? env.GH_TOKEN ?? undefined
  const fromGh = !token
  let pending: Promise<string> | undefined

  async function getToken(refresh = false): Promise<string> {
    if (token && !refresh) return token
    if (!fromGh) return token!
    pending ??= ghToken().finally(() => (pending = undefined))
    token = await pending
    if (!token) throw new GithubError('no GitHub token: set GITHUB_TOKEN or run `gh auth login`', 401)
    return token
  }

  // Set when GitHub says to stop (a spent primary limit, or a rate limit that
  // outlasted the retries): until then every call fails without a request.
  let blockedUntil = 0

  /** One HTTP exchange with retries. Returns the final response and its text. */
  async function send(url: string, init: RequestInit & { headers: Record<string, string> }) {
    if (Date.now() < blockedUntil) {
      const s = Math.ceil((blockedUntil - Date.now()) / 1000)
      throw new GithubError(`GitHub rate limit: no requests for another ${s} s (${url})`, 429)
    }
    let refreshed = false
    for (let attempt = 0; ; attempt++) {
      const headers = { ...init.headers, Authorization: `Bearer ${await getToken()}` }
      let res: Response
      try {
        res = await doFetch(url, { ...init, headers })
      } catch (err) {
        if (attempt >= retries) throw err
        await sleep(Math.min(backoffMs * 2 ** attempt, maxWaitMs))
        continue
      }
      if (res.status === 401 && fromGh && !refreshed) {
        refreshed = true
        await getToken(true)
        attempt--
        continue
      }
      const text = res.status === 304 || res.status === 204 ? '' : await res.text()
      const limited = rateLimitWait(res, text, Date.now())
      const transient = res.status >= 500 && res.status <= 599
      if (limited && attempt >= retries) blockedUntil = Date.now() + limited.ms
      if ((limited || transient) && attempt < retries) {
        if (limited?.hard && limited.ms > maxWaitMs) {
          blockedUntil = Date.now() + limited.ms
          throw new GithubError(
            `GitHub rate limit spent: resets in ${Math.ceil(limited.ms / 1000)} s (${url})`,
            res.status
          )
        }
        // Exponential backoff, or the server's own wait if it is longer.
        await sleep(Math.min(Math.max(limited?.ms ?? 0, backoffMs * 2 ** attempt), maxWaitMs))
        continue
      }
      return { res, text }
    }
  }

  const baseHeaders = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  }

  function remember(key: string, etag: string, body: unknown) {
    etags.delete(key)
    etags.set(key, { etag, body })
    if (etags.size > etagCacheSize) etags.delete(etags.keys().next().value!)
  }

  const transport: GithubTransport = {
    apiUrl,
    graphqlUrl,
    token: () => getToken(),

    async graphql(query, variables = {}) {
      for (let attempt = 0; ; attempt++) {
        const { res, text } = await send(graphqlUrl, {
          method: 'POST',
          headers: { ...baseHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables })
        })
        if (res.status !== 200) {
          throw new GithubError(`GitHub GraphQL ${res.status}: ${text.slice(0, 300)}`, res.status)
        }
        const json = JSON.parse(text) as { data?: any; errors?: Array<{ type?: string; message: string }> }
        if (json.errors?.length) {
          // A rate-limited query answers 200 with an error, not a status.
          if (json.errors.some((e) => e.type === 'RATE_LIMITED') && attempt < retries) {
            await sleep(Math.min(backoffMs * 2 ** attempt, maxWaitMs))
            continue
          }
          const notFound = json.errors.some((e) => e.type === 'NOT_FOUND')
          throw new GithubError(`GitHub GraphQL: ${json.errors.map((e) => e.message).join('; ')}`, notFound ? 404 : 400)
        }
        return { data: json.data, cost: json.data?.rateLimit?.cost }
      }
    },

    async rest(method, apiPath, body) {
      const url = /^https?:/.test(apiPath) ? apiPath : `${apiUrl}/${apiPath.replace(/^\/+/, '')}`
      const isGet = method.toUpperCase() === 'GET'
      const cached = isGet ? etags.get(url) : undefined
      const { res, text } = await send(url, {
        method,
        headers: {
          ...baseHeaders,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(cached ? { 'If-None-Match': cached.etag } : {})
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      })
      if (res.status === 304 && cached) {
        remember(url, cached.etag, cached.body)
        return { status: 304, body: cached.body as any, cached: true, headers: res.headers }
      }
      if (res.status >= 400) {
        let message = text.slice(0, 300)
        try {
          message = JSON.parse(text).message ?? message
        } catch {
          // not JSON
        }
        throw new GithubError(`GitHub ${method} ${apiPath}: ${res.status} ${message}`, res.status)
      }
      const parsed = text ? JSON.parse(text) : undefined
      const etag = res.headers.get('etag')
      if (isGet && etag) remember(url, etag, parsed)
      return { status: res.status, body: parsed, cached: false, headers: res.headers }
    },

    async restPages(apiPath, maxPages = 10) {
      const out: any[] = []
      let next: string | undefined = apiPath
      for (let page = 0; next && page < maxPages; page++) {
        const r: RestResponse = await transport.rest('GET', next)
        if (Array.isArray(r.body)) out.push(...r.body)
        const link = r.headers.get('link') ?? ''
        next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1]
      }
      return out
    }
  }
  return transport
}
