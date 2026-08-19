import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAiSdkInferenceClient } from './ai-sdk-inference.js'
import type { InferenceClientConfig } from './inference.js'

// ── Helpers ─────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<InferenceClientConfig>): InferenceClientConfig {
  return {
    baseUrl: 'http://127.0.0.1:19999',
    model: 'test-model',
    contextWindow: 8192,
    temperature: 0.1,
    maxTokens: 512,
    timeoutMs: 30_000,
    thinking: true,
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

// ── Tests ───────────────────────────────────────────────────────────

describe('createCustomFetch — stream_options injection', () => {
  let fetchSpy: ReturnType<typeof vi.fn>
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('injects stream_options when the request body has stream: true', async () => {
    // Return a valid SSE response so the AI SDK stream doesn't error
    fetchSpy.mockResolvedValue(
      new Response(sseStream('hello'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    )

    const client = createAiSdkInferenceClient(makeConfig())
    await client.complete([{ role: 'user', content: 'hi' }])

    expect(fetchSpy).toHaveBeenCalled()
    // The AI SDK sends a streaming chat completion — find the call whose
    // body contains "stream": true and verify stream_options got injected.
    const call = fetchSpy.mock.calls.find(([_url, init]: [unknown, RequestInit | undefined]) => {
      if (!init?.body || typeof init.body !== 'string') return false
      try {
        const body = JSON.parse(init.body)
        return body.stream === true
      } catch {
        return false
      }
    })
    expect(call).toBeDefined()
    const body = JSON.parse((call as any)[1].body)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('does not inject stream_options when stream is absent', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }))

    const client = createAiSdkInferenceClient(makeConfig())
    // Health check sends a non-streaming GET to /v1/models
    await client.healthCheck()

    // healthCheck uses its own fetch — no body, no stream_options concern.
    // Verify no call had stream_options injected into a non-streaming body.
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

  it('still injects chat_template_kwargs when thinking is false', async () => {
    fetchSpy.mockResolvedValue(
      new Response(sseStream('world'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    )

    const client = createAiSdkInferenceClient(makeConfig({ thinking: false }))
    await client.complete([{ role: 'user', content: 'test' }])

    const call = fetchSpy.mock.calls.find(([_url, init]: [unknown, RequestInit | undefined]) => {
      if (!init?.body || typeof init.body !== 'string') return false
      try {
        const body = JSON.parse(init.body)
        return body.stream === true
      } catch {
        return false
      }
    })
    expect(call).toBeDefined()
    const body = JSON.parse((call as any)[1].body)
    // Both fields present
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  it('injects chat_template_kwargs with enable_thinking: true when thinking is true', async () => {
    fetchSpy.mockResolvedValue(
      new Response(sseStream('ok'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    )

    const client = createAiSdkInferenceClient(makeConfig({ thinking: true }))
    await client.complete([{ role: 'user', content: 'test' }])

    const call = fetchSpy.mock.calls.find(([_url, init]: [unknown, RequestInit | undefined]) => {
      if (!init?.body || typeof init.body !== 'string') return false
      try {
        const body = JSON.parse(init.body)
        return body.stream === true
      } catch {
        return false
      }
    })
    expect(call).toBeDefined()
    const body = JSON.parse((call as any)[1].body)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true })
  })
})
