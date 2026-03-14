import { type Component, Show, For } from 'solid-js'
import { shellState, setBottomHeight, toggleBottomPanel } from './shell-store.js'
import { getPanels } from './panels.js'
import Divider from './Divider.js'
import { CloseIcon } from '../ui/icons.js'

const BottomPanel: Component = () => {
  const bottomPanels = () => getPanels('bottom')

  return (
    <Show when={shellState.bottomVisible}>
      <Divider direction="vertical" onResize={(delta) => setBottomHeight(shellState.bottomHeight - delta)} />
      <div
        class="flex flex-col overflow-hidden border-t border-zinc-700 bg-zinc-900"
        style={{ height: `${shellState.bottomHeight}px` }}
      >
        {/* Bottom panel header */}
        <div class="flex items-center justify-between border-b border-zinc-700 px-3 py-1">
          <div class="flex items-center gap-2 text-xs text-zinc-400">
            <For each={bottomPanels()}>
              {(panel) => (
                <span class="cursor-pointer rounded px-2 py-0.5 hover:bg-zinc-700">
                  {panel.icon} {panel.title}
                </span>
              )}
            </For>
          </div>
          <button class="text-zinc-500 hover:text-zinc-300" onClick={toggleBottomPanel} title="Close panel">
            <CloseIcon class="h-4 w-4" />
          </button>
        </div>

        {/* Panel content */}
        <div class="flex-1 overflow-auto">
          <For each={bottomPanels()}>
            {(panel) => {
              const Comp = panel.component
              return <Comp />
            }}
          </For>
        </div>
      </div>
    </Show>
  )
}

export default BottomPanel
