import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSovereignToolExecutor } from './sovereign.js'
import type { SovereignToolsDeps } from './sovereign.js'

// ── Minimal mock deps ─────────────────────────────────────────────────────
// WebFetch doesn't use any deps — only needs the executor to be instantiated.

function makeDeps(): SovereignToolsDeps {
  return {
    sessionKey: 'test-session',
    cron: {
      createUserMessageCron: vi.fn().mockResolvedValue({ id: 'cron-1', schedule: '* * * * *' }),
      list: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue(undefined)
    },
    sessions: {
      list: vi.fn().mockResolvedValue([]),
      send: vi.fn().mockResolvedValue(undefined),
      history: vi.fn().mockResolvedValue([])
    },
    agents: {
      list: vi.fn().mockResolvedValue([]),
      spawn: vi.fn().mockResolvedValue({ sessionKey: 'child' })
    },
    notifications: {
      send: vi.fn().mockReturnValue({ id: 'notif-1' })
    },
    planning: {
      createIssue: vi.fn(),
      updateIssue: vi.fn()
    },
    orgs: {
      list: vi.fn().mockResolvedValue([]),
      getMembers: vi.fn().mockResolvedValue([])
    },
    meetings: {
      getMeetings: vi.fn().mockResolvedValue([]),
      getMeetingTranscript: vi.fn().mockResolvedValue({ transcript: '' })
    }
  } as unknown as SovereignToolsDeps
}

describe('sovereign tools: WebFetch body truncation', () => {
  let originalFetch: typeof globalThis.fetch
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('truncates response bodies larger than 20KB', async () => {
    const bigBody = 'x'.repeat(30_000) // 30KB — exceeds the 20KB cap
    fetchSpy.mockResolvedValue(
      new Response(bigBody, { status: 200, statusText: 'OK', headers: { 'content-type': 'text/html' } })
    )

    const execute = createSovereignToolExecutor(makeDeps())
    const result = await execute('WebFetch', { url: 'https://example.com' })

    expect(result.error).toBeUndefined()
    // Content must be capped at 20KB + truncation notice
    expect(result.content.length).toBeLessThan(25_000) // well under 30KB
    expect(result.content).toContain('[truncated')
    expect(result.content).toContain('more chars')
  })

  it('returns the full body when it fits within 20KB', async () => {
    const smallBody = 'hello world'
    fetchSpy.mockResolvedValue(
      new Response(smallBody, { status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' } })
    )

    const execute = createSovereignToolExecutor(makeDeps())
    const result = await execute('WebFetch', { url: 'https://example.com/small' })

    expect(result.error).toBeUndefined()
    expect(result.content).toContain(smallBody)
    expect(result.content).not.toContain('[truncated')
  })

  it('returns an error when the URL is missing', async () => {
    const execute = createSovereignToolExecutor(makeDeps())
    const result = await execute('WebFetch', {})
    expect(result.error).toBeTruthy()
  })

  it('returns an error when fetch fails', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'))
    const execute = createSovereignToolExecutor(makeDeps())
    const result = await execute('WebFetch', { url: 'https://bad.example.com' })
    expect(result.error).toContain('WebFetch failed')
  })
})
