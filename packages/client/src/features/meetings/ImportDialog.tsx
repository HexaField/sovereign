// Import dialog — §8.9.1
import { createSignal } from 'solid-js'

export interface ImportDialogProps {
  open: boolean
  onClose: () => void
  onSubmit: (data: ImportFormData) => void
}

export interface ImportFormData {
  title: string
  threadKey: string
  platform: string
  startedAt: string
  tags: string[]
  audioFile: File | null
  transcriptFile: File | null
}

export function createImportForm(): ImportFormData {
  return {
    title: '',
    threadKey: '',
    platform: '',
    startedAt: '',
    tags: [],
    audioFile: null,
    transcriptFile: null
  }
}

export function validateImportForm(data: ImportFormData): string | null {
  if (!data.title.trim()) return 'Title is required'
  if (!data.audioFile && !data.transcriptFile) return 'Audio or transcript file is required'
  return null
}

export function ImportDialog(props: ImportDialogProps) {
  const [form, setForm] = createSignal(createImportForm())
  const [error, setError] = createSignal<string | null>(null)

  const submit = () => {
    const err = validateImportForm(form())
    if (err) {
      setError(err)
      return
    }
    props.onSubmit(form())
    setForm(createImportForm())
    setError(null)
    props.onClose()
  }

  if (!props.open) return null

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => props.onClose()}>
      <div
        class="w-full max-w-md rounded-lg border p-5"
        style={{ background: 'var(--c-bg)', 'border-color': 'var(--c-border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 class="mb-4 text-lg font-semibold" style={{ color: 'var(--c-text-heading)' }}>
          Import Meeting
        </h2>

        {error() && (
          <p class="mb-3 text-sm" style={{ color: 'var(--c-danger, #ef4444)' }}>
            {error()}
          </p>
        )}

        <div class="flex flex-col gap-3">
          <input
            type="text"
            placeholder="Meeting title"
            class="rounded border px-2 py-1.5 text-sm"
            style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
            value={form().title}
            onInput={(e) => setForm((f) => ({ ...f, title: e.currentTarget.value }))}
          />
          <input
            type="text"
            placeholder="Thread key (optional)"
            class="rounded border px-2 py-1.5 text-sm"
            style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
            value={form().threadKey}
            onInput={(e) => setForm((f) => ({ ...f, threadKey: e.currentTarget.value }))}
          />
          <input
            type="text"
            placeholder="Platform (e.g., Zoom, Teams)"
            class="rounded border px-2 py-1.5 text-sm"
            style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
            value={form().platform}
            onInput={(e) => setForm((f) => ({ ...f, platform: e.currentTarget.value }))}
          />
          <input
            type="datetime-local"
            class="rounded border px-2 py-1.5 text-sm"
            style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
            value={form().startedAt}
            onInput={(e) => setForm((f) => ({ ...f, startedAt: e.currentTarget.value }))}
          />
          <input
            type="text"
            placeholder="Tags (comma-separated)"
            class="rounded border px-2 py-1.5 text-sm"
            style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
            onInput={(e) =>
              setForm((f) => ({
                ...f,
                tags: e.currentTarget.value
                  .split(',')
                  .map((t) => t.trim())
                  .filter(Boolean)
              }))
            }
          />

          <label class="text-xs font-medium" style={{ color: 'var(--c-text-muted)' }}>
            Audio file
            <input
              type="file"
              accept="audio/*"
              class="mt-1 block w-full text-sm"
              onChange={(e) => setForm((f) => ({ ...f, audioFile: e.currentTarget.files?.[0] ?? null }))}
            />
          </label>
          <label class="text-xs font-medium" style={{ color: 'var(--c-text-muted)' }}>
            Transcript file
            <input
              type="file"
              accept=".txt,.srt,.vtt,.json"
              class="mt-1 block w-full text-sm"
              onChange={(e) => setForm((f) => ({ ...f, transcriptFile: e.currentTarget.files?.[0] ?? null }))}
            />
          </label>
        </div>

        <div class="mt-4 flex justify-end gap-2">
          <button
            class="rounded px-3 py-1.5 text-sm"
            style={{ color: 'var(--c-text-muted)' }}
            onClick={() => props.onClose()}
          >
            Cancel
          </button>
          <button
            class="rounded px-3 py-1.5 text-sm font-medium"
            style={{ background: 'var(--c-accent)', color: 'white' }}
            onClick={submit}
          >
            Import
          </button>
        </div>
      </div>
    </div>
  )
}
