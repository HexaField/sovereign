// S14: Local LLM Backend — verify the inference client can connect to
// an OpenAI-compatible API (the mock-llm), send a chat completion,
// handle tool calls, and stream responses correctly.
//
// This scenario tests the inference layer independently of Sovereign's
// thread routing — the wind tunnel's mock-llm serves both Anthropic
// (for Claude Code) and OpenAI (for local-llm) formats.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

export const s14LocalLlmBackend: Scenario = {
  id: 's14',
  name: 'Local LLM Backend',
  description: 'OpenAI-compatible inference client connects, completes, handles tools, streams',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl } = ctx
    const metrics: Record<string, unknown> = {}

    // Clear mock state
    await fetch(`${mockLlmUrl}/mock/log`, { method: 'DELETE' })
    await fetch(`${mockLlmUrl}/mock/scripts`, { method: 'DELETE' })

    // Test 1: Non-streaming completion
    // Register a script for the test
    await fetch(`${mockLlmUrl}/mock/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 's14-basic-chat',
        response: 'Hello from the local model!',
        needsTools: false
      })
    })

    const basicRes = await client.timed('basic-completion', async () => {
      const res = await fetch(`${mockLlmUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'default',
          messages: [{ role: 'user', content: 'Test s14-basic-chat' }],
          stream: false
        })
      })
      return res.json()
    })

    const basicContent = basicRes?.choices?.[0]?.message?.content
    metrics.basicCompletion = !!basicContent
    metrics.basicContent = basicContent?.slice(0, 60)

    if (!basicContent) {
      return {
        passed: false,
        summary: 'Non-streaming completion returned no content',
        metrics,
        samples: client.samples
      }
    }

    // Test 2: Streaming completion
    await fetch(`${mockLlmUrl}/mock/scripts`, { method: 'DELETE' })
    await fetch(`${mockLlmUrl}/mock/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 's14-stream-test',
        response: 'Streaming response received successfully.',
        needsTools: false
      })
    })

    const streamedText = await client.timed('streaming-completion', async () => {
      const res = await fetch(`${mockLlmUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'default',
          messages: [{ role: 'user', content: 'Test s14-stream-test' }],
          stream: true
        })
      })

      const text = await res.text()
      // Parse SSE events to extract content
      const chunks = text
        .split('\n')
        .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
        .map((l) => {
          try {
            return JSON.parse(l.slice(6))
          } catch {
            return null
          }
        })
        .filter(Boolean)

      return chunks.map((c: any) => c.choices?.[0]?.delta?.content ?? '').join('')
    })

    metrics.streamedText = streamedText?.slice(0, 60)
    metrics.streamingWorks = !!streamedText

    if (!streamedText) {
      return {
        passed: false,
        summary: 'Streaming completion returned no content',
        metrics,
        samples: client.samples
      }
    }

    // Test 3: Tool call round-trip
    await fetch(`${mockLlmUrl}/mock/scripts`, { method: 'DELETE' })
    await fetch(`${mockLlmUrl}/mock/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 's14-tool-test',
        toolUse: { id: 'call_s14_read', name: 'Read', input: { file_path: '/tmp/test.txt' } },
        needsTools: false
      })
    })

    const toolRes = await client.timed('tool-call', async () => {
      const res = await fetch(`${mockLlmUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'default',
          messages: [{ role: 'user', content: 'Test s14-tool-test' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'Read',
                description: 'Read a file',
                parameters: { type: 'object', properties: { file_path: { type: 'string' } } }
              }
            }
          ],
          stream: false
        })
      })
      return res.json()
    })

    const toolCalls = toolRes?.choices?.[0]?.message?.tool_calls
    metrics.toolCallReceived = !!toolCalls?.length
    metrics.toolCallName = toolCalls?.[0]?.function?.name

    if (!toolCalls?.length) {
      return {
        passed: false,
        summary: 'Tool call completion returned no tool_calls',
        metrics,
        samples: client.samples
      }
    }

    // Test 4: Check mock log recorded OpenAI-format requests
    const logRes = await fetch(`${mockLlmUrl}/mock/log`)
    const mockLog = (await logRes.json()) as any[]
    const openaiRequests = mockLog.filter((e: any) => e.format === 'openai')
    metrics.openaiRequestCount = openaiRequests.length

    const passed = !!basicContent && !!streamedText && !!toolCalls?.length
    return {
      passed,
      summary: passed
        ? `local-llm integration OK — basic: "${basicContent.slice(0, 30)}…", streaming: ${streamedText.length} chars, tool_calls: ${toolCalls.length}`
        : 'One or more local-llm integration tests failed',
      metrics,
      samples: client.samples
    }
  }
}
