// Task perspective bootstrap — creates the `hex-tasks` AD4M perspective
// and registers the Task SHACL schema on first use.
//
// Follows the same pattern as packages/presence/src/knowledge-graph.ts:
//   1. Check for cached perspective UUID on disk
//   2. Find or create the perspective by name
//   3. Register the SHACL schema if not already present
//   4. Persist the UUID for next restart

import fs from 'node:fs'
import path from 'node:path'
import type { Ad4mClientManager } from '@sovereign/ad4m'
import { TASK_SHACL_SCHEMA } from './types.js'

export interface TaskBootstrapOpts {
  /** AD4M client manager — provides getClient() + onConnected(). */
  ad4m: Ad4mClientManager
  /** Agent name from config (e.g. "Hex"). Derives the perspective name:
   *  `${agentName.toLowerCase()}-tasks`. */
  agentName: string
  /** Directory to persist the resolved perspective UUID. Writes
   *  `task-perspective.json` here for fast lookup across restarts. */
  dataDir: string
}

interface PersistedState {
  perspectiveName: string
  perspectiveUuid: string
  schemaRegistered: boolean
}

const STATE_FILE = 'task-perspective.json'
const TAG = '[tasks]'

function perspectiveName(agentName: string): string {
  return `${agentName.toLowerCase()}-tasks`
}

function readState(dataDir: string): PersistedState | null {
  try {
    const raw = fs.readFileSync(path.join(dataDir, STATE_FILE), 'utf-8')
    return JSON.parse(raw) as PersistedState
  } catch {
    return null
  }
}

function writeState(dataDir: string, state: PersistedState): void {
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    const filePath = path.join(dataDir, STATE_FILE)
    const tmp = filePath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
    fs.renameSync(tmp, filePath)
  } catch (err) {
    console.warn(TAG, 'failed to persist state:', (err as Error)?.message)
  }
}

/** Bootstrap the task perspective. Returns the perspective UUID once
 *  ready, or null when AD4M remains unavailable. Fires asynchronously
 *  via onConnected — the returned promise resolves on first success. */
export function bootstrapTaskPerspective(opts: TaskBootstrapOpts): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false

    function done(uuid: string | null) {
      if (resolved) return
      resolved = true
      resolve(uuid)
    }

    // Check cached state
    const cached = readState(opts.dataDir)
    if (cached?.perspectiveUuid) {
      console.log(TAG, `cached perspective UUID: ${cached.perspectiveUuid}`)
    }

    const name = perspectiveName(opts.agentName)

    opts.ad4m.onConnected(async () => {
      const client = opts.ad4m.getClient()
      if (!client) {
        console.warn(TAG, 'onConnected fired but client absent')
        done(null)
        return
      }

      try {
        // 1. Find or create perspective
        let uuid = cached?.perspectiveUuid ?? null

        if (uuid) {
          // Verify the cached perspective still exists
          const existing = await client.perspective.byUUID(uuid)
          if (!existing) {
            console.warn(TAG, `cached perspective ${uuid} disappeared — recreating`)
            uuid = null
          }
        }

        if (!uuid) {
          // Search by name
          const all = await client.perspective.all()
          const found = all.find((p: any) => p.name === name)
          if (found) {
            uuid = found.uuid
            console.log(TAG, `found existing perspective: ${name} (${uuid})`)
          } else {
            // Create new perspective
            const created = await client.perspective.add(name)
            uuid = created.uuid
            console.log(TAG, `created perspective: ${name} (${uuid})`)
          }
        }

        // 2. Register SHACL schema if needed
        const needsSchema = !cached?.schemaRegistered || !cached.perspectiveUuid
        if (needsSchema) {
          const p = await client.perspective.byUUID(uuid)
          if (p) {
            let existingClasses: string[] = []
            try {
              existingClasses = await p.subjectClasses()
            } catch {
              // AD4M version may not support subjectClasses()
            }

            if (!existingClasses.includes('Task')) {
              try {
                await p.addSubjectClass('Task', JSON.stringify(TASK_SHACL_SCHEMA))
                console.log(TAG, 'registered Task schema')
              } catch (err) {
                console.warn(TAG, 'failed to register Task schema:', (err as Error)?.message)
              }
            } else {
              console.log(TAG, 'Task schema already registered')
            }
          }
        }

        // 3. Persist state
        writeState(opts.dataDir, {
          perspectiveName: name,
          perspectiveUuid: uuid,
          schemaRegistered: true
        })

        console.log(TAG, `bootstrap complete — ${name} (${uuid})`)
        done(uuid)
      } catch (err) {
        console.error(TAG, 'bootstrap failed:', (err as Error)?.message)
        done(null)
      }
    })

    // Timeout — resolve null after 30s when AD4M never connects
    setTimeout(() => {
      if (!resolved) {
        console.warn(TAG, 'bootstrap timed out — AD4M did not connect within 30s')
        done(null)
      }
    }, 30_000)
  })
}
