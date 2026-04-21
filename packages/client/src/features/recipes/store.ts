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
