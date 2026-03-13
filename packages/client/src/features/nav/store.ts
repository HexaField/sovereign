import { createSignal } from 'solid-js'

export type ViewMode = 'chat' | 'voice' | 'dashboard' | 'recording'

export const [viewMode, _setViewMode] = createSignal<ViewMode>('chat')
export const [drawerOpen, _setDrawerOpen] = createSignal(false)
export const [settingsOpen, _setSettingsOpen] = createSignal(false)

export function setViewMode(_mode: ViewMode): void {
  throw new Error('not implemented')
}

export function setDrawerOpen(_open: boolean): void {
  throw new Error('not implemented')
}

export function setSettingsOpen(_open: boolean): void {
  throw new Error('not implemented')
}
