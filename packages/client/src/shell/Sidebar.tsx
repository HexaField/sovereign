import { type Component, For, Show } from 'solid-js'
import { shellState, toggleSidebar } from './shell-store.js'
import { getPanels } from './panels.js'
import { ChevronLeftIcon } from '../ui/icons.js'

const Sidebar: Component = () => {
  const sidebarPanels = () => getPanels('sidebar')

  return (
    <Show when={!shellState.sidebarCollapsed}>
      <div
        class="flex flex-col overflow-hidden border-r border-zinc-700 bg-zinc-900"
        style={{ width: `${shellState.sidebarWidth}px` }}
      >
        {/* Sidebar header */}
        <div class="flex items-center justify-between border-b border-zinc-700 px-3 py-2">
          <span class="text-xs font-semibold tracking-wide text-zinc-400 uppercase">Explorer</span>
          <button class="text-zinc-500 hover:text-zinc-300" onClick={toggleSidebar} title="Collapse sidebar">
            <ChevronLeftIcon class="h-4 w-4" />
          </button>
        </div>

        {/* Panel list */}
        <div class="flex-1 overflow-y-auto">
          <For each={sidebarPanels()}>
            {(panel) => {
              const Comp = panel.component
              return (
                <div class="border-b border-zinc-800">
                  <div class="px-3 py-1.5 text-xs font-semibold text-zinc-500 uppercase">
                    {panel.icon} {panel.title}
                  </div>
                  <Comp />
                </div>
              )
            }}
          </For>
        </div>
      </div>
    </Show>
  )
}

export default Sidebar
