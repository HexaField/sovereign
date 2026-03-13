import { describe, it } from 'vitest'

describe('ViewMenu', () => {
  describe('§1.1 — View Menu Dropdown', () => {
    it.todo('§1.1 — renders a button showing current view label + icon')
    it.todo('§1.1 — opens dropdown menu on click')
    it.todo('§1.1 — dropdown lists all 5 views: dashboard, workspace, canvas, planning, system')
    it.todo('§1.1 — each item shows icon, label, and keyboard shortcut hint')
    it.todo('§1.1 — active view shows check mark or accent highlight')
    it.todo('§1.1 — dropdown uses var(--c-menu-bg) background with var(--c-border) border')
    it.todo('§1.1 — clicking an item switches views and closes the dropdown')
    it.todo('§1.1 — clicking outside closes the dropdown')
    it.todo('§1.1 — persists current view to localStorage under key sovereign:active-view')
    it.todo('§1.1 — restores last active view on init')
    it.todo('§1.1 — defaults to dashboard if no view previously selected')
  })

  describe('§8 — Keyboard Shortcuts', () => {
    it.todo('§8 — Cmd+1 switches to Dashboard')
    it.todo('§8 — Cmd+2 switches to Workspace')
    it.todo('§8 — Cmd+3 switches to Canvas')
    it.todo('§8 — Cmd+4 switches to Planning')
    it.todo('§8 — Cmd+5 switches to System')
  })
})
