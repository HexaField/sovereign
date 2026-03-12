import { type Component, createSignal, onMount, onCleanup, For, Show } from 'solid-js'
import { searchCommands } from './commands.js'

const CommandPalette: Component = () => {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [selected, setSelected] = createSignal(0)
  let inputRef: HTMLInputElement | undefined

  const results = () => searchCommands(query())

  const handleKeyDown = (e: KeyboardEvent) => {
    // Cmd+P or Ctrl+P to toggle
    if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
      e.preventDefault()
      setOpen((o) => !o)
      if (!open()) {
        setQuery('')
        setSelected(0)
      }
    }

    if (!open()) return

    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.min(s + 1, results().length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const r = results()
      if (r[selected()]) {
        r[selected()].action()
        setOpen(false)
      }
    }
  }

  onMount(() => {
    document.addEventListener('keydown', handleKeyDown)
  })

  onCleanup(() => {
    document.removeEventListener('keydown', handleKeyDown)
  })

  return (
    <Show when={open()}>
      <div class="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]" onClick={() => setOpen(false)}>
        <div
          class="w-full max-w-lg rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            ref={inputRef}
            type="text"
            class="w-full border-b border-zinc-700 bg-transparent px-4 py-3 text-sm text-white outline-none placeholder:text-zinc-500"
            placeholder="Type a command..."
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value)
              setSelected(0)
            }}
            autofocus
          />
          <div class="max-h-64 overflow-y-auto py-1">
            <For each={results()}>
              {(cmd, i) => (
                <div
                  class={`flex cursor-pointer items-center justify-between px-4 py-2 text-sm ${
                    selected() === i() ? "bg-zinc-700 text-white" : "text-zinc-300 hover:bg-zinc-800"
                  }`}
                  onClick={() => {
                    cmd.action()
                    setOpen(false)
                  }}
                  onMouseEnter={() => setSelected(i())}
                >
                  <div>
                    <Show when={cmd.category}>
                      <span class="mr-2 text-xs text-zinc-500">{cmd.category}</span>
                    </Show>
                    <span>{cmd.label}</span>
                  </div>
                  <Show when={cmd.shortcut}>
                    <span class="text-xs text-zinc-500">{cmd.shortcut}</span>
                  </Show>
                </div>
              )}
            </For>
            <Show when={results().length === 0 && query()}>
              <div class="px-4 py-2 text-sm text-zinc-500">No matching commands</div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  )
}

export default CommandPalette
