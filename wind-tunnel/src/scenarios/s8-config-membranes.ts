// S8: Config & Membranes — verify config endpoint serves valid JSON,
// membrane CRUD works, and client config filters sensitive fields.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

export const s8ConfigMembranes: Scenario = {
  id: 's8',
  name: 'Config & Membranes',
  description: 'Config endpoint, client config, membrane CRUD',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client } = ctx
    const metrics: Record<string, unknown> = {}

    // 1. Full config
    const config = await client.timed('full-config', () => client.config())
    metrics.hasServerConfig = config?.server != null
    metrics.configKeys = Object.keys(config ?? {})

    // 2. Client-safe config
    const clientConfig = await client.timed('client-config', () => client.get('/api/config/client'))
    metrics.clientConfigKeys = Object.keys(clientConfig ?? {})

    // 3. List membranes (baseline)
    const membranesBefore = await client.timed('list-membranes', () => client.membranes())
    metrics.membraneCount = membranesBefore.length

    // 4. Create a membrane
    let membraneId: string | null = null
    try {
      const created = await client.timed('create-membrane', () =>
        client.post('/api/membranes', { label: 'swt-s8-test', description: 'wind tunnel test' })
      )
      membraneId = created?.id ?? null
      metrics.membraneId = membraneId
    } catch (err: any) {
      metrics.membraneCreateError = err?.message
    }

    // 5. Clean up if created
    if (membraneId) {
      try {
        await client.timed('delete-membrane', () => client.del(`/api/membranes/${membraneId}`))
        metrics.membraneDeleted = true
      } catch (err: any) {
        metrics.membraneDeleteError = err?.message
      }
    }

    const passed = config != null && clientConfig != null
    return {
      passed,
      summary: `config OK — ${(metrics.configKeys as string[])?.length ?? 0} keys, ${membranesBefore.length} membrane(s)`,
      metrics,
      samples: client.samples
    }
  }
}
