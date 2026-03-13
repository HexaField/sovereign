import { describe, it } from 'vitest'

describe('§1.4 Theme Store', () => {
  it.todo('MUST expose currentTheme: Accessor<Theme> and setTheme(theme): void')
  it.todo('MUST persist selected theme to localStorage key sovereign:theme')
  it.todo('MUST restore theme from localStorage on load')
  it.todo('MUST apply selected theme by setting CSS class on document.documentElement')
  it.todo('SHOULD support prefers-color-scheme media query for automatic dark/light selection')
  it.todo('Theme type MUST be: default | light | ironman | jarvis')
})
