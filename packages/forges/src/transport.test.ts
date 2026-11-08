import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGithubTransport, graphqlUrlFor, GithubError } from './transport.js'

const API = 'https://api.github.test'

type Step = { status?: number; body?: unknown; headers?: Record<string, string> } | Error

/** A fetch that answers each call with the next step (the last one repeats). */
function scripted(steps: Step[]) {
  const calls: Array<{ url: string; init: RequestInit & { headers: Record<string, string> } }> = []
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init as any })
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]
    if (step instanceof Error) throw step
    const status = step.status ?? 200
    return new Response(status === 304 || status === 204 ? null : JSON.stringify(step.body ?? {}), {
      status,
      headers: step.headers
    })
  })
  return { calls, fetchFn }
}

describe('token', () => {
  it('prefers an explicit token, then GITHUB_TOKEN, then GH_TOKEN, then gh', async () => {
    const gh = vi.fn(async () => 'from-gh')
    expect(await createGithubTransport({ token: 'a', env: { GITHUB_TOKEN: 'b' }, ghToken: gh }).token()).toBe('a')
    expect(await createGithubTransport({ env: { GITHUB_TOKEN: 'b', GH_TOKEN: 'c' }, ghToken: gh }).token()).toBe('b')
    expect(await createGithubTransport({ env: { GH_TOKEN: 'c' }, ghToken: gh }).token()).toBe('c')
    expect(gh).not.toHaveBeenCalled()
    expect(await createGithubTransport({ env: {}, ghToken: gh }).token()).toBe('from-gh')
  })

  it('asks gh once and caches the answer across concurrent calls', async () => {
    const gh = vi.fn(async () => 'from-gh')
    const t = createGithubTransport({ env: {}, ghToken: gh })
    expect(await Promise.all([t.token(), t.token(), t.token()])).toEqual(['from-gh', 'from-gh', 'from-gh'])
    expect(gh).toHaveBeenCalledTimes(1)
  })

  it('re-reads a gh token once on 401', async () => {
    let n = 0
    const gh = vi.fn(async () => `tok${++n}`)
    const { calls, fetchFn } = scripted([
      { status: 401, body: { message: 'Bad credentials' } },
      { body: { login: 'x' } }
    ])
    const t = createGithubTransport({ apiUrl: API, env: {}, ghToken: gh, fetch: fetchFn })
    expect((await t.rest('GET', 'user')).body).toEqual({ login: 'x' })
    expect(calls.map((c) => c.init.headers.Authorization)).toEqual(['Bearer tok1', 'Bearer tok2'])
  })

  it('does not retry a 401 for a fixed token', async () => {
    const { calls, fetchFn } = scripted([{ status: 401, body: { message: 'Bad credentials' } }])
    const t = createGithubTransport({ apiUrl: API, token: 'fixed', fetch: fetchFn })
    await expect(t.rest('GET', 'user')).rejects.toMatchObject({
      status: 401,
      message: expect.stringMatching(/Bad credentials/)
    })
    expect(calls).toHaveLength(1)
  })

  it('reads the API base from SOVEREIGN_GITHUB_API_URL', () => {
    const t = createGithubTransport({
      env: { SOVEREIGN_GITHUB_API_URL: 'http://mock-github:8910/', GITHUB_TOKEN: 'x' }
    })
    expect(t.apiUrl).toBe('http://mock-github:8910')
    expect(t.graphqlUrl).toBe('http://mock-github:8910/graphql')
    expect(graphqlUrlFor('https://api.github.com')).toBe('https://api.github.com/graphql')
    expect(graphqlUrlFor('https://ghe.example.org/api/v3')).toBe('https://ghe.example.org/api/graphql')
  })
})

describe('retries', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-03-02T10:00:00Z') }))
  afterEach(() => vi.useRealTimers())

  it('backs off 1 s, 2 s, 4 s on 5xx and network errors, then succeeds', async () => {
    const { calls, fetchFn } = scripted([
      { status: 502, body: { message: 'Bad Gateway' } },
      new TypeError('fetch failed'),
      { status: 503 },
      { body: { ok: true } }
    ])
    const t = createGithubTransport({ apiUrl: API, token: 'x', fetch: fetchFn })
    const p = t.rest('GET', 'repos/acme-labs/widget')
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(4000)
    expect(calls).toHaveLength(4)
    expect((await p).body).toEqual({ ok: true })
  })

  it('gives up after the configured retries with the last error', async () => {
    const { calls, fetchFn } = scripted([{ status: 500, body: { message: 'boom' } }])
    const t = createGithubTransport({ apiUrl: API, token: 'x', fetch: fetchFn, retries: 2, backoffMs: 10 })
    const p = t.rest('GET', 'user')
    const done = expect(p).rejects.toMatchObject({ status: 500 })
    await vi.advanceTimersByTimeAsync(100)
    await done
    expect(calls).toHaveLength(3)
  })

  it('rethrows a network error once retries run out', async () => {
    const { fetchFn } = scripted([new TypeError('fetch failed')])
    const t = createGithubTransport({ apiUrl: API, token: 'x', fetch: fetchFn, retries: 1, backoffMs: 10 })
    const done = expect(t.rest('GET', 'user')).rejects.toThrow('fetch failed')
    await vi.advanceTimersByTimeAsync(100)
    await done
  })

  it('waits as long as Retry-After asks on a secondary rate limit', async () => {
    const { calls, fetchFn } = scripted([
      { status: 403, headers: { 'retry-after': '7' }, body: { message: 'You have exceeded a secondary rate limit.' } },
      { body: { ok: 1 } }
    ])
    const t = createGithubTransport({ apiUrl: API, token: 'x', fetch: fetchFn })
    const p = t.rest('GET', 'user')
    await vi.advanceTimersByTimeAsync(6999)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(2)
    expect((await p).body).toEqual({ ok: 1 })
  })

  it('waits a minute on a secondary rate limit without Retry-After', async () => {
    const { calls, fetchFn } = scripted([
      { status: 403, body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes.' } },
      { body: { ok: 1 } }
    ])
    const t = createGithubTransport({ apiUrl: API, token: 'x', fetch: fetchFn })
    const p = t.rest('GET', 'user')
    await vi.advanceTimersByTimeAsync(59_999)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect((await p).body).toEqual({ ok: 1 })
  })

  it('waits for a near primary-limit reset, but fails fast when the reset is far off', async () => {
    const reset = (s: number) => String(Math.floor(Date.now() / 1000) + s)
    const near = scripted([
      {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset(5) },
        body: { message: 'API rate limit exceeded' }
      },
      { body: { ok: 1 } }
    ])
    const p = createGithubTransport({ apiUrl: API, token: 'x', fetch: near.fetchFn }).rest('GET', 'user')
    await vi.advanceTimersByTimeAsync(5000)
    expect((await p).body).toEqual({ ok: 1 })

    const far = scripted([
      {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset(3600) },
        body: { message: 'API rate limit exceeded' }
      }
    ])
    const t = createGithubTransport({ apiUrl: API, token: 'x', fetch: far.fetchFn })
    await expect(t.rest('GET', 'user')).rejects.toThrow(/rate limit spent/)
    expect(far.calls).toHaveLength(1)
    // Until the reset, calls fail without asking GitHub again.
    await expect(t.graphql('{ viewer { login } }')).rejects.toMatchObject({ status: 429 })
    expect(far.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(3600_000)
    void t.rest('GET', 'user').catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(far.calls).toHaveLength(2)
  })

  it('stops asking for a while once a secondary rate limit outlasts the retries', async () => {
    const { calls, fetchFn } = scripted([
      { status: 403, headers: { 'retry-after': '30' }, body: { message: 'You have exceeded a secondary rate limit.' } }
    ])
    const t = createGithubTransport({ apiUrl: API, token: 'x', fetch: fetchFn, retries: 1 })
    const done = expect(t.rest('GET', 'user')).rejects.toMatchObject({ status: 403 })
    await vi.advanceTimersByTimeAsync(30_000)
    await done
    expect(calls).toHaveLength(2)
    await expect(t.rest('GET', 'user')).rejects.toMatchObject({ status: 429 })
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(30_000)
    void t.rest('GET', 'user').catch(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(3)
  })

  it('does not retry a plain 403 or 404', async () => {
    const { calls, fetchFn } = scripted([{ status: 403, body: { message: 'Resource not accessible by integration' } }])
    const t = createGithubTransport({ apiUrl: API, token: 'x', fetch: fetchFn })
    await expect(t.rest('GET', 'repos/acme-labs/private')).rejects.toBeInstanceOf(GithubError)
    expect(calls).toHaveLength(1)
  })

  it('retries a GraphQL RATE_LIMITED error answer and a 502', async () => {
    const { calls, fetchFn } = scripted([
      { status: 502 },
      { body: { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] } },
      { body: { data: { rateLimit: { cost: 7 }, viewer: { login: 'x' } } } }
    ])
    const t = createGithubTransport({ apiUrl: API, token: 'x', fetch: fetchFn })
    const p = t.graphql('query { viewer { login } }')
    await vi.advanceTimersByTimeAsync(5000)
    expect(await p).toEqual({ data: { rateLimit: { cost: 7 }, viewer: { login: 'x' } }, cost: 7 })
    expect(calls).toHaveLength(3)
    expect(calls[0].url).toBe(`${API}/graphql`)
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ query: 'query { viewer { login } }', variables: {} })
  })

  it('surfaces other GraphQL errors at once', async () => {
    const { calls, fetchFn } = scripted([{ body: { errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] } }])
    const t = createGithubTransport({ apiUrl: API, token: 'x', fetch: fetchFn })
    await expect(t.graphql('query { x }')).rejects.toMatchObject({
      status: 404,
      message: expect.stringMatching(/Could not resolve/)
    })
    expect(calls).toHaveLength(1)
  })
})

describe('ETag cache', () => {
  it('sends If-None-Match after the first GET and reuses the body on 304', async () => {
    const { calls, fetchFn } = scripted([
      { body: { sha: 'abc' }, headers: { etag: 'W/"e1"' } },
      { status: 304, headers: { etag: 'W/"e1"' } },
      { body: { sha: 'def' }, headers: { etag: 'W/"e2"' } },
      { status: 304 }
    ])
    const t = createGithubTransport({ apiUrl: API, token: 'x', fetch: fetchFn })
    const a = await t.rest('GET', 'repos/acme-labs/widget/commits/dev')
    expect(a).toMatchObject({ status: 200, body: { sha: 'abc' }, cached: false })
    expect(calls[0].init.headers['If-None-Match']).toBeUndefined()
    const b = await t.rest('GET', 'repos/acme-labs/widget/commits/dev')
    expect(b).toMatchObject({ status: 304, body: { sha: 'abc' }, cached: true })
    expect(calls[1].init.headers['If-None-Match']).toBe('W/"e1"')
    const c = await t.rest('GET', 'repos/acme-labs/widget/commits/dev')
    expect(c.body).toEqual({ sha: 'def' })
    const d = await t.rest('GET', 'repos/acme-labs/widget/commits/dev')
    expect(calls[3].init.headers['If-None-Match']).toBe('W/"e2"')
    expect(d.body).toEqual({ sha: 'def' })
  })

  it('keeps ETags per URL, never for writes, and evicts the oldest beyond the cache size', async () => {
    const { calls, fetchFn } = scripted([{ body: {}, headers: { etag: '"x"' } }])
    const t = createGithubTransport({ apiUrl: API, token: 'x', fetch: fetchFn, etagCacheSize: 2 })
    await t.rest('GET', 'a')
    await t.rest('GET', 'b')
    await t.rest('POST', 'a', { y: 1 })
    expect(calls[2].init.headers['If-None-Match']).toBeUndefined()
    expect(calls[2].init.body).toBe('{"y":1}')
    await t.rest('GET', 'c') // evicts a
    await t.rest('GET', 'a')
    expect(calls[4].init.headers['If-None-Match']).toBeUndefined()
    await t.rest('GET', 'c')
    expect(calls[5].init.headers['If-None-Match']).toBe('"x"')
  })
})
