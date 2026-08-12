// Knowledge graph bootstrap — automates AD4M perspective + model registration.
//
// Replaces the manual LLM-driven bootstrap (PRESENCE.md § "On session start").
// Runs once at startup when the AD4M client connects. No LLM session needed.
//
// The perspective name derives from the agent's identity.agentName config
// (e.g. "Hex" → "hex-knowledge"). Models come from a SHACL schemas JSON
// file whose path the caller provides.

import fs from 'node:fs'
import path from 'node:path'
import type { Ad4mClientManager } from '@sovereign/ad4m'

export interface KnowledgeGraphBootstrapOpts {
  /** AD4M client manager — provides getClient() + onConnected(). */
  ad4m: Ad4mClientManager
  /** Agent name from config (identity.agentName). Used to derive the
   *  perspective name: `${agentName.toLowerCase()}-knowledge`. */
  agentName: string
  /** Absolute path to the JSON file containing SHACL subject-class
   *  definitions. Expected shape: `{ [className]: shaclDefinition }`. */
  schemasFile: string
  /** Directory to persist the resolved perspective UUID. The bootstrap
   *  writes `knowledge-graph.json` here for fast lookup across restarts. */
  dataDir: string
  /** Optional: path to PRESENCE_MEMORY.md to update with the perspective
   *  UUID. When provided, the bootstrap appends/updates the UUID entry. */
  memoryFile?: string
}

interface PersistedState {
  perspectiveName: string
  perspectiveUuid: string
  registeredModels: string[]
}

const STATE_FILE = 'knowledge-graph.json'
const TAG = '[knowledge-graph]'

function perspectiveName(agentName: string): string {
  return `${agentName.toLowerCase()}-knowledge`
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
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, STATE_FILE), JSON.stringify(state, null, 2) + '\n')
}

function readSchemas(schemasFile: string): Record<string, unknown> {
  const raw = fs.readFileSync(schemasFile, 'utf-8')
  return JSON.parse(raw) as Record<string, unknown>
}

/**
 * Update PRESENCE_MEMORY.md with the current perspective UUID.
 * Replaces an existing `Perspective UUID:` line or appends a new section.
 */
function updateMemoryFile(memoryFile: string, name: string, uuid: string): void {
  let content = ''
  try {
    content = fs.readFileSync(memoryFile, 'utf-8')
  } catch {
    /* file missing — start fresh */
  }

  const uuidLine = `Perspective UUID: \`${uuid}\``
  const uuidPattern = /^Perspective UUID:.*$/m

  if (uuidPattern.test(content)) {
    content = content.replace(uuidPattern, uuidLine)
  } else {
    const section = [
      '',
      `## Knowledge graph — ${name} (${new Date().toISOString().slice(0, 10)})`,
      '',
      uuidLine,
      'Models registered: Entity, Note. Bootstrap ran automatically at startup.',
      ''
    ].join('\n')
    content = content.trimEnd() + '\n' + section
  }

  fs.writeFileSync(memoryFile, content)
}

/**
 * Bootstrap the AD4M knowledge graph perspective and models.
 *
 * Call once at startup. Registers an `onConnected` callback on the AD4M
 * client manager. When the client connects (or reconnects), the bootstrap:
 *
 *  1. Checks for a persisted perspective UUID in `dataDir/knowledge-graph.json`.
 *  2. Verifies the perspective still exists via the SDK.
 *  3. Creates the perspective if missing (named `${agentName}-knowledge`).
 *  4. Registers any missing SHACL subject classes (Entity, Note, etc.).
 *  5. Persists the UUID and updates PRESENCE_MEMORY.md.
 *
 * Returns an unsubscribe function to tear down the onConnected listener.
 */
export function bootstrapKnowledgeGraph(opts: KnowledgeGraphBootstrapOpts): () => void {
  const name = perspectiveName(opts.agentName)
  let bootstrapped = false

  const unsub = opts.ad4m.onConnected(async () => {
    // Run once per process — reconnects after the initial bootstrap skip.
    if (bootstrapped) return
    bootstrapped = true

    try {
      await runBootstrap(opts, name)
    } catch (err) {
      console.error(TAG, 'bootstrap failed:', (err as Error)?.message ?? err)
    }
  })

  return unsub
}

async function runBootstrap(opts: KnowledgeGraphBootstrapOpts, name: string): Promise<void> {
  const client = opts.ad4m.getClient()
  if (!client) {
    console.warn(TAG, 'AD4M client unavailable — skipping bootstrap')
    return
  }

  // 1. Check persisted state for a known UUID
  const cached = readState(opts.dataDir)
  let uuid: string | null = null

  if (cached?.perspectiveUuid && cached.perspectiveName === name) {
    // Verify the perspective still exists
    try {
      const proxy = await client.perspective.byUUID(cached.perspectiveUuid)
      if (proxy) {
        uuid = cached.perspectiveUuid
        console.log(TAG, `found persisted perspective ${name} (${uuid})`)
      }
    } catch {
      console.warn(TAG, `persisted UUID ${cached.perspectiveUuid} no longer valid`)
    }
  }

  // 2. Search existing perspectives by name
  if (!uuid) {
    try {
      const all = await client.perspective.all()
      const match = all.find((p) => p.name === name)
      if (match) {
        uuid = match.uuid
        console.log(TAG, `found existing perspective ${name} (${uuid})`)
      }
    } catch (err) {
      console.error(TAG, 'failed to list perspectives:', (err as Error)?.message)
      return
    }
  }

  // 3. Create the perspective if it does not exist
  if (!uuid) {
    try {
      const created = await client.perspective.add(name)
      uuid = created.uuid
      console.log(TAG, `created perspective ${name} (${uuid})`)
    } catch (err) {
      console.error(TAG, 'failed to create perspective:', (err as Error)?.message)
      return
    }
  }

  // 4. Register missing SHACL subject classes
  let schemas: Record<string, unknown>
  try {
    schemas = readSchemas(opts.schemasFile)
  } catch (err) {
    console.warn(TAG, `cannot read schemas from ${opts.schemasFile}:`, (err as Error)?.message)
    // Perspective exists but models may need manual registration — still persist the UUID
    writeState(opts.dataDir, { perspectiveName: name, perspectiveUuid: uuid, registeredModels: [] })
    return
  }

  const proxy = await client.perspective.byUUID(uuid)
  if (!proxy) {
    console.error(TAG, `perspective ${uuid} disappeared mid-bootstrap`)
    return
  }

  let existingClasses: string[] = []
  try {
    existingClasses = await proxy.subjectClasses()
  } catch {
    // AD4M may not support subjectClasses() on this version — register anyway
  }

  const registered: string[] = [...(cached?.registeredModels ?? [])]
  for (const [className, definition] of Object.entries(schemas)) {
    if (existingClasses.includes(className)) {
      if (!registered.includes(className)) registered.push(className)
      continue
    }
    try {
      const shaclJson = typeof definition === 'string' ? definition : JSON.stringify(definition)
      await proxy.addSubjectClass(className, shaclJson)
      console.log(TAG, `registered model: ${className}`)
      if (!registered.includes(className)) registered.push(className)
    } catch (err) {
      console.warn(TAG, `failed to register ${className}:`, (err as Error)?.message)
    }
  }

  // 5. Persist state
  writeState(opts.dataDir, { perspectiveName: name, perspectiveUuid: uuid, registeredModels: registered })
  console.log(TAG, `bootstrap complete — ${name} (${uuid}), models: [${registered.join(', ')}]`)

  // 6. Update PRESENCE_MEMORY.md if path provided
  if (opts.memoryFile) {
    try {
      updateMemoryFile(opts.memoryFile, name, uuid)
    } catch (err) {
      console.warn(TAG, 'failed to update memory file:', (err as Error)?.message)
    }
  }
}
