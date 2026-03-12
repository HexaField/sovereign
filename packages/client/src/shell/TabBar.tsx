import { type Component, For, Show } from 'solid-js'
import { shellState, setActiveTab, closeTab, pinTab } from './shell-store.js'

const TabBar: Component = () => {
  return (
    <div class="flex items-center overflow-x-auto border-b border-zinc-700 bg-zinc-900">
      <For each={shellState.tabs}>
        {(tab) => (
          <div
            class={`group flex cursor-pointer items-center gap-1.5 border-r border-zinc-700 px-3 py-1.5 text-xs select-none ${
              shellState.activeTabId === tab.id
                ? "bg-zinc-800 text-white"
                : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
            }`}
            onClick={() => setActiveTab(tab.id)}
            onDblClick={() => pinTab(tab.id)}
          >
            <Show when={tab.icon}>
              <span>{tab.icon}</span>
            </Show>
            <span class={tab.pinned ? 'italic' : ''}>{tab.title}</span>
            <Show when={tab.closable && !tab.pinned}>
              <button
                class="ml-1 hidden rounded p-0.5 text-zinc-500 group-hover:inline-block hover:bg-zinc-600 hover:text-white"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab.id)
                }}
              >
                ×
              </button>
            </Show>
          </div>
        )}
      </For>
    </div>
  )
}

export default TabBar
