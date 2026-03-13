import { createSignal, For, Show } from 'solid-js'
import type { JSX } from 'solid-js'
import type { ViewMode } from './store.js'

export const VIEW_MODES: ViewMode[] = ['chat', 'voice', 'dashboard', 'recording']

export function getViewModeIcon(mode: ViewMode): string {
  switch (mode) {
    case 'chat':
      return '💬'
    case 'voice':
      return '🎤'
    case 'dashboard':
      return '📊'
    case 'recording':
      return '🎙'
    default:
      return ''
  }
}

export function getViewModeLabel(mode: ViewMode): string {
  switch (mode) {
    case 'chat':
      return 'Chat'
    case 'voice':
      return 'Voice'
    case 'dashboard':
      return 'Dashboard'
    case 'recording':
      return 'Recordings'
    default:
      return ''
  }
}

export interface HeaderProps {
  drawerOpen: () => boolean
  setDrawerOpen: (v: boolean) => void
  viewMode: () => ViewMode
  setViewMode: (m: ViewMode) => void
  threadName: () => string
  connectionBadge?: () => JSX.Element
  subagentCount?: () => number
  setSettingsOpen: (v: boolean) => void
  entities?: () => { entityType: 'branch' | 'issue' | 'pr'; entityRef: string }[]
}

export function Header(props: HeaderProps) {
  const [entityDropdown, setEntityDropdown] = createSignal(false)

  return (
    <header
      class="fixed top-0 right-0 left-0 z-40 flex h-12 items-center gap-2 px-3"
      style={{
        background: 'var(--c-bg-raised)',
        'border-bottom': '1px solid var(--c-border)',
        'padding-top': 'env(safe-area-inset-top, 0px)'
      }}
    >
      <button
        class="p-1 text-lg"
        style={{ color: 'var(--c-text)' }}
        onClick={() => props.setDrawerOpen(!props.drawerOpen())}
      >
        ☰
      </button>

      <Show when={props.connectionBadge}>{props.connectionBadge!()}</Show>

      <div class="flex min-w-0 flex-1 items-center gap-1">
        <span class="truncate text-sm font-medium" style={{ color: 'var(--c-text)' }}>
          {props.threadName()}
        </span>
        <Show when={props.entities && props.entities()!.length > 1}>
          <button
            class="text-xs"
            style={{ color: 'var(--c-accent)' }}
            onClick={() => setEntityDropdown(!entityDropdown())}
          >
            +{props.entities!().length - 1}
          </button>
          <Show when={entityDropdown()}>
            <div
              class="absolute top-12 left-16 z-50 rounded p-2 shadow-lg"
              style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)' }}
            >
              <For each={props.entities!()}>
                {(e) => (
                  <div class="py-1 text-xs" style={{ color: 'var(--c-text)' }}>
                    {e.entityRef}
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>

      <Show when={props.subagentCount && props.subagentCount()! > 0}>
        <span
          class="rounded-full px-1.5 py-0.5 text-xs"
          style={{ background: 'var(--c-accent)', color: 'var(--c-bg)' }}
        >
          {props.subagentCount!()}
        </span>
      </Show>

      <div class="flex items-center gap-1">
        <For each={VIEW_MODES}>
          {(mode) => (
            <button
              class="rounded px-2 py-1 text-sm"
              style={{
                color: props.viewMode() === mode ? 'var(--c-accent)' : 'var(--c-text-muted)',
                'border-bottom': props.viewMode() === mode ? '2px solid var(--c-accent)' : '2px solid transparent'
              }}
              onClick={() => props.setViewMode(mode)}
              title={getViewModeLabel(mode)}
            >
              {getViewModeIcon(mode)}
            </button>
          )}
        </For>
      </div>

      <button class="p-1 text-lg" style={{ color: 'var(--c-text-muted)' }} onClick={() => props.setSettingsOpen(true)}>
        ⚙
      </button>
    </header>
  )
}
