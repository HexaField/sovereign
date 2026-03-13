export type Theme = 'default' | 'light' | 'ironman' | 'jarvis'

export const themes: Record<Theme, { label: string; description: string }> = {
  default: { label: 'Dark', description: 'Default dark theme' },
  light: { label: 'Light', description: 'Light theme' },
  ironman: { label: 'Iron Man', description: 'Blue HUD with Orbitron font' },
  jarvis: { label: 'JARVIS', description: 'Orange HUD with Orbitron font' }
}
