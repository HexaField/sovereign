import { createSignal } from 'solid-js'
import type { Accessor } from 'solid-js'
import type { Theme } from './themes.js'

const STORAGE_KEY = 'sovereign:theme'
const VALID_THEMES: Theme[] = ['default', 'light', 'ironman', 'jarvis']

function isValidTheme(value: unknown): value is Theme {
  return typeof value === 'string' && VALID_THEMES.includes(value as Theme)
}

function loadTheme(): Theme {
  if (typeof localStorage === 'undefined') return 'default'
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored && isValidTheme(stored)) return stored
  // Default to dark theme — Sovereign is dark-first (like voice-ui)
  return 'default'
}

function applyThemeClass(theme: Theme): void {
  if (typeof document === 'undefined') return
  const el = document.documentElement
  el.classList.remove('light', 'ironman', 'jarvis')
  if (theme !== 'default') {
    el.classList.add(theme)
  }
}

const [_currentTheme, _setTheme] = createSignal<Theme>(loadTheme())

// Apply on init
applyThemeClass(_currentTheme())

export const currentTheme: Accessor<Theme> = _currentTheme

export function setTheme(theme: Theme): void {
  if (!isValidTheme(theme)) return
  _setTheme(theme)
  applyThemeClass(theme)
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, theme)
  }
}
