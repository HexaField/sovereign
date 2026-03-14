import { type Component, createSignal, For } from 'solid-js'
import type { TerminalTabInfo } from './types.js'
import Terminal from './Terminal.js'

const TerminalTabs: Component = () => {
  const [tabs, setTabs] = createSignal<TerminalTabInfo[]>([])
  const [activeTab, setActiveTab] = createSignal<string | null>(null)

  let nextId = 1

  const createTab = async () => {
    try {
      const res = await fetch('/api/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })
      if (!res.ok) return
      const session = await res.json()
      const tab: TerminalTabInfo = {
        id: `term-${nextId++}`,
        title: `Terminal ${tabs().length + 1}`,
        sessionId: session.id
      }
      setTabs((t) => [...t, tab])
      setActiveTab(tab.id)
    } catch {
      // ignore
    }
  }

  const closeTab = (tabId: string) => {
    setTabs((t) => t.filter((tab) => tab.id !== tabId))
    if (activeTab() === tabId) {
      const remaining = tabs()
      setActiveTab(remaining.length > 0 ? remaining[0].id : null)
    }
  }

  return (
    <div class="flex h-full flex-col">
      <div class="flex items-center border-b border-zinc-700 bg-zinc-900">
        <For each={tabs()}>
          {(tab) => (
            <div
              class={`flex cursor-pointer items-center gap-1 px-3 py-1 text-xs ${
                activeTab() === tab.id ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-800/50"
              }`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span>T</span>
              <span>{tab.title}</span>
              <button
                class="ml-1 text-zinc-500 hover:text-zinc-300"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab.id)
                }}
              >
                ×
              </button>
            </div>
          )}
        </For>
        <button class="px-2 py-1 text-xs text-zinc-500 hover:text-zinc-300" onClick={createTab} title="New terminal">
          +
        </button>
      </div>
      <div class="flex-1">
        <For each={tabs()}>
          {(tab) => (
            <div class="h-full" style={{ display: activeTab() === tab.id ? 'block' : 'none' }}>
              <Terminal sessionId={tab.sessionId} />
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

export default TerminalTabs
