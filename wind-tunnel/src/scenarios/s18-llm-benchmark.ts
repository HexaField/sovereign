// S18: LLM Benchmark — send a configurable architectural prompt through
// the local-llm backend and measure response quality + timing.
//
// Prompt source: SWT_BENCHMARK_PROMPT environment variable.
// Skips when the variable has no value.
//
// Runs ONLY inside Docker containers (enforced by the runner).
// In default mode: registers a canned response via mock-llm.
// In benchmark mode (--benchmark): routes to the host's real
// llama-server via host.docker.internal — Sovereign still runs
// inside Docker; only the inference call reaches the host.
//
// Timeout: SWT_BENCHMARK_TIMEOUT_MS env var (default 30000 for
// mock, increase for real LLM — e.g. 300000 for 5 minutes).

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
 *  substantial multi-section architectural answer. */
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
    const benchmarkMode = process.env.SWT_BENCHMARK_MODE === '1'

    // ── 1. Read prompt from env — skip when absent ───────────────────
    const prompt = process.env.SWT_BENCHMARK_PROMPT
    if (!prompt || prompt.trim() === '') {
      return skip('skipped — SWT_BENCHMARK_PROMPT not set')
    }
    metrics.promptLength = prompt.length
    metrics.benchmarkMode = benchmarkMode

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

    // ── 3. Register mock response (skipped in benchmark mode) ───────
    if (!benchmarkMode) {
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
    // Configurable timeout: real LLM generation can take minutes.
    const turnTimeout = Number(process.env.SWT_BENCHMARK_TIMEOUT_MS || (benchmarkMode ? 300_000 : 30_000))
    let turnContent = ''
    let turnReceived = false

    try {
      const deadline = performance.now() + turnTimeout
      await client.timed('wait-for-turn', async () => {
        while (performance.now() < deadline) {
          const remaining = Math.max(1000, deadline - performance.now())
          const msg = await client.waitForWs('chat.turn', remaining)
          const role = msg?.turn?.role ?? msg?.role
          if (role === 'assistant') {
            turnReceived = true
            turnContent = msg?.turn?.content ?? ''
            metrics.turnRole = role
            metrics.responseLength = turnContent.length
            metrics.responsePreview = turnContent.slice(0, 500)
            metrics.totalRoundtripMs = Math.round(performance.now() - sendStart)
            return msg
          }
          // User turn echo — skip and keep waiting
          metrics.skippedUserEcho = true
        }
        throw new Error(`no assistant turn within ${turnTimeout}ms`)
      })
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

    // ── 8. Verify routing (mock mode only) ──────────────────────────
    if (!benchmarkMode) {
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

    const label = benchmarkMode ? 'real LLM' : 'mock'
    return cleanup({
      passed: true,
      summary: `benchmark OK — ${turnContent.length} chars in ${metrics.totalRoundtripMs}ms (${label})`,
      metrics,
      samples: client.samples
    })
  }
}
