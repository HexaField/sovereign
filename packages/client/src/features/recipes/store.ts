// Pinned Recipes — per-workspace reusable parameterizable scripts
import { createSignal } from 'solid-js'
import { activeWorkspace } from '../workspace/store.js'

// ── Types ────────────────────────────────────────────────────────────

export interface RecipeParam {
  key: string
  value: string
  label?: string
}

export interface Recipe {
  id: string
  name: string
  script: string
  params: RecipeParam[]
  createdAt: number
}

// ── Storage helpers (exported for tests) ─────────────────────────────

export function recipeStorageKey(orgId: string): string {
  return `sovereign:recipes:${orgId}`
}

export function loadRecipes(orgId: string): Recipe[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(recipeStorageKey(orgId))
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

export function saveRecipes(orgId: string, recipes: Recipe[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    if (recipes.length === 0) {
      localStorage.removeItem(recipeStorageKey(orgId))
    } else {
      localStorage.setItem(recipeStorageKey(orgId), JSON.stringify(recipes))
    }
  } catch {
    /* ignore */
  }
}

// ── Pure helpers (exported for tests) ────────────────────────────────

let idCounter = 0
export function generateId(): string {
  return `recipe-${Date.now()}-${++idCounter}`
}

export function substituteParams(script: string, params: RecipeParam[]): string {
  let result = script
  for (const p of params) {
    // Use split/join instead of replaceAll for ES2020 compat
    result = result.split(`{{${p.key}}}`).join(p.value)
  }
  return result
}

export function createEmptyRecipe(): Recipe {
  return {
    id: generateId(),
    name: 'New Recipe',
    script: '',
    params: [],
    createdAt: Date.now()
  }
}

// ── Reactive store ───────────────────────────────────────────────────

function currentOrgId(): string {
  return activeWorkspace()?.orgId ?? '_global'
}

export const [recipes, setRecipes] = createSignal<Recipe[]>(loadRecipes(currentOrgId()))

/** Reload recipes when workspace changes */
export function reloadRecipes(): void {
  setRecipes(loadRecipes(currentOrgId()))
}

function persist(updated: Recipe[]): void {
  setRecipes(updated)
  saveRecipes(currentOrgId(), updated)
}

export function addRecipe(recipe?: Recipe): Recipe {
  const r = recipe ?? createEmptyRecipe()
  persist([...recipes(), r])
  return r
}

export function removeRecipe(id: string): void {
  persist(recipes().filter((r) => r.id !== id))
}

export function updateRecipe(id: string, patch: Partial<Omit<Recipe, 'id' | 'createdAt'>>): void {
  persist(recipes().map((r) => (r.id === id ? { ...r, ...patch } : r)))
}

// ── Execution ────────────────────────────────────────────────────────

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

const BASE = typeof import.meta !== 'undefined' ? import.meta.env?.BASE_URL || '/' : '/'

export async function executeRecipe(recipe: Recipe): Promise<ExecResult> {
  const command = substituteParams(recipe.script, recipe.params)
  const ws = activeWorkspace()
  const res = await fetch(`${BASE}api/terminal/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, cwd: ws?.orgId && ws.orgId !== '_global' ? undefined : undefined })
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Execution failed' }))
    return { stdout: '', stderr: err.error || 'Execution failed', exitCode: 1 }
  }
  return res.json()
}

// ── SSE parsing helpers (exported for tests) ─────────────────────────

export interface SSEEvent {
  event: string
  data: string
}

/**
 * Parse raw SSE text into events. Returns parsed events and any
 * remaining incomplete text that should be prepended to the next chunk.
 */
export function parseSSEEvents(raw: string): { events: SSEEvent[]; remainder: string } {
  const events: SSEEvent[] = []
  const blocks = raw.split('\n\n')
  // Last element may be an incomplete block
  const remainder = blocks.pop() ?? ''

  for (const block of blocks) {
    if (!block.trim()) continue
    let eventType = 'message'
    let data = ''
    const lines = block.split('\n')
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7)
      } else if (line.startsWith('data: ')) {
        data = line.slice(6)
      } else if (line.startsWith('event:')) {
        eventType = line.slice(6)
      } else if (line.startsWith('data:')) {
        data = line.slice(5)
      }
    }
    if (eventType || data) {
      events.push({ event: eventType, data })
    }
  }

  return { events, remainder }
}

// ── Streaming execution ──────────────────────────────────────────────

export interface StreamingExecution {
  pid: () => number | null
  abort: () => void
  done: Promise<void>
}

export function executeRecipeStreaming(
  recipe: Recipe,
  callbacks: {
    onStarted?: (pid: number) => void
    onStdout?: (text: string) => void
    onStderr?: (text: string) => void
    onExit?: (exitCode: number) => void
    onError?: (message: string) => void
  }
): StreamingExecution {
  const command = substituteParams(recipe.script, recipe.params)
  const controller = new AbortController()
  let currentPid: number | null = null

  const done = (async () => {
    try {
      const res = await fetch(`${BASE}api/terminal/exec/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
        signal: controller.signal
      })

      if (!res.ok || !res.body) {
        callbacks.onError?.('Failed to start streaming execution')
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      for (;;) {
        const { done: streamDone, value } = await reader.read()
        if (streamDone) break

        buffer += decoder.decode(value, { stream: true })
        const { events, remainder } = parseSSEEvents(buffer)
        buffer = remainder

        for (const ev of events) {
          switch (ev.event) {
            case 'started': {
              const parsed = JSON.parse(ev.data)
              currentPid = parsed.pid
              callbacks.onStarted?.(parsed.pid)
              break
            }
            case 'stdout':
              callbacks.onStdout?.(JSON.parse(ev.data))
              break
            case 'stderr':
              callbacks.onStderr?.(JSON.parse(ev.data))
              break
            case 'exit': {
              const parsed = JSON.parse(ev.data)
              callbacks.onExit?.(parsed.exitCode)
              break
            }
            case 'error': {
              const parsed = JSON.parse(ev.data)
              callbacks.onError?.(parsed.message)
              break
            }
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') {
        callbacks.onError?.(err.message || 'Streaming failed')
      }
    }
  })()

  const abort = () => {
    if (currentPid !== null) {
      fetch(`${BASE}api/terminal/exec/kill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid: currentPid })
      }).catch(() => {
        /* best effort */
      })
    }
    controller.abort()
  }

  return {
    pid: () => currentPid,
    abort,
    done
  }
}
