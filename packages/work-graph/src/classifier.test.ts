import { describe, expect, it, vi } from 'vitest'
import type { WorkNode } from '@sovereign/core'
import {
  classifierState,
  createSystemOneClassifier,
  parseSystemOneAnswer,
  SYSTEMONE_QUESTION,
  type SystemOneConfig
} from './classifier.js'
import { triage } from './events.js'
import type { ForgeEvent } from './types.js'

const node: WorkNode = {
  id: 'github:github.com/acme/widget#7',
  forge: 'github',
  kind: 'change',
  repo: 'acme/widget',
  number: 7,
  title: 'Cache the parser',
  url: 'https://github.com/acme/widget/pull/7',
  state: 'open',
  zone: 'present',
  author: 'sam',
  assignees: ['hex-agent'],
  reviewers: [{ login: 'kim', state: 'commented' }],
  labels: ['perf'],
  workstreams: [],
  branch: { head: 'cache', base: 'main', ahead: 2, behind: 3 },
  ci: 'passing',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z'
}

const event: ForgeEvent = {
  at: '2026-10-02T00:00:00Z',
  nodeId: node.id,
  type: 'commented',
  detail: { author: 'kim', text: ['Could this also cover the lexer?'] }
}

const answer = (choice: string, p: number) => ({
  model: 'decider',
  answers: {
    triage: {
      type: 'choice',
      choice,
      probabilities: { [choice]: p, [choice === 'info' ? 'needs-agent' : 'info']: 1 - p },
      confidence: 2 * p - 1
    }
  },
  usage: { input_tokens: 120, output_tokens: 0 }
})

function stubFetch(body: unknown, status = 200) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  )
}

const cfg =
  (c?: Partial<SystemOneConfig>): (() => SystemOneConfig) =>
  () => ({ url: 'http://decider:8080/', ...c })

describe('systemone classifier', () => {
  it('posts one choice question with the event and node card as state', async () => {
    const f = stubFetch(answer('needs-agent', 0.91))
    const c = createSystemOneClassifier({ config: cfg({ model: 'decider' }), fetch: f as typeof fetch })
    expect(await c.classify({ event, node, owned: true })).toEqual({ choice: 'needs-agent', confidence: 0.91 })
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('http://decider:8080/v1/systemone')
    const body = JSON.parse(String(init!.body))
    expect(body.model).toBe('decider')
    expect(body.questions).toEqual({ triage: SYSTEMONE_QUESTION })
    expect(Object.keys(body.questions.triage.criteria).sort()).toEqual(['info', 'needs-agent'])
    expect(body.state).toBe(classifierState({ event, node, owned: true }))
  })

  it('builds a compact state', () => {
    expect(classifierState({ event, node, owned: true })).toBe(
      [
        'Event: commented',
        'author: kim',
        'text: Could this also cover the lexer?',
        '',
        'change acme/widget#7 "Cache the parser" (open)',
        'CI: passing',
        'Reviews: kim commented',
        'Branch: cache → main, ahead 2, behind 3',
        'Author: sam',
        'Assignees: hex-agent',
        'Labels: perf',
        'An agent thread owns this item.'
      ].join('\n')
    )
    expect(classifierState({ event, owned: false })).toContain(`Item: ${node.id}\nNo agent thread owns this item.`)
  })

  it('omits model when none is configured', async () => {
    const f = stubFetch(answer('info', 0.8))
    await createSystemOneClassifier({ config: cfg(), fetch: f as typeof fetch }).classify({ event, owned: false })
    expect(JSON.parse(String(f.mock.calls[0][1]!.body)).model).toBeUndefined()
  })

  it('uses the chosen option probability, falling back to confidence', () => {
    expect(parseSystemOneAnswer(answer('info', 0.75))).toEqual({ choice: 'info', confidence: 0.75 })
    expect(parseSystemOneAnswer({ answers: { triage: { choice: 'info', confidence: 0.4 } } })).toEqual({
      choice: 'info',
      confidence: 0.4
    })
    expect(parseSystemOneAnswer({ answers: { triage: { choice: 'maybe', confidence: 0.9 } } })).toBeUndefined()
    expect(parseSystemOneAnswer({ answers: {} })).toBeUndefined()
    expect(parseSystemOneAnswer({ answers: { triage: { choice: 'info', confidence: 3 } } })).toBeUndefined()
    expect(parseSystemOneAnswer(null)).toBeUndefined()
  })

  it('no url → no call, no answer', async () => {
    const f = stubFetch(answer('info', 0.9))
    const c = createSystemOneClassifier({ config: () => undefined, fetch: f as typeof fetch })
    expect(await c.classify({ event, owned: false })).toBeUndefined()
    const blank = createSystemOneClassifier({ config: () => ({ url: ' ' }), fetch: f as typeof fetch })
    expect(await blank.classify({ event, owned: false })).toBeUndefined()
    expect(f).not.toHaveBeenCalled()
  })

  it('HTTP errors, transport errors and bad bodies return undefined, then pause the model', async () => {
    let t = 1000
    const log = vi.fn()
    const f = stubFetch({ error: 'no model' }, 503)
    const c = createSystemOneClassifier({ config: cfg(), fetch: f as typeof fetch, now: () => t, log })
    expect(await c.classify({ event, owned: false })).toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('HTTP 503'))
    // Quiet for a minute: no second request.
    expect(await c.classify({ event, owned: false })).toBeUndefined()
    expect(f).toHaveBeenCalledTimes(1)
    t += 60_001
    f.mockImplementationOnce(async () => {
      throw new TypeError('fetch failed')
    })
    expect(await c.classify({ event, owned: false })).toBeUndefined()
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('fetch failed'))
    t += 60_001
    f.mockImplementationOnce(async () => new Response('not json', { status: 200 }))
    expect(await c.classify({ event, owned: false })).toBeUndefined()
    expect(f).toHaveBeenCalledTimes(3)
  })

  it('times out', async () => {
    const f = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
    )
    const log = vi.fn()
    const c = createSystemOneClassifier({ config: cfg({ timeoutMs: 20 }), fetch: f as typeof fetch, log })
    expect(await c.classify({ event, owned: false })).toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('timed out'))
  })

  it('drives triage: confident → model tier, unsure → model-low, down → unavailable', async () => {
    const ctx = { node, owned: true, tracked: () => true, mentions: [] }
    const sure = createSystemOneClassifier({ config: cfg(), fetch: stubFetch(answer('info', 0.9)) as typeof fetch })
    expect(await triage(event, ctx, sure)).toMatchObject({ triage: 'info', tier: 'model', confidence: 0.9 })
    const unsure = createSystemOneClassifier({ config: cfg(), fetch: stubFetch(answer('info', 0.6)) as typeof fetch })
    expect(await triage(event, ctx, unsure)).toMatchObject({ triage: 'needs-agent', tier: 'model-low' })
    const down = createSystemOneClassifier({ config: cfg(), fetch: stubFetch({}, 500) as typeof fetch })
    expect(await triage(event, ctx, down)).toMatchObject({ triage: 'needs-agent', tier: 'unavailable' })
  })
})
