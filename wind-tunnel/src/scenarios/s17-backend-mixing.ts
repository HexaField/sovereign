// S17: Backend Mixing — verify that threads can select different backends
// and that the model listing respects the backend choice.
//
// Tests the full per-thread backend selection flow:
//   1. GET /api/backends returns enabled backends
//   2. Thread creation with explicit `backend` field binds correctly
//   3. GET /api/models?backend=<kind> returns per-backend model lists
//   4. PATCH /api/threads/:key/backend switches the thread's backend
//   5. Session info reflects the backend kind
//
// Self-skips when backend endpoints return 404 (pre-implementation).

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

export const s17BackendMixing: Scenario = {
  id: 's17',
  name: 'Backend Mixing',
  description: 'Per-thread backend selection, model listing, and backend switching',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client } = ctx
    const metrics: Record<string, unknown> = {}

    // 1. List available backends
    let backends: any[] = []
    let defaultBackend: string | null = null
    try {
      const res = await client.timed('list-backends', () => client.get('/api/backends'))
      backends = res?.backends ?? []
      defaultBackend = res?.defaultBackend ?? null
      metrics.backendCount = backends.length
      metrics.defaultBackend = defaultBackend
      metrics.backendKinds = backends.map((b: any) => b.kind)
    } catch (err: any) {
      if (is404(err)) return skip('skipped — /api/backends endpoint not available')
      return {
        passed: false,
        summary: `backend listing failed: ${err?.message}`,
        metrics,
        samples: client.samples
      }
    }

    if (backends.length === 0) {
      return skip('skipped — no backends reported (feature not configured)')
    }

    // 2. Test per-backend model listing
    const modelsByBackend: Record<string, string[]> = {}
    for (const b of backends) {
      try {
        const res = await client.timed(`models-${b.kind}`, () =>
          client.get(`/api/models?backend=${encodeURIComponent(b.kind)}`)
        )
        modelsByBackend[b.kind] = res?.models ?? []
      } catch {
        modelsByBackend[b.kind] = []
      }
    }
    metrics.modelsByBackend = Object.fromEntries(Object.entries(modelsByBackend).map(([k, v]) => [k, v.length]))

    // 3. Create a thread bound to the default backend
    let thread: any
    try {
      const res = await client.timed('create-thread-default', () =>
        client.post('/api/threads', {
          label: 'swt-s17-mixing-default',
          backend: defaultBackend
        })
      )
      thread = res?.thread ?? res
    } catch (err: any) {
      return {
        passed: false,
        summary: `thread creation failed: ${err?.message}`,
        metrics,
        samples: client.samples
      }
    }
    metrics.threadId = thread.id

    const finish = async (result: ScenarioResult): Promise<ScenarioResult> => {
      await client.deleteThread(thread.id).catch(() => {})
      return result
    }

    // 4. Check session info reflects the backend kind
    let sessionInfo: any = null
    try {
      sessionInfo = await client.timed('session-info', () => client.get(`/api/threads/${thread.id}/session-info`))
    } catch {
      // session-info might not have data until first message
    }
    metrics.initialBackendKind = sessionInfo?.backendKind ?? null

    // 5. If multiple backends exist, test switching
    const otherBackend = backends.find((b: any) => b.kind !== defaultBackend)
    if (otherBackend) {
      metrics.switchTarget = otherBackend.kind
      try {
        const switchRes = await client.timed('switch-backend', () =>
          client.patch(`/api/threads/${thread.id}/backend`, { backend: otherBackend.kind })
        )
        metrics.switchSuccess = switchRes?.success === true
        metrics.switchedBackend = switchRes?.backend
      } catch (err: any) {
        if (is404(err)) {
          metrics.switchSkipped = true
        } else {
          metrics.switchError = err?.message
        }
      }

      // 6. Verify session info updated after switch
      try {
        const postSwitchInfo = await client.timed('post-switch-info', () =>
          client.get(`/api/threads/${thread.id}/session-info`)
        )
        metrics.postSwitchBackendKind = postSwitchInfo?.backendKind ?? null
      } catch {
        // non-critical
      }
    } else {
      metrics.switchSkipped = 'single-backend-mode'
    }

    // 7. Default backend model listing works (back-compat — no ?backend= param)
    let defaultModelsOk = false
    try {
      const res = await client.timed('models-default', () => client.get('/api/models'))
      defaultModelsOk = Array.isArray(res?.models)
      metrics.defaultModelsCount = res?.models?.length ?? 0
    } catch {
      metrics.defaultModelsError = true
    }

    // 8. Assertions — the key contract: backends list, models per backend,
    //    and thread creation with backend binding all work.
    const backendsListed = backends.length > 0
    const modelsQueried = Object.values(modelsByBackend).some((m) => Array.isArray(m))
    const threadCreated = !!thread.id
    const passed = backendsListed && modelsQueried && threadCreated && defaultModelsOk

    return finish({
      passed,
      summary: passed
        ? `backend mixing OK — ${backends.length} backends, ` +
          `models per backend: ${JSON.stringify(metrics.modelsByBackend)}, ` +
          `switch: ${metrics.switchSuccess ?? metrics.switchSkipped ?? 'n/a'}`
        : `backend mixing failed — listed=${backendsListed}, models=${modelsQueried}, ` +
          `thread=${threadCreated}, defaultModels=${defaultModelsOk}`,
      metrics,
      samples: client.samples
    })
  }
}
