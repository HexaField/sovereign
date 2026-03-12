import { describe, it, expect, beforeEach } from 'vitest'
import { registerPanel, getPanel, getPanels, clearPanels } from './panels.js'
import type { PanelDefinition } from './types.js'

describe('panels', () => {
  beforeEach(() => {
    clearPanels()
  })

  it('should register and retrieve a panel', () => {
    const panel: PanelDefinition = {
      id: 'test',
      title: 'Test',
      icon: '🧪',
      component: () => null,
      position: 'sidebar'
    }
    registerPanel(panel)
    expect(getPanel('test')).toEqual(panel)
  })

  it('should filter panels by position', () => {
    registerPanel({ id: 'a', title: 'A', icon: '', component: () => null, position: 'sidebar' })
    registerPanel({ id: 'b', title: 'B', icon: '', component: () => null, position: 'bottom' })
    registerPanel({ id: 'c', title: 'C', icon: '', component: () => null, position: 'sidebar' })

    expect(getPanels('sidebar').length).toBe(2)
    expect(getPanels('bottom').length).toBe(1)
    expect(getPanels().length).toBe(3)
  })

  it('should return undefined for unknown panel', () => {
    expect(getPanel('nope')).toBeUndefined()
  })
})
