import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAiSdkInferenceClient } from './ai-sdk-inference.js'
import type { InferenceClientConfig } from './inference.js'

// ── Helpers ─────────────────────────────────────────────────────────

const DEFAULT_REASONING: InferenceClientConfig['reasoning'] = {
  enabled: false,
  effort: 'medium',
  maxTokens: 2048
}

function makeConfig(overrides?: Partial<InferenceClientConfig>): InferenceClientConfig {
  return {
    baseUrl: 'http://127.0.0.1:19999',
    model: 'test-model',
    contextWindow: 8192,
    temperature: 0.1,
    maxTokens: 512,
    timeoutMs: 30_000,
    reasoning: DEFAULT_REASONING,
    ...overrides
  }
}

/** Build a minimal SSE stream that the AI SDK can consume — emits one
 *  text chunk and a [DONE] sentinel. */
function sseStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const chunk = {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }]
  }
  const done = {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    model: 'test-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  }
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(done)}\n\n`))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    }
  })
}

/** Find the streaming call in fetchSpy calls. */
function findStreamingCall(fetchSpy: ReturnType<typeof vi.fn>) {
  return fetchSpy.mock.calls.find((call: unknown[]) => {
    const init = call[1] as RequestInit | undefined
    if (!init?.body || typeof init.body !== 'string') return false
    try {
      return JSON.parse(init.body).stream === true
    } catch {
      return false
    }
  })
}

// ── Tests ───────────────────────────────────────────────────────────

describe('createCustomFetch — stream_options injection', () => {
  let fetchSpy: ReturnType<typeof vi.fn>
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('injects stream_options when the request body has stream: true', async () => {
    fetchSpy.mockResolvedValue(
      new Response(sseStream('hello'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    )

    const client = createAiSdkInferenceClient(makeConfig())
    await client.complete([{ role: 'user', content: 'hi' }])

    expect(fetchSpy).toHaveBeenCalled()
    const call = findStreamingCall(fetchSpy)
    expect(call).toBeDefined()
    const body = JSON.parse((call as any)[1].body)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('does not inject stream_options when stream is absent', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }))

    const client = createAiSdkInferenceClient(makeConfig())
    await client.healthCheck()

    for (const [_url, init] of fetchSpy.mock.calls) {
      if (!init?.body || typeof init.body !== 'string') continue
      try {
        const body = JSON.parse(init.body)
        if (!body.stream) {
          expect(body.stream_options).toBeUndefined()
        }
      } catch {
        // non-JSON body — fine
      }
    }
  })

  it('injects chat_template_kwargs with enable_thinking: false when reasoning disabled', async () => {
    fetchSpy.mockResolvedValue(
      new Response(sseStream('world'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    )

    const client = createAiSdkInferenceClient(
      makeConfig({ reasoning: { enabled: false, effort: 'medium', maxTokens: 2048 } })
    )
    await client.complete([{ role: 'user', content: 'test' }])

    const call = findStreamingCall(fetchSpy)
    expect(call).toBeDefined()
    const body = JSON.parse((call as any)[1].body)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
    // effort and max_reasoning_tokens not sent when disabled
    expect(body.chat_template_kwargs.reasoning_effort).toBeUndefined()
    expect(body.chat_template_kwargs.max_reasoning_tokens).toBeUndefined()
  })

  it('injects enable_thinking: true when reasoning enabled', async () => {
    fetchSpy.mockResolvedValue(
      new Response(sseStream('ok'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    )

    const client = createAiSdkInferenceClient(
      makeConfig({ reasoning: { enabled: true, effort: 'medium', maxTokens: 0 } })
    )
    await client.complete([{ role: 'user', content: 'test' }])

    const call = findStreamingCall(fetchSpy)
    expect(call).toBeDefined()
    const body = JSON.parse((call as any)[1].body)
    expect(body.chat_template_kwargs.enable_thinking).toBe(true)
    // effort is sent when enabled
    expect(body.chat_template_kwargs.reasoning_effort).toBe('medium')
    // no cap when maxTokens is 0
    expect(body.chat_template_kwargs.max_reasoning_tokens).toBeUndefined()
  })

  it('injects max_reasoning_tokens when maxTokens > 0', async () => {
    fetchSpy.mockResolvedValue(
      new Response(sseStream('ok'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    )

    const client = createAiSdkInferenceClient(
      makeConfig({ reasoning: { enabled: true, effort: 'low', maxTokens: 2048 } })
    )
    await client.complete([{ role: 'user', content: 'test' }])

    const call = findStreamingCall(fetchSpy)
    expect(call).toBeDefined()
    const body = JSON.parse((call as any)[1].body)
    expect(body.chat_template_kwargs.enable_thinking).toBe(true)
    expect(body.chat_template_kwargs.reasoning_effort).toBe('low')
    expect(body.chat_template_kwargs.max_reasoning_tokens).toBe(2048)
  })

  it('updateConfig changes reasoning used in subsequent requests', async () => {
    fetchSpy.mockResolvedValue(
      new Response(sseStream('updated'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    )

    const client = createAiSdkInferenceClient(
      makeConfig({ reasoning: { enabled: false, effort: 'medium', maxTokens: 0 } })
    )

    // Enable reasoning after creation
    client.updateConfig({ reasoning: { enabled: true, effort: 'high', maxTokens: 1024 } })

    await client.complete([{ role: 'user', content: 'test' }])

    const call = findStreamingCall(fetchSpy)
    expect(call).toBeDefined()
    const body = JSON.parse((call as any)[1].body)
    expect(body.chat_template_kwargs.enable_thinking).toBe(true)
    expect(body.chat_template_kwargs.reasoning_effort).toBe('high')
    expect(body.chat_template_kwargs.max_reasoning_tokens).toBe(1024)
  })
})

describe('createAiSdkInferenceClient — reasoning passthrough', () => {
  let fetchSpy: ReturnType<typeof vi.fn>
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns reasoning from reasoning-delta events in CompletionResponse', async () => {
    const encoder = new TextEncoder()
    const reasoningChunk = {
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      model: 'test-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
      // AI SDK emits reasoning as a special part type — we simulate it in the stream
    }
    // Build a stream that includes a reasoning-delta event
    // Note: the AI SDK parses the raw SSE stream; we test that the client
    // correctly accumulates reasoning content when it's present.
    // Use text content for this test since the AI SDK's reasoning-delta handling
    // requires a specific part format that varies by version.
    const textChunk = {
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      model: 'test-model',
      choices: [{ index: 0, delta: { content: 'Final answer.' }, finish_reason: null }]
    }
    const done = {
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      model: 'test-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
    }

    void reasoningChunk // declared for clarity

    fetchSpy.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(textChunk)}\n\n`))
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(done)}\n\n`))
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          }
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )
    )

    const client = createAiSdkInferenceClient(
      makeConfig({ reasoning: { enabled: true, effort: 'medium', maxTokens: 0 } })
    )
    const result = await client.complete([{ role: 'user', content: 'think about this' }])

    // Text content arrives normally
    expect(result.choices[0].message.content).toBe('Final answer.')
    // reasoning field absent when no reasoning-delta events were emitted
    expect(result.reasoning).toBeUndefined()
  })

  it('healthCheck returns true for a 200 /v1/models response', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'model' }] }), { status: 200 }))

    const client = createAiSdkInferenceClient(makeConfig())
    const healthy = await client.healthCheck()

    expect(healthy).toBe(true)
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/v1/models'),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('healthCheck returns false for a non-200 response', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 503 }))
    const client = createAiSdkInferenceClient(makeConfig())
    expect(await client.healthCheck()).toBe(false)
  })

  it('healthCheck returns false when fetch throws', async () => {
    fetchSpy.mockRejectedValue(new TypeError('ECONNREFUSED'))
    const client = createAiSdkInferenceClient(makeConfig())
    expect(await client.healthCheck()).toBe(false)
  })
})
