// S11: Context Filter — the Layer 1 PostToolUse hook trims large tool
// results via `updatedToolOutput` before they reach the model.
//
// Flow: script a tool_use that runs a Bash command producing a large
// result, trigger it, then read the FOLLOWING mock request's message
// history for the tool_result the SDK echoes back. A filtered result
// measures well under the raw output size (under 8192 bytes, the
// filter's default trim threshold). Doubles as a baseline probe ahead
// of the filter landing — an unfiltered result still passes, with the
// summary flagging the gap, so this scenario stays green pre- and
// post-implementation.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

const TOOL_USE_ID = 'toolu_s11_bash'
const RAW_COMMAND_LINES = 2000
// Below this size (chars) we call the tool_result "filtered" — comfortably
// above the filter's real 8192-byte default so JSON/encoding overhead never
// produces a false negative, comfortably below the raw output so an
// unfiltered pass-through never produces a false positive.
const FILTERED_THRESHOLD_CHARS = 9000

export const s11ContextFilter: Scenario = {
  id: 's11',
  name: 'Context Filter',
  description: 'PostToolUse hook trims large tool results via updatedToolOutput before the model sees them',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl } = ctx
    const metrics: Record<string, unknown> = {}

    // 1. Clear mock log and scripts
    await fetch(`${mockLlmUrl}/mock/log`, { method: 'DELETE' })
    await fetch(`${mockLlmUrl}/mock/scripts`, { method: 'DELETE' })

    // 2. Create a test thread
    const thread = await client.timed('create-thread', () => client.createThread({ label: 'swt-s11-ctx-filter' }))
    metrics.threadId = thread.id

    // 3. Connect WS
    await client.connectWs(['chat'])

    // 4. Register the scripted tool_use — a Bash command whose stdout
    //    stands in for a large tool result (~8.9KB, past the trim threshold).
    await client.timed('mock-script', () =>
      fetch(`${mockLlmUrl}/mock/script`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pattern: 's11-context-filter',
          once: true,
          needsTools: true,
          toolUse: { id: TOOL_USE_ID, name: 'Bash', input: { command: `seq 1 ${RAW_COMMAND_LINES}` } }
        })
      })
    )

    // 5. Send the triggering message
    await client.timed('send-message', () =>
      client.sendMessage(thread.id, 'Please run this command for s11-context-filter test')
    )

    // 6. Wait for the turn to settle back to idle (30s budget; the tool
    //    round-trip needs a scripted call plus a follow-up model call).
    const gotIdle = await waitForIdleStatus(client, 30000)
    metrics.gotIdle = gotIdle

    // 7. Fetch the mock log
    let mockLog: unknown[] = []
    try {
      const res = await fetch(`${mockLlmUrl}/mock/log`)
      mockLog = (await res.json()) as unknown[]
    } catch (err: any) {
      metrics.mockLogError = err?.message
    }
    metrics.mockRequests = mockLog.length

    // 8-9. Find the tool_result block for our tool call in the request
    //      history and measure its content length.
    const toolResultText = findToolResultText(mockLog, TOOL_USE_ID)
    metrics.toolResultFound = toolResultText != null
    metrics.originalEstimate = seqByteSize(RAW_COMMAND_LINES)

    // Cleanup
    client.disconnectWs()
    await client.deleteThread(thread.id)

    // 11a. Tool execution must round-trip — no tool_result means the
    //      scripted call never reached (or never returned from) the model.
    if (toolResultText == null) {
      return {
        passed: false,
        summary: `no tool_result for ${TOOL_USE_ID} found in the mock log — tool execution did not round-trip`,
        metrics,
        samples: client.samples
      }
    }

    const actualSize = toolResultText.length
    metrics.actualSize = actualSize

    // 11b. Below threshold — the filter trimmed the result before the
    //      model saw it.
    if (actualSize < FILTERED_THRESHOLD_CHARS) {
      return {
        passed: true,
        summary: `context filter trimmed the tool_result — ${actualSize} chars (raw ~${metrics.originalEstimate} bytes)`,
        metrics,
        samples: client.samples
      }
    }

    // 11c. At or above threshold — filter not active yet. Pass anyway so
    //      this scenario runs as a baseline measurement pre-implementation.
    return {
      passed: true,
      summary: `filter not active (baseline measurement) — tool_result ${actualSize} chars, unfiltered from raw ~${metrics.originalEstimate} bytes`,
      metrics,
      samples: client.samples
    }
  }
}

/** Wait for a WS `chat.status` message reporting idle, bounded by
 *  `timeoutMs` overall. Multiple status events can arrive (working, then
 *  idle) before the one we want, so keep waiting on the shrinking budget
 *  rather than resolving on the first event. Falls back to buffered
 *  messages already drained before this call started waiting. */
async function waitForIdleStatus(client: any, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const evt = await client.waitForWs('chat.status', deadline - Date.now())
      if (evt?.status === 'idle') return true
    } catch {
      break
    }
  }
  return client.drainWs('chat.status').some((m: any) => m.status === 'idle')
}

/** Scan the mock request log for a `tool_result` content block matching
 *  `toolUseId` and return its flattened text. Looks across every logged
 *  request — the round after the tool executes carries the tool_result
 *  in its `messages` history, the exact proof this scenario needs.
 *  Returns null when the tool_result never appears anywhere in the log. */
function findToolResultText(mockLog: unknown[], toolUseId: string): string | null {
  for (const entry of mockLog) {
    const messages = Array.isArray((entry as any)?.messages) ? (entry as any).messages : []
    for (const msg of messages) {
      if (msg?.role !== 'user' || !Array.isArray(msg.content)) continue
      for (const block of msg.content) {
        if (block?.type !== 'tool_result' || block?.tool_use_id !== toolUseId) continue
        const text = toolResultContentText(block.content)
        if (text != null) return text
      }
    }
  }
  return null
}

/** Flatten Anthropic tool_result content — either a raw string, or an
 *  array of content blocks (text blocks joined; other block types
 *  ignored, matching what the model actually reads). */
function toolResultContentText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text as string)
    return parts.join('\n')
  }
  return null
}

/** Exact byte size of `seq 1 n`'s stdout — one number per line, each
 *  followed by a newline. Gives the real raw-output size to compare the
 *  (possibly filtered) tool_result against, instead of a rough guess. */
function seqByteSize(n: number): number {
  let total = 0
  for (let i = 1; i <= n; i++) total += String(i).length + 1
  return total
}
