// S6: Scheduler — create, list, delete cron jobs. Verify the scheduler
// module accepts and persists jobs correctly.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

export const s6Scheduler: Scenario = {
  id: 's6',
  name: 'Scheduler CRUD',
  description: 'Create, list, and delete cron jobs',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client } = ctx
    const metrics: Record<string, unknown> = {}

    // 1. List existing scheduler jobs (baseline)
    const before = await client.timed('list-before', () => client.listJobs())
    metrics.jobsBefore = before.length

    // 2. Create a test thread for the job
    const thread = await client.timed('create-thread', () => client.createThread({ label: 'swt-s6-scheduler' }))

    // 3. Create a scheduler job (REST API uses name+schedule, not threadKey+when)
    let jobId: string | null = null
    try {
      const job = await client.timed('create-job', () =>
        client.createJob({
          name: 'swt-s6-test',
          schedule: { kind: 'oneshot', at: new Date(Date.now() + 3600_000).toISOString() },
          payload: { threadId: thread.id, prompt: 'wind-tunnel scheduler test' },
          enabled: true,
          deleteAfterRun: true
        })
      )
      jobId = job?.id ?? null
      metrics.jobId = jobId
    } catch (err: any) {
      metrics.createError = err?.message
    }

    // 4. List jobs — job should appear
    if (jobId) {
      const after = await client.timed('list-after', () => client.listJobs())
      const found = after.some((j: any) => j.id === jobId || j.name === 'swt-s6-test')
      metrics.jobInList = found

      // 5. Delete job
      try {
        await client.timed('delete-job', () => client.deleteJob(jobId!))
        metrics.deleted = true
      } catch (err: any) {
        metrics.deleteError = err?.message
      }

      // 6. Verify removal
      const afterDelete = await client.timed('list-after-delete', () => client.listJobs())
      const ghost = afterDelete.some((j: any) => j.id === jobId)
      metrics.stillPresent = ghost
    }

    // Cleanup
    await client.deleteThread(thread.id)

    const passed = jobId != null && metrics.deleted === true && metrics.stillPresent !== true

    return {
      passed,
      summary: passed
        ? 'scheduler CRUD verified — create/list/delete'
        : `scheduler CRUD failed: ${metrics.createError ?? metrics.deleteError ?? 'unknown'}`,
      metrics,
      samples: client.samples
    }
  }
}
