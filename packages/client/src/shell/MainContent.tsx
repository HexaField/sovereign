import { type Component, Show } from 'solid-js'
import { shellState } from './shell-store.js'
import TabBar from './TabBar.js'

const MainContent: Component = () => {
  const activeTab = () => shellState.tabs.find((t) => t.id === shellState.activeTabId)

  return (
    <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <Show when={shellState.tabs.length > 0}>
        <TabBar />
      </Show>
      <div class="flex-1 overflow-auto">
        <Show
          when={activeTab()}
          fallback={
            <div class="flex h-full items-center justify-center text-zinc-500">
              <div class="text-center">
                <p class="text-lg">No file open</p>
                <p class="mt-1 text-sm">Open a file from the explorer or use Cmd+P</p>
              </div>
            </div>
          }
        >
          {(tab) => {
            const Comp = tab().component
            return <Comp {...(tab().data ?? {})} />
          }}
        </Show>
      </div>
    </div>
  )
}

export default MainContent
