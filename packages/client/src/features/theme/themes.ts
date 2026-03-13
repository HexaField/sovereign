export type Theme = 'default' | 'light' | 'ironman' | 'jarvis'

export interface ThemeMeta {
  label: string
  description: string
}

export const themes: Record<Theme, ThemeMeta> = {
  default: { label: 'Dark', description: 'Default dark theme' },
  light: { label: 'Light', description: 'Light theme' },
  ironman: { label: 'Iron Man', description: 'Blue HUD with Orbitron font' },
  jarvis: { label: 'JARVIS', description: 'Orange HUD with Orbitron font' }
}

export const themeList: Theme[] = ['default', 'light', 'ironman', 'jarvis']
