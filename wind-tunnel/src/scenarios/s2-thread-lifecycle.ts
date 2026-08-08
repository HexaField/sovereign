// S2: Thread Lifecycle — create, read, update, list, delete threads.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

export const s2ThreadLifecycle: Scenario = {
  id: 's2',
  name: 'Thread Lifecycle',
  description: 'Thread CRUD: create, read, update, list, delete',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client } = ctx
    const metrics: Record<string, unknown> = {}

    // 1. List existing threads (baseline)
    const before = await client.timed('list-before', () => client.listThreads())
    metrics.threadsBefore = before.length

    // 2. Create a thread
    const created = await client.timed('create', () => client.createThread({ label: 'swt-test-thread' }))
    if (!created?.id) {
      return { passed: false, summary: 'create returned no id', metrics, samples: client.samples }
    }
    metrics.createdId = created.id
    metrics.createdLabel = created.label

    // 3. Read it back
    const fetched = await client.timed('get', () => client.getThread(created.id))
    if (fetched?.id !== created.id) {
      return { passed: false, summary: 'get returned wrong thread', metrics, samples: client.samples }
    }

    // 4. Update label
    const updated = await client.timed('update', () => client.updateThread(created.id, { label: 'swt-renamed' }))
    if (updated?.label !== 'swt-renamed') {
      return {
        passed: false,
        summary: `update label failed: got "${updated?.label}"`,
        metrics,
        samples: client.samples
      }
    }
    metrics.updatedLabel = updated.label

    // 5. Verify in list
    const after = await client.timed('list-after', () => client.listThreads())
    const found = after.find((t: any) => t.id === created.id)
    if (!found) {
      return { passed: false, summary: 'created thread missing from list', metrics, samples: client.samples }
    }

    // 6. Delete
    await client.timed('delete', () => client.deleteThread(created.id))

    // 7. Verify deletion
    const afterDelete = await client.timed('list-after-delete', () => client.listThreads())
    const ghost = afterDelete.find((t: any) => t.id === created.id)
    if (ghost) {
      return { passed: false, summary: 'deleted thread still in list', metrics, samples: client.samples }
    }
    metrics.threadsAfterDelete = afterDelete.length

    return {
      passed: true,
      summary: `CRUD verified — create/read/update/list/delete all passed`,
      metrics,
      samples: client.samples
    }
  }
}
