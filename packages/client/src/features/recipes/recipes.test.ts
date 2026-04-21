import { describe, it, expect, beforeEach } from 'vitest'
import {
  recipeStorageKey,
  loadRecipes,
  saveRecipes,
  substituteParams,
  createEmptyRecipe,
  generateId,
  type Recipe,
  type RecipeParam
} from './store.js'

// ── Mock localStorage ────────────────────────────────────────────────

const store: Record<string, string> = {}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k]
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v
      },
      removeItem: (k: string) => {
        delete store[k]
      }
    },
    writable: true,
    configurable: true
  })
})

// ── Tests ────────────────────────────────────────────────────────────

describe('Pinned Recipes — store', () => {
  describe('recipeStorageKey', () => {
    it('generates per-workspace keys', () => {
      expect(recipeStorageKey('ws-123')).toBe('sovereign:recipes:ws-123')
      expect(recipeStorageKey('_global')).toBe('sovereign:recipes:_global')
    })

    it('different workspaces produce different keys', () => {
      expect(recipeStorageKey('a')).not.toBe(recipeStorageKey('b'))
    })
  })

  describe('loadRecipes / saveRecipes', () => {
    it('returns empty array when nothing stored', () => {
      expect(loadRecipes('new-ws')).toEqual([])
    })

    it('round-trips recipes through localStorage', () => {
      const recipes: Recipe[] = [
        {
          id: 'r1',
          name: 'Deploy',
          script: 'deploy --env {{env}}',
          params: [{ key: 'env', value: 'prod' }],
          createdAt: 1000
        }
      ]
      saveRecipes('ws1', recipes)
      const loaded = loadRecipes('ws1')
      expect(loaded).toEqual(recipes)
    })

    it('saves multiple recipes', () => {
      const recipes: Recipe[] = [
        { id: 'r1', name: 'A', script: 'echo a', params: [], createdAt: 1 },
        { id: 'r2', name: 'B', script: 'echo b', params: [], createdAt: 2 }
      ]
      saveRecipes('ws1', recipes)
      expect(loadRecipes('ws1')).toHaveLength(2)
    })

    it('removes key when saving empty array', () => {
      saveRecipes('ws1', [{ id: 'r1', name: 'A', script: 'x', params: [], createdAt: 1 }])
      expect(store[recipeStorageKey('ws1')]).toBeTruthy()
      saveRecipes('ws1', [])
      expect(store[recipeStorageKey('ws1')]).toBeUndefined()
    })

    it('handles corrupted localStorage gracefully', () => {
      store[recipeStorageKey('ws1')] = '{not valid json'
      expect(loadRecipes('ws1')).toEqual([])
    })

    it('isolates different workspace recipes', () => {
      saveRecipes('ws1', [{ id: 'r1', name: 'A', script: 'a', params: [], createdAt: 1 }])
      saveRecipes('ws2', [{ id: 'r2', name: 'B', script: 'b', params: [], createdAt: 2 }])
      expect(loadRecipes('ws1')[0].id).toBe('r1')
      expect(loadRecipes('ws2')[0].id).toBe('r2')
    })
  })

  describe('substituteParams', () => {
    it('replaces single param', () => {
      expect(substituteParams('echo {{name}}', [{ key: 'name', value: 'world' }])).toBe('echo world')
    })

    it('replaces multiple params', () => {
      const params: RecipeParam[] = [
        { key: 'host', value: 'localhost' },
        { key: 'port', value: '3000' }
      ]
      expect(substituteParams('curl {{host}}:{{port}}', params)).toBe('curl localhost:3000')
    })

    it('replaces repeated occurrences', () => {
      expect(substituteParams('{{x}} and {{x}}', [{ key: 'x', value: 'y' }])).toBe('y and y')
    })

    it('leaves unmatched placeholders intact', () => {
      expect(substituteParams('{{missing}}', [])).toBe('{{missing}}')
    })

    it('handles empty script', () => {
      expect(substituteParams('', [{ key: 'a', value: 'b' }])).toBe('')
    })

    it('handles empty params', () => {
      expect(substituteParams('hello', [])).toBe('hello')
    })

    it('handles params with empty values', () => {
      expect(substituteParams('--flag={{val}}', [{ key: 'val', value: '' }])).toBe('--flag=')
    })

    it('handles special regex characters in values', () => {
      expect(substituteParams('{{path}}', [{ key: 'path', value: '/tmp/$HOME/*' }])).toBe('/tmp/$HOME/*')
    })
  })

  describe('createEmptyRecipe', () => {
    it('returns a recipe with all fields', () => {
      const r = createEmptyRecipe()
      expect(r.id).toBeTruthy()
      expect(r.name).toBe('New Recipe')
      expect(r.script).toBe('')
      expect(r.params).toEqual([])
      expect(r.createdAt).toBeGreaterThan(0)
    })

    it('generates unique ids', () => {
      const a = createEmptyRecipe()
      const b = createEmptyRecipe()
      expect(a.id).not.toBe(b.id)
    })
  })

  describe('generateId', () => {
    it('returns string starting with recipe-', () => {
      expect(generateId()).toMatch(/^recipe-/)
    })

    it('returns unique values', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateId()))
      expect(ids.size).toBe(100)
    })
  })
})
