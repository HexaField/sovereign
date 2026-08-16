// Progressive tool disclosure for local-llm — mirrors Claude Code's deferred
// tool pattern. Models start with core tools + a ToolSearch meta-tool. When
// the model needs a capability beyond the core set, it calls ToolSearch with
// a query; the search returns matching tool schemas that get added to the
// active set for subsequent loop iterations.
//
// This keeps the per-request token budget small (~7 core tools vs 98+)
// while giving models access to the full tool inventory on demand.

import type { ToolSchema } from '../inference.js'
import type { ToolResult } from './index.js'

// ── Schema for the ToolSearch meta-tool ─────────────────────────────────

export const toolSearchSchema: ToolSchema = {
  type: 'function',
  function: {
    name: 'ToolSearch',
    description:
      'Search for additional tools by keyword or capability. Returns matching tool schemas ' +
      'that become available for use in subsequent calls. Use this when you need a capability ' +
      'not provided by the core tools (Read, Write, Edit, Bash, Grep, Glob, LS).\n\n' +
      'Available tool categories:\n' +
      '- "cron" / "schedule" — create, list, delete scheduled jobs\n' +
      '- "sessions" / "threads" — list, send to, read history from other threads\n' +
      '- "agents" / "subagent" — spawn and list subagents\n' +
      '- "browser" — open, act on, close browser sessions\n' +
      '- "web" / "fetch" / "http" — fetch web pages and APIs\n' +
      '- "notifications" / "notify" — send push notifications\n' +
      '- "planning" / "issues" — create and update planning nodes/issues\n' +
      '- "orgs" / "meetings" — list orgs, read meeting transcripts\n' +
      '- "embeddings" / "search" / "index" — semantic search and indexing\n' +
      '- "semble" / "code search" — semantic code search\n' +
      '- "ad4m" / "perspective" / "entity" / "note" / "link" — AD4M knowledge graph\n\n' +
      'Pass a keyword query to find relevant tools. Returns up to 10 matching tool schemas.',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description:
            'Keyword query to search for tools. Examples: "schedule a cron job", "fetch a web page", ' +
            '"send a notification", "search code", "create an entity".'
        },
        max_results: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'Maximum number of tool schemas to return. Defaults to 10.'
        }
      },
      additionalProperties: false
    }
  }
}

// ── Search index entry ──────────────────────────────────────────────────

interface ToolEntry {
  schema: ToolSchema
  /** Lowercase searchable text: tool name + description + param names. */
  searchText: string
  /** Category tag for grouped matching. */
  category: string
}

// ── Keyword → category mapping ──────────────────────────────────────────

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  cron: ['cron', 'schedule', 'timer', 'interval', 'recurring', 'oneshot', 'job'],
  sessions: ['session', 'thread', 'send', 'history', 'message'],
  agents: ['agent', 'subagent', 'spawn', 'worker'],
  browser: ['browser', 'navigate', 'click', 'screenshot', 'webpage', 'tab'],
  web: ['web', 'fetch', 'http', 'url', 'download', 'request', 'api'],
  notifications: ['notification', 'notify', 'alert', 'push'],
  planning: ['planning', 'issue', 'project', 'ticket', 'task', 'node'],
  orgs: ['org', 'organization', 'workspace', 'meeting', 'transcript'],
  embeddings: ['embedding', 'vector', 'semantic', 'index', 'collection'],
  semble: ['semble', 'code search', 'find related', 'symbol'],
  ad4m: [
    'ad4m',
    'perspective',
    'entity',
    'note',
    'link',
    'subject',
    'neighbourhood',
    'did',
    'knowledge',
    'graph',
    'flux'
  ]
}

function categorize(schema: ToolSchema): string {
  const name = schema.function.name.toLowerCase()
  if (name.startsWith('ad4m_')) return 'ad4m'
  if (name.includes('cron')) return 'cron'
  if (name.includes('session')) return 'sessions'
  if (name.includes('agent')) return 'agents'
  if (name.includes('browser')) return 'browser'
  if (name.includes('webfetch') || name.includes('web_fetch')) return 'web'
  if (name.includes('notification')) return 'notifications'
  if (name.includes('issue') || name.includes('planning')) return 'planning'
  if (name.includes('org') || name.includes('meeting')) return 'orgs'
  if (name.includes('embedding')) return 'embeddings'
  if (name.includes('semble')) return 'semble'
  return 'other'
}

function buildSearchText(schema: ToolSchema): string {
  const fn = schema.function
  const parts = [fn.name, fn.description ?? '']
  const params = fn.parameters as Record<string, unknown> | undefined
  if (params?.properties && typeof params.properties === 'object') {
    for (const key of Object.keys(params.properties as object)) {
      parts.push(key)
    }
  }
  return parts.join(' ').toLowerCase()
}

// ── ToolSearch registry ─────────────────────────────────────────────────

export interface ToolSearchRegistry {
  /** Execute a ToolSearch query — returns matching schemas as a tool result. */
  execute(input: Record<string, unknown>): ToolResult
  /** Get the schemas that have been loaded (searched for) this session. */
  getLoadedSchemas(): ToolSchema[]
  /** Register additional tool schemas into the searchable index. */
  addSchemas(schemas: ToolSchema[]): void
  /** Check whether a tool name has been loaded into the active set. */
  hasLoaded(toolName: string): boolean
  /** Total tools available in the registry (for system prompt info). */
  totalAvailable(): number
}

export function createToolSearchRegistry(
  /** Initial deferred schemas — not sent on the wire, but searchable. */
  deferredSchemas: ToolSchema[]
): ToolSearchRegistry {
  const entries: ToolEntry[] = []
  const loadedSet = new Set<string>()
  const loadedSchemas: ToolSchema[] = []

  function addSchemas(schemas: ToolSchema[]): void {
    for (const schema of schemas) {
      // Avoid duplicates
      if (entries.some((e) => e.schema.function.name === schema.function.name)) continue
      entries.push({
        schema,
        searchText: buildSearchText(schema),
        category: categorize(schema)
      })
    }
  }

  // Initialize with the deferred schemas
  addSchemas(deferredSchemas)

  function search(query: string, maxResults: number): ToolEntry[] {
    const q = query.toLowerCase().trim()
    if (!q) return entries.slice(0, maxResults)

    const terms = q.split(/\s+/)

    // Phase 1: exact category match via keyword mapping
    const matchedCategories = new Set<string>()
    for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      if (keywords.some((kw) => terms.some((t) => t.includes(kw) || kw.includes(t)))) {
        matchedCategories.add(cat)
      }
    }

    // Score each entry
    const scored = entries.map((entry) => {
      let score = 0

      // Category match — strong signal
      if (matchedCategories.has(entry.category)) score += 10

      // Term matches in search text
      for (const term of terms) {
        if (entry.searchText.includes(term)) score += 3
        // Partial match on tool name
        if (entry.schema.function.name.toLowerCase().includes(term)) score += 5
      }

      return { entry, score }
    })

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map((s) => s.entry)
  }

  function execute(input: Record<string, unknown>): ToolResult {
    const query = typeof input.query === 'string' ? input.query : ''
    if (!query.trim()) {
      return { content: '', error: 'query is required — describe what tools you need.' }
    }

    const maxResults = typeof input.max_results === 'number' ? Math.min(input.max_results, 20) : 10
    const matches = search(query, maxResults)

    if (matches.length === 0) {
      return {
        content:
          `No tools matched "${query}". Available categories: ` +
          Object.keys(CATEGORY_KEYWORDS).join(', ') +
          '.\nTry a broader query.'
      }
    }

    // Mark matched tools as loaded
    for (const match of matches) {
      const name = match.schema.function.name
      if (!loadedSet.has(name)) {
        loadedSet.add(name)
        loadedSchemas.push(match.schema)
      }
    }

    // Format the response — return the schemas so the model knows how to call them
    const toolSummaries = matches.map((m) => {
      const fn = m.schema.function
      const params = fn.parameters as Record<string, unknown> | undefined
      const propKeys =
        params?.properties && typeof params.properties === 'object' ? Object.keys(params.properties as object) : []
      const required = Array.isArray(params?.required) ? (params.required as string[]) : []

      return [
        `## ${fn.name}`,
        fn.description ?? '',
        propKeys.length > 0
          ? `Parameters: ${propKeys.map((k) => (required.includes(k) ? `${k} (required)` : k)).join(', ')}`
          : 'No parameters.'
      ].join('\n')
    })

    return {
      content:
        `Found ${matches.length} tool(s). These tools are now available for use:\n\n` + toolSummaries.join('\n\n')
    }
  }

  return {
    execute,
    getLoadedSchemas: () => [...loadedSchemas],
    addSchemas,
    hasLoaded: (name: string) => loadedSet.has(name),
    totalAvailable: () => entries.length
  }
}
