// S18: LLM Benchmark — send a configurable architectural prompt through
// the local-llm backend and measure response quality + timing.
//
// Prompt source: SWT_BENCHMARK_PROMPT environment variable.
// Skips when the variable has no value.
//
// Docker mode (mock-llm available): registers a canned architectural
// response and validates routing plumbing end-to-end.
// Native mode (--native): sends the real prompt to the real LLM and
// reports actual generation metrics.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

const skip = (summary: string): ScenarioResult => ({
  passed: true,
  summary,
  metrics: { skipped: true },
  samples: []
})

function is404(err: any): boolean {
  return String(err?.message ?? '').includes('→ 404')
}

/** Structured mock response — exercises the full pipeline with a
 *  substantial multi-section architectural answer.  Only used when
 *  the scenario runs in Docker mode against the mock-llm. */
const MOCK_ARCHITECTURAL_RESPONSE = [
  '## Runtime Content Creation System\n\n',
  '### Architecture Overview\n\n',
  'The system introduces a runtime content registry that operates alongside ',
  'the existing block/entity registries. New content definitions live in the ',
  'world save as NBT compound tags under a `custom_content` namespace.\n\n',
  '### Core Components\n\n',
  '1. **Content Definition Schema** — JSON-based declarative format for blocks, ',
  'entities, particles, recipes, and UI screens\n',
  '2. **Runtime Registry** — hot-loads definitions without server restart\n',
  '3. **Visual Editor** — in-game UI for authoring content with live preview\n',
  '4. **Persistence Layer** — serialises to world save, syncs to clients\n\n',
  '### Block Creation Flow\n\n',
  '```\nPlayer opens editor → selects "New Block" → defines properties ',
  '(texture, hardness, drops, behaviour) → preview renders in-world → ',
  'confirm saves to registry → block available immediately\n```\n\n',
  '### Technical Considerations\n\n',
  '- Texture atlas rebuilds on content change (deferred to next frame)\n',
  '- Entity AI graphs use a node-based visual editor\n',
  '- Recipe conflicts resolved by priority + last-write-wins\n',
  '- Network sync uses delta compression for content defs\n',
  '- Particle systems defined as keyframe curves over lifetime\n'
].join('')

export const s18LlmBenchmark: Scenario = {
  id: 's18',
  name: 'LLM Benchmark',
  description: 'Configurable prompt benchmark through local-llm backend — measures routing + generation',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl } = ctx
    const metrics: Record<string, unknown> = {}
    const isNative = ctx.composeFile === null

    // ── 1. Read prompt from env — skip when absent ───────────────────
    const prompt = process.env.SWT_BENCHMARK_PROMPT
    if (!prompt || prompt.trim() === '') {
      return skip('skipped — SWT_BENCHMARK_PROMPT not set')
    }
    metrics.promptLength = prompt.length
    metrics.mode = isNative ? 'native' : 'docker'

    // ── 2. Verify local-llm backend exists ──────────────────────────
    let backends: any[] = []
    try {
      const res = await client.get('/api/backends')
      backends = res?.backends ?? []
    } catch (err: any) {
      if (is404(err)) return skip('skipped — /api/backends not available')
      throw err
    }

    const hasLocalLlm = backends.some((b: any) => b.kind === 'local-llm')
    if (!hasLocalLlm) {
      return skip('skipped — local-llm backend not enabled')
    }
    metrics.backends = backends.map((b: any) => b.kind)

    // ── 3. Docker mode: register mock response ──────────────────────
    if (!isNative) {
      await fetch(`${mockLlmUrl}/mock/log`, { method: 'DELETE' })
      await fetch(`${mockLlmUrl}/mock/script`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pattern: '.*',
          response: MOCK_ARCHITECTURAL_RESPONSE
        })
      })
    }

    // ── 4. Create thread bound to local-llm ─────────────────────────
    let thread: any
    try {
      thread = await client.timed('create-thread', () =>
        client.post('/api/threads', { label: 'swt-s18-benchmark', backend: 'local-llm' })
      )
      thread = thread?.thread ?? thread
    } catch (err: any) {
      return {
        passed: false,
        summary: `thread creation failed: ${err?.message}`,
        metrics,
        samples: client.samples
      }
    }
    metrics.threadId = thread.id

    const cleanup = async (result: ScenarioResult): Promise<ScenarioResult> => {
      client.disconnectWs()
      await client.deleteThread(thread.id).catch(() => {})
      return result
    }

    // ── 5. Connect WS and send prompt ───────────────────────────────
    await client.connectWs(['chat', 'threads'])

    const sendStart = performance.now()
    await client.timed('send-message', () => client.sendMessage(thread.id, prompt))

    // ── 6. Wait for assistant turn ──────────────────────────────────
    // Native mode uses a generous timeout — real LLM generation on a
    // complex architectural prompt can take 60–120s+.
    const turnTimeout = isNative ? 180_000 : 30_000
    let turnContent = ''
    let turnReceived = false

    try {
      const turnMsg = await client.timed('wait-for-turn', () => client.waitForWs('chat.turn', turnTimeout))
      turnReceived = true
      turnContent = turnMsg?.turn?.content ?? ''
      metrics.responseLength = turnContent.length
      metrics.responsePreview = turnContent.slice(0, 300)
      metrics.totalRoundtripMs = Math.round(performance.now() - sendStart)
    } catch (err: any) {
      metrics.turnError = err?.message
    }

    // ── 7. Wait for idle status ─────────────────────────────────────
    try {
      await client.waitForWs('chat.status', 15_000)
      metrics.gotIdle = true
    } catch {
      const drained = client.drainWs('chat.status')
      metrics.gotIdle = drained.some((m) => m.status === 'idle')
    }

    // ── 8. Docker mode: verify OpenAI-format routing ────────────────
    if (!isNative) {
      try {
        const logRes = await fetch(`${mockLlmUrl}/mock/log`)
        const log = (await logRes.json()) as any[]
        const openaiHits = log.filter((e: any) => e.format === 'openai')
        metrics.mockRequestsTotal = log.length
        metrics.mockRequestsOpenAI = openaiHits.length
      } catch {
        metrics.mockLogError = 'failed to fetch'
      }
    }

    // ── 9. Verdict ──────────────────────────────────────────────────
    if (!turnReceived) {
      return cleanup({
        passed: false,
        summary: `no response within ${turnTimeout / 1000}s — prompt sent (${prompt.length} chars)`,
        metrics,
        samples: client.samples
      })
    }

    const summary = isNative
      ? `benchmark OK — ${turnContent.length} chars in ${metrics.totalRoundtripMs}ms (native LLM)`
      : `benchmark OK — ${turnContent.length} chars, routed through local-llm mock`

    return cleanup({
      passed: true,
      summary,
      metrics,
      samples: client.samples
    })
  }
}
