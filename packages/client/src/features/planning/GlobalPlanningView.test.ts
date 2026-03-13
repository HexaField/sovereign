import { describe, it } from 'vitest'

describe('GlobalPlanningView', () => {
  describe('§5.1 — Layout', () => {
    it.todo('§5.1 — renders full-viewport planning surface with toolbar at top')
    it.todo('§5.1 — toolbar contains view mode selector (DAG/kanban/list/tree), filter controls, search')
  })

  describe('§5.2 — Multi-Workspace Graph', () => {
    it.todo('§5.2 — fetches planning graphs for all orgs')
    it.todo('§5.2 — nodes color-coded by workspace')
    it.todo('§5.2 — edges show dependencies including cross-workspace edges (visually distinct)')
    it.todo('§5.2 — critical path highlighted with bold edges and brighter nodes')
    it.todo('§5.2 — blocked nodes red, ready nodes green, in-progress amber')
  })

  describe('§5.3 — View Modes', () => {
    it.todo('§5.3 — DAG mode: directed graph layout with pan and zoom')
    it.todo('§5.3 — Kanban mode: columns by status, cards grouped by workspace')
    it.todo('§5.3 — List mode: sortable table with title, workspace, project, status, assignee, priority, dependencies')
    it.todo('§5.3 — Tree mode: hierarchical tree with expand/collapse')
  })

  describe('§5.4 — Actions', () => {
    it.todo('§5.4 — clicking node/card/row opens issue/PR detail in Workspace view')
    it.todo('§5.4 — toolbar has "Assign to Agent" button opening dialog')
    it.todo('§5.4 — toolbar has "Create Issue" button with workspace/project selector')
  })

  describe('§5.5 — Filters', () => {
    it.todo('§5.5 — filter by workspace, project, status, assignee, label, priority')
    it.todo('§5.5 — filters shown as removable pills/chips')
    it.todo('§5.5 — filter state persists to localStorage')
    it.todo('§5.5 — text search filters nodes by title/body content')
  })

  describe('§7.5 — Mobile Planning', () => {
    it.todo('§7.5 — defaults to List view on mobile')
    it.todo('§7.5 — Kanban scrolls horizontally on mobile')
  })
})
