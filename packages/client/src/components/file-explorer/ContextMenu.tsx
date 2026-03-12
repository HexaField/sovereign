import { type Component, Show, For } from 'solid-js'
import type { ContextMenuAction } from './types.js'

interface ContextMenuProps {
  x: number
  y: number
  actions: ContextMenuAction[]
  onClose: () => void
}

const ContextMenu: Component<ContextMenuProps> = (props) => {
  return (
    <div
      class="fixed z-50 min-w-[160px] rounded border border-zinc-700 bg-zinc-800 py-1 shadow-xl"
      style={{ left: `${props.x}px`, top: `${props.y}px` }}
    >
      <For each={props.actions}>
        {(item) => (
          <button
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-700"
            onClick={() => {
              item.action()
              props.onClose()
            }}
          >
            <Show when={item.icon}>
              <span>{item.icon}</span>
            </Show>
            {item.label}
          </button>
        )}
      </For>
    </div>
  )
}

export default ContextMenu
