import { createSignal, For, Show } from 'solid-js'
import type { ThreadInfo } from './store.js'
import { filterThreads } from './ThreadDrawer.js'
import { getThreadDisplayName, getEntityIcon } from './helpers.js'

export function truncatePreview(text: string, lines: number = 3): string {
  const split = text.split('\n')
  if (split.length <= lines) return text
  return split.slice(0, lines).join('\n') + '…'
}

export function filterAvailableThreads(threads: ThreadInfo[], currentKey: string, query: string): ThreadInfo[] {
  const available = threads.filter((t) => t.key !== currentKey)
  return filterThreads(available, query)
}

export interface ForwardDialogProps {
  open: () => boolean
  onClose: () => void
  threads: () => ThreadInfo[]
  currentThreadKey: () => string
  messageContent: () => string
  messageAuthor: () => string
  messageTimestamp: () => number
  onForward: (targetKey: string, note: string) => void
}

export function ForwardDialog(props: ForwardDialogProps) {
  const [search, setSearch] = createSignal('')
  const [note, setNote] = createSignal('')
  const [selectedKey, setSelectedKey] = createSignal<string | null>(null)

  const available = () => filterAvailableThreads(props.threads(), props.currentThreadKey(), search())

  const handleForward = () => {
    const key = selectedKey()
    if (!key) return
    props.onForward(key, note())
    props.onClose()
  }

  return (
    <Show when={props.open()}>
      <div
        class="fixed inset-0 z-50 flex items-center justify-center"
        style={{ background: 'rgba(0,0,0,0.5)' }}
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') props.onClose()
        }}
      >
        <div
          class="flex max-h-[80vh] w-96 flex-col rounded-lg shadow-xl"
          style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)' }}
        >
          <div class="flex items-center justify-between border-b p-4" style={{ 'border-color': 'var(--c-border)' }}>
            <h2 class="text-sm font-semibold" style={{ color: 'var(--c-text)' }}>
              Forward Message
            </h2>
            <button onClick={props.onClose} style={{ color: 'var(--c-text-muted)' }}>
              ✕
            </button>
          </div>

          <div class="border-b p-4" style={{ 'border-color': 'var(--c-border)' }}>
            <div class="mb-1 text-xs" style={{ color: 'var(--c-text-muted)' }}>
              Preview
            </div>
            <div class="text-sm whitespace-pre-wrap" style={{ color: 'var(--c-text)' }}>
              {truncatePreview(props.messageContent(), 3)}
            </div>
          </div>

          <div class="p-4">
            <input
              type="text"
              placeholder="Search threads…"
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
              class="mb-2 w-full rounded px-3 py-2 text-sm"
              style={{ background: 'var(--c-bg)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
            />
            <div class="max-h-40 overflow-y-auto">
              <For each={available()}>
                {(thread) => (
                  <div
                    class="flex cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm"
                    style={{
                      background: selectedKey() === thread.key ? 'var(--c-bg-active)' : 'transparent',
                      color: 'var(--c-text)'
                    }}
                    onClick={() => setSelectedKey(thread.key)}
                  >
                    <Show when={thread.entities?.length > 0}>
                      <span>{getEntityIcon(thread.entities[0].entityType)}</span>
                    </Show>
                    {getThreadDisplayName(thread)}
                  </div>
                )}
              </For>
            </div>
          </div>

          <div class="px-4 pb-4">
            <input
              type="text"
              placeholder="Add a note…"
              value={note()}
              onInput={(e) => setNote(e.currentTarget.value)}
              class="w-full rounded px-3 py-2 text-sm"
              style={{ background: 'var(--c-bg)', color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
            />
          </div>

          <div class="flex justify-end border-t p-4" style={{ 'border-color': 'var(--c-border)' }}>
            <button
              class="rounded px-4 py-2 text-sm font-medium"
              style={{ background: 'var(--c-accent)', color: 'var(--c-bg)', opacity: selectedKey() ? '1' : '0.5' }}
              disabled={!selectedKey()}
              onClick={handleForward}
            >
              Forward
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
