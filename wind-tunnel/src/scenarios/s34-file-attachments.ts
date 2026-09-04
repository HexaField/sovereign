// S34: File Attachments — verify that binary attachments sent via the UI
// actually reach the LLM backend.
//
// Regression: handleSend in chat.ts named the third parameter `_attachments`
// (intentional no-op). Base64 buffers were decoded by the route handler but
// then silently dropped — the agent never saw the attached files.
//
// This scenario proves the full path:
//   POST /api/chat/send (base64 attachment array)
//     → chat.ts handleSend (attachment sidecar)
//     → pumpQueue (retrieves sidecar, passes Buffer[] to sendMessage)
//     → backend.sendMessage (Buffer[] → image content block)
//     → mock Anthropic API (receives messages with image content)
//     → response arrives via WS
//
// The mock LLM strips image blocks and matches on the text portion, so we
// can use the normal pattern-matching machinery to confirm receipt.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

// A minimal 1×1 PNG (67 bytes) — smallest valid PNG for testing.
// base64 of: \x89PNG\r\n\x1a\n + IHDR + IDAT + IEND
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

export const s34FileAttachments: Scenario = {
  id: 's34',
  name: 'File Attachments',
  description: 'Verify that binary attachments sent from the UI reach the LLM backend',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl } = ctx
    const metrics: Record<string, unknown> = {}

    // ── Register mock response ────────────────────────────────────────
    await fetch(`${mockLlmUrl}/mock/log`, { method: 'DELETE' })
    await fetch(`${mockLlmUrl}/mock/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 'wind-tunnel-s34',
        response: 'I received your wind-tunnel-s34 message with the attached image.'
      })
    })

    // ── Create thread + WS ────────────────────────────────────────────
    const thread = await client.timed('create-thread', () => client.createThread({ label: 'swt-s34-attach' }))
    metrics.threadId = thread.id
    await client.connectWs(['chat'])

    // ── Send message with one attachment ─────────────────────────────
    let sendOk = false
    let sendError = ''
    try {
      await client.timed('send-with-attachment', () =>
        client.sendMessageWithAttachments(thread.id, 'Hello from wind-tunnel-s34 test', [
          { data: TINY_PNG_B64, mediaType: 'image/png' }
        ])
      )
      sendOk = true
    } catch (err: any) {
      sendError = err?.message ?? String(err)
    }
    metrics.sendOk = sendOk
    metrics.sendError = sendError || undefined

    // ── Wait for assistant turn ───────────────────────────────────────
    let gotTurn = false
    let turnContent = ''
    if (sendOk) {
      try {
        const turnMsg = await client.timed('wait-for-turn', () =>
          // Filter by threadId AND role===assistant — Sovereign emits a synthetic
          // user turn immediately at dispatch time (before the LLM is called).
          // Catching that turn instead of the assistant reply causes the log check
          // to run before the image request reaches the mock LLM.
          client.waitForWs('chat.turn', 30000, (d) => d.threadId === thread.id && d.turn?.role === 'assistant')
        )
        gotTurn = true
        turnContent = turnMsg?.turn?.content ?? ''
        metrics.turnContent = turnContent
        metrics.turnRole = turnMsg?.turn?.role
      } catch (err: any) {
        metrics.turnError = err?.message
      }
    }

    // ── Inspect mock LLM log — verify image block reached the API ─────
    let attachmentInPayload = false
    let mockRequests = 0
    try {
      const logRes = await fetch(`${mockLlmUrl}/mock/log`)
      const mockLog: any[] = (await logRes.json()) as any[]
      mockRequests = mockLog.length
      metrics.mockRequests = mockRequests

      // Walk the logged messages to find a content array containing an image block
      for (const entry of mockLog) {
        const messages: any[] = entry.messages ?? []
        for (const msg of messages) {
          if (msg.role !== 'user') continue
          const content = msg.content
          if (!Array.isArray(content)) continue
          const hasImage = content.some(
            (block: any) =>
              block.type === 'image' ||
              // OpenAI-format proxy: image_url parts
              block.type === 'image_url'
          )
          if (hasImage) {
            attachmentInPayload = true
            break
          }
        }
        if (attachmentInPayload) break
      }
      metrics.attachmentInPayload = attachmentInPayload
    } catch {
      metrics.mockLogError = 'failed to fetch mock log'
    }

    // ── Cleanup ───────────────────────────────────────────────────────
    client.disconnectWs()
    await client.deleteThread(thread.id)

    // ── Verdict ───────────────────────────────────────────────────────
    if (!sendOk) {
      return {
        passed: false,
        summary: `POST /api/chat/send with attachment failed: ${sendError}`,
        metrics,
        samples: client.samples
      }
    }

    if (!gotTurn) {
      return {
        passed: false,
        summary: `no assistant turn received — mock received ${mockRequests} request(s)`,
        metrics,
        samples: client.samples
      }
    }

    if (!attachmentInPayload) {
      return {
        passed: false,
        summary: `turn received but no image block found in mock LLM payload — attachment was dropped`,
        metrics,
        samples: client.samples
      }
    }

    return {
      passed: true,
      summary: `attachment roundtrip OK — image block reached mock LLM, got turn: "${turnContent.slice(0, 60)}"`,
      metrics,
      samples: client.samples
    }
  }
}
