import { createSignal, For, Show } from 'solid-js'

export interface Recording {
  id: string
  blob: Blob
  timestamp: number
  duration: number
}

export function formatRecordingDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export function formatRecordingDate(ts: number): string {
  const d = new Date(ts)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const hours = d.getHours().toString().padStart(2, '0')
  const mins = d.getMinutes().toString().padStart(2, '0')
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${hours}:${mins}`
}

export function sortRecordings(recordings: Recording[]): Recording[] {
  return [...recordings].sort((a, b) => b.timestamp - a.timestamp)
}

export interface RecordingViewProps {
  recordings: () => Recording[]
  onDelete: (id: string) => void
  onExport: (recording: Recording) => void
}

export function RecordingView(props: RecordingViewProps) {
  const [playingId, setPlayingId] = createSignal<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = createSignal<string | null>(null)

  const sorted = () => sortRecordings(props.recordings())

  return (
    <div class="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
      <For each={sorted()}>
        {(rec) => (
          <div
            class="flex items-center gap-3 rounded p-3"
            style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)' }}
          >
            <div class="flex-1">
              <div class="text-sm" style={{ color: 'var(--c-text)' }}>
                {formatRecordingDate(rec.timestamp)}
              </div>
              <div class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                {formatRecordingDuration(rec.duration)}
              </div>
            </div>
            <button
              class="rounded px-2 py-1 text-sm"
              style={{ color: 'var(--c-accent)' }}
              onClick={() => setPlayingId(playingId() === rec.id ? null : rec.id)}
            >
              {playingId() === rec.id ? '⏸' : '▶'}
            </button>
            <Show when={playingId() === rec.id}>
              <button
                class="px-2 py-1 text-sm"
                style={{ color: 'var(--c-text-muted)' }}
                onClick={() => setPlayingId(null)}
              >
                ⏹
              </button>
            </Show>
            <button
              class="px-2 py-1 text-sm"
              style={{ color: 'var(--c-text-muted)' }}
              onClick={() => props.onExport(rec)}
            >
              💾
            </button>
            <Show
              when={confirmDeleteId() === rec.id}
              fallback={
                <button
                  class="px-2 py-1 text-sm"
                  style={{ color: 'var(--c-danger, #ef4444)' }}
                  onClick={() => setConfirmDeleteId(rec.id)}
                >
                  🗑
                </button>
              }
            >
              <button
                class="rounded px-2 py-1 text-xs"
                style={{ background: 'var(--c-danger, #ef4444)', color: 'white' }}
                onClick={() => {
                  props.onDelete(rec.id)
                  setConfirmDeleteId(null)
                }}
              >
                Confirm
              </button>
              <button
                class="px-2 py-1 text-xs"
                style={{ color: 'var(--c-text-muted)' }}
                onClick={() => setConfirmDeleteId(null)}
              >
                Cancel
              </button>
            </Show>
          </div>
        )}
      </For>
    </div>
  )
}
