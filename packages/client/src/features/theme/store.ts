import { createSignal } from 'solid-js'
import type { Accessor } from 'solid-js'
import type { Theme } from './themes.js'

export const [currentTheme, _setTheme] = createSignal<Theme>('default')

export function setTheme(_theme: Theme): void {
  throw new Error('not implemented')
}

export { currentTheme as theme }
