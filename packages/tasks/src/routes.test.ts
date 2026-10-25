// Task routes: an import or poll that forge.trustedAuthors refuses answers 403 with the reason.

import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskImporter } from './import.js'
import { createTaskRoutes } from './routes.js'
import { createTaskService } from './service.js'
import { createInMemoryTaskStore } from './store.js'
import { makeBus } from './testing/helpers.js'

const REFUSED = 'org/repo#66 by drive-by: author not in forge.trustedAuthors'

describe('task routes: forge.trustedAuthors', () => {
  let close: (() => void) | undefined
  afterEach(() => close?.())

  async function serve() {
    const taskService = createTaskService({ store: createInMemoryTaskStore(), bus: makeBus().bus })
    const importer: TaskImporter = {
      import: async () => {
        throw new Error(REFUSED)
      }
    }
    const app = express()
    app.use(express.json())
    app.use(
      createTaskRoutes({
        taskService,
        importer,
        sendToThread: async () => {},
        pollTask: async () => {
          throw new Error(REFUSED)
        }
      })
    )
    const server = app.listen(0)
    await new Promise((r) => server.once('listening', r))
    close = () => server.close()
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const task = await taskService.create({ name: 'PR #66', sourceThreadId: 't' })
    return { base, task }
  }

  it('answers 403 with the reason on import and on poll', async () => {
    const { base, task } = await serve()
    const imp = await fetch(`${base}/api/tasks/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/org/repo/pull/66' })
    })
    expect(imp.status).toBe(403)
    expect(await imp.json()).toEqual({ error: REFUSED })
    const poll = await fetch(`${base}/api/tasks/${encodeURIComponent(task.id)}/poll`, { method: 'POST' })
    expect(poll.status).toBe(403)
    expect(await poll.json()).toEqual({ error: REFUSED })
  })
})
