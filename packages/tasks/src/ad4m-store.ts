// AD4M-backed TaskStore — persists tasks as subject-class instances in
// the `hex-tasks` perspective.
//
// Uses the PerspectiveProxy API:
//   - createSubject(className, exprAddr, initialValues) — create
//   - getSubjectData(className, exprAddr) — read
//   - setSingleTarget(link) — update scalar property
//   - addLink / removeLink — manage collections
//   - get(LinkQuery) — query links for listing + traversal
//
// The perspective and schema MUST already exist before creating this
// store. Use bootstrapTaskPerspective() first.

import { Literal, LinkQuery } from '@coasys/ad4m'
import type { Ad4mClientManager } from '@sovereign/ad4m'
import type { TaskStore } from './store.js'
import type { Task, TaskListItem, TaskProvider, TaskRef, TaskState } from './types.js'

const CLASS_NAME = 'Task'
const TYPE_PREDICATE = 'rdf://type'
const TYPE_TARGET = 'task://Task'
const NS = 'task://'

/** Encode a string value as a Literal URL for AD4M link targets. */
function toLiteral(value: string): string {
  return Literal.from(value).toUrl()
}

/** Decode a Literal URL back to a plain string. Returns the raw URL
 *  when the format cannot parse (safety net). */
function fromLiteral(url: string): string {
  try {
    return Literal.fromUrl(url).get() as string
  } catch {
    return url
  }
}

interface Ad4mStoreOpts {
  ad4m: Ad4mClientManager
  perspectiveUuid: string
}

export function createAd4mTaskStore(opts: Ad4mStoreOpts): TaskStore {
  const { ad4m, perspectiveUuid } = opts

  function proxy() {
    const client = ad4m.getClient()
    if (!client) throw new Error('[tasks] AD4M client not connected')
    // The PerspectiveProxy wraps the AD4M SDK — obtain via perspective.byUUID()
    // but that returns a Promise. For synchronous access, cache it.
    return client.perspective
  }

  /** Get the PerspectiveProxy for our perspective. */
  async function perspective() {
    const p = await proxy().byUUID(perspectiveUuid)
    if (!p) throw new Error(`[tasks] Perspective ${perspectiveUuid} not found`)
    return p
  }

  /** Read a single link target for source + predicate. Returns null when absent. */
  async function readProp(
    p: Awaited<ReturnType<typeof perspective>>,
    taskId: string,
    predicate: string
  ): Promise<string | null> {
    const links = await p.get(new LinkQuery({ source: taskId, predicate: `${NS}${predicate}` }))
    if (links.length === 0) return null
    return fromLiteral(links[0].data.target)
  }

  /** Read all link targets for a collection predicate. */
  async function readCollection(
    p: Awaited<ReturnType<typeof perspective>>,
    taskId: string,
    predicate: string
  ): Promise<string[]> {
    const links = await p.get(new LinkQuery({ source: taskId, predicate: `${NS}${predicate}` }))
    return links.map((l: any) => l.data.target)
  }

  /** Resolve a task IRI to a TaskRef (id, name, state). Returns null when absent. */
  async function resolveRef(p: Awaited<ReturnType<typeof perspective>>, taskId: string): Promise<TaskRef | null> {
    const name = await readProp(p, taskId, 'name')
    const state = await readProp(p, taskId, 'state')
    if (!name || !state) return null
    return { id: taskId, name, state: state as TaskState }
  }

  /** Build a full Task from perspective data. */
  async function readTask(p: Awaited<ReturnType<typeof perspective>>, taskId: string): Promise<Task | null> {
    const name = await readProp(p, taskId, 'name')
    if (!name) return null

    const [state, threadId, description, transientState, createdAt, updatedAt] = await Promise.all([
      readProp(p, taskId, 'state'),
      readProp(p, taskId, 'threadId'),
      readProp(p, taskId, 'description'),
      readProp(p, taskId, 'transientState'),
      readProp(p, taskId, 'createdAt'),
      readProp(p, taskId, 'updatedAt')
    ])

    const [parentIris, childIris, tagLiterals, providerJson] = await Promise.all([
      readCollection(p, taskId, 'parentTasks'),
      readCollection(p, taskId, 'childTasks'),
      readCollection(p, taskId, 'tags'),
      readProp(p, taskId, 'provider')
    ])

    const parentTasks: TaskRef[] = []
    for (const iri of parentIris) {
      const ref = await resolveRef(p, iri)
      if (ref) parentTasks.push(ref)
    }
    const childTasks: TaskRef[] = []
    for (const iri of childIris) {
      const ref = await resolveRef(p, iri)
      if (ref) childTasks.push(ref)
    }

    let provider: TaskProvider | undefined
    if (providerJson) {
      try {
        provider = JSON.parse(providerJson) as TaskProvider
      } catch {
        /* corrupt provider data — skip */
      }
    }

    const task: Task = {
      id: taskId,
      name,
      state: (state as TaskState) ?? 'pending',
      threadId: threadId ?? null,
      description: description ?? null,
      transientState: transientState ?? null,
      createdAt: createdAt ?? new Date().toISOString(),
      updatedAt: updatedAt ?? null,
      parentTasks,
      childTasks,
      tags: tagLiterals.map(fromLiteral)
    }
    if (provider) task.provider = provider
    return task
  }

  return {
    async create(task) {
      const p = await perspective()

      // Create subject with initial values via AD4M
      await p.createSubject(CLASS_NAME, task.id, {
        name: task.name,
        state: task.state,
        createdAt: task.createdAt,
        ...(task.threadId ? { threadId: task.threadId } : {}),
        ...(task.description ? { description: task.description } : {}),
        ...(task.transientState ? { transientState: task.transientState } : {}),
        ...(task.provider ? { provider: JSON.stringify(task.provider) } : {})
      })

      // Add tags via collection adder
      for (const tag of task.tags) {
        await p.addLinks([
          {
            source: task.id,
            predicate: `${NS}tags`,
            target: toLiteral(tag)
          }
        ])
      }

      const result = await readTask(p, task.id)
      return result ?? { ...task, parentTasks: [], childTasks: [] }
    },

    async get(id) {
      const p = await perspective()
      return readTask(p, id)
    },

    async list(filter) {
      const p = await perspective()
      // Find all task IRIs via type link
      const typeLinks = await p.get(new LinkQuery({ predicate: TYPE_PREDICATE, target: TYPE_TARGET }))
      const taskIds = typeLinks.map((l: any) => l.data.source as string)

      const results: TaskListItem[] = []
      for (const taskId of taskIds) {
        const name = await readProp(p, taskId, 'name')
        if (!name) continue

        const [state, threadId, transientState, providerJson] = await Promise.all([
          readProp(p, taskId, 'state') as Promise<string | null>,
          readProp(p, taskId, 'threadId'),
          readProp(p, taskId, 'transientState'),
          readProp(p, taskId, 'provider')
        ])
        const parentIris = await readCollection(p, taskId, 'parentTasks')
        const childIris = await readCollection(p, taskId, 'childTasks')

        const typedState = (state as TaskState) ?? 'pending'

        // Apply filters
        if (filter?.state && typedState !== filter.state) continue
        if (filter?.threadId !== undefined) {
          if (filter.threadId === null && threadId !== null) continue
          if (filter.threadId !== null && threadId !== filter.threadId) continue
        }
        if (filter?.parentId && !parentIris.includes(filter.parentId)) continue
        if (filter?.rootsOnly && parentIris.length > 0) continue

        const item: TaskListItem = {
          id: taskId,
          name,
          state: typedState,
          threadId: threadId ?? null,
          transientState: transientState ?? null,
          childCount: childIris.length,
          parentCount: parentIris.length
        }

        if (providerJson) {
          try {
            const prov = JSON.parse(providerJson) as TaskProvider
            item.provider = {
              kind: prov.kind,
              repo: prov.repo,
              number: prov.number,
              prStatus: prov.prStatus,
              checksStatus: prov.checksStatus,
              reviewDecision: prov.reviewDecision,
              url: prov.url
            }
          } catch {
            /* corrupt — skip provider badge */
          }
        }

        results.push(item)
      }
      return results
    },

    async update(id, fields) {
      const p = await perspective()

      // Update scalar properties via setSingleTarget
      const scalarFields: Array<[string, string | null | undefined]> = [
        ['name', fields.name],
        ['state', fields.state],
        ['threadId', fields.threadId],
        ['description', fields.description],
        ['transientState', fields.transientState],
        ['updatedAt', fields.updatedAt]
      ]

      for (const [prop, value] of scalarFields) {
        if (value === undefined) continue
        if (value === null) {
          // Remove the link (unset)
          const existing = await p.get(new LinkQuery({ source: id, predicate: `${NS}${prop}` }))
          if (existing.length > 0) {
            await p.removeLinks(existing)
          }
        } else {
          await p.setSingleTarget({
            source: id,
            predicate: `${NS}${prop}`,
            target: toLiteral(value)
          })
        }
      }

      // Update provider as JSON string
      if (fields.provider !== undefined) {
        await p.setSingleTarget({
          source: id,
          predicate: `${NS}provider`,
          target: toLiteral(JSON.stringify(fields.provider))
        })
      }

      // Replace tags if provided
      if (fields.tags !== undefined) {
        // Remove existing tags
        const existingTags = await p.get(new LinkQuery({ source: id, predicate: `${NS}tags` }))
        if (existingTags.length > 0) {
          await p.removeLinks(existingTags)
        }
        // Add new tags
        for (const tag of fields.tags) {
          await p.addLinks([
            {
              source: id,
              predicate: `${NS}tags`,
              target: toLiteral(tag)
            }
          ])
        }
      }

      const result = await readTask(p, id)
      if (!result) throw new Error(`Task not found after update: ${id}`)
      return result
    },

    async addLink(parentId, childId) {
      const p = await perspective()
      // Bidirectional: parent → childTasks, child → parentTasks
      await p.addLinks([{ source: parentId, predicate: `${NS}childTasks`, target: childId }])
      await p.addLinks([{ source: childId, predicate: `${NS}parentTasks`, target: parentId }])
    },

    async removeLink(parentId, childId) {
      const p = await perspective()
      // Remove bidirectional links
      const childLinks = await p.get(new LinkQuery({ source: parentId, predicate: `${NS}childTasks`, target: childId }))
      if (childLinks.length > 0) await p.removeLinks(childLinks)
      const parentLinks = await p.get(
        new LinkQuery({ source: childId, predicate: `${NS}parentTasks`, target: parentId })
      )
      if (parentLinks.length > 0) await p.removeLinks(parentLinks)
    },

    async ancestors(taskId) {
      const p = await perspective()
      const visited = new Set<string>()
      const queue = [taskId]
      while (queue.length > 0) {
        const current = queue.pop()!
        const parentIris = await readCollection(p, current, 'parentTasks')
        for (const pid of parentIris) {
          if (!visited.has(pid)) {
            visited.add(pid)
            queue.push(pid)
          }
        }
      }
      return visited
    },

    dispose() {
      // No resources to clean up — AD4M client managed externally
    }
  }
}
