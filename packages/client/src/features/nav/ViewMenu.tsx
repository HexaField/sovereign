import { createSignal, Show, onMount, onCleanup } from 'solid-js'
import type { JSX } from 'solid-js'
import { activeView, setActiveView, type NavView } from './store.js'
import { DashboardIcon, WorkspaceIcon, CanvasIcon, PlanningIcon, SystemIcon } from '../../ui/icons.js'

interface ViewItem {
  key: NavView
  icon: () => JSX.Element
  label: string
  shortcut: string
}

const VIEW_ITEMS: ViewItem[] = [
  { key: 'dashboard', icon: () => <DashboardIcon class="h-4 w-4" />, label: 'Dashboard', shortcut: '⌘1' },
  { key: 'workspace', icon: () => <WorkspaceIcon class="h-4 w-4" />, label: 'Workspace', shortcut: '⌘2' },
  { key: 'canvas', icon: () => <CanvasIcon class="h-4 w-4" />, label: 'Canvas', shortcut: '⌘3' },
  { key: 'planning', icon: () => <PlanningIcon class="h-4 w-4" />, label: 'Planning', shortcut: '⌘4' },
  { key: 'system', icon: () => <SystemIcon class="h-4 w-4" />, label: 'System', shortcut: '⌘5' }
]

export default function ViewMenu() {
  const [open, setOpen] = createSignal(false)

  const currentItem = () => VIEW_ITEMS.find((v) => v.key === activeView()) || VIEW_ITEMS[0]

  const select = (key: NavView) => {
    setActiveView(key)
    setOpen(false)
  }

  const handleKeydown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey) {
      const num = parseInt(e.key)
      if (num >= 1 && num <= 5) {
        e.preventDefault()
        select(VIEW_ITEMS[num - 1].key)
      }
    }
    if (e.key === 'Escape' && open()) setOpen(false)
  }

  onMount(() => {
    if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('keydown', handleKeydown)
    }
  })

  onCleanup(() => {
    if (typeof globalThis.removeEventListener === 'function') {
      globalThis.removeEventListener('keydown', handleKeydown)
    }
  })

  return (
    <div class="relative">
      <button
        class="flex cursor-pointer items-center gap-1.5 rounded-lg border bg-transparent px-3 py-1.5 text-sm transition-all"
        style={{
          'border-color': open() ? 'var(--c-accent)' : 'var(--c-border)',
          color: 'var(--c-text)'
        }}
        onClick={() => setOpen(!open())}
        data-testid="view-menu-trigger"
      >
        <span class="flex items-center">{currentItem().icon()}</span>
        <span>{currentItem().label}</span>
        <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
          ▾
        </span>
      </button>

      <Show when={open()}>
        <div class="fixed inset-0 z-[299]" onClick={() => setOpen(false)} />
        <div
          class="absolute top-full right-0 z-[300] mt-1 w-56 overflow-hidden rounded-lg shadow-lg"
          style={{
            background: 'var(--c-menu-bg)',
            border: '1px solid var(--c-border)'
          }}
          data-testid="view-menu-dropdown"
        >
          {VIEW_ITEMS.map((item) => (
            <button
              class="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors"
              style={{
                color: activeView() === item.key ? 'var(--c-accent)' : 'var(--c-text)',
                background: activeView() === item.key ? 'var(--c-hover-bg)' : 'transparent',
                border: 'none',
                cursor: 'pointer'
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = activeView() === item.key ? 'var(--c-hover-bg)' : '')
              }
              onClick={() => select(item.key)}
            >
              <span class="flex w-5 items-center justify-center">{item.icon()}</span>
              <span class="flex-1">{item.label}</span>
              <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                {item.shortcut}
              </span>
            </button>
          ))}
        </div>
      </Show>
    </div>
  )
}
