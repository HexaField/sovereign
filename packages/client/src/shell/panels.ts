import type { PanelDefinition } from './types.js'

const panels: Map<string, PanelDefinition> = new Map()

export function registerPanel(def: PanelDefinition): void {
  panels.set(def.id, def)
}

export function getPanel(id: string): PanelDefinition | undefined {
  return panels.get(id)
}

export function getPanels(position?: PanelDefinition['position']): PanelDefinition[] {
  const all = Array.from(panels.values())
  if (!position) return all
  return all.filter((p) => p.position === position)
}

export function clearPanels(): void {
  panels.clear()
}
