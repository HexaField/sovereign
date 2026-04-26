import { createSignal, createEffect, on, onCleanup, Show, For, type Component } from 'solid-js'
import { activeWorkspace } from '../store.js'

// ── Types ────────────────────────────────────────────────────────────

interface RecordingMeta {
  id: string
  orgId: string
  meetingId?: string
  name: string
  duration: number
  sizeBytes: number
  mimeType: string
  createdAt: string
  updatedAt: string
  threadKey?: string
  transcriptStatus: 'none' | 'pending' | 'processing' | 'completed' | 'failed'
  transcriptionProgress?: number
  tags?: string[]
  transcript?: string
}

// Legacy export for test compatibility
export interface RecordingItem {
  id: string
  timestamp: number
  duration: number
  transcriptPreview: string
  threadKey?: string
}

// ── Helpers ──────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000)
  const mins = Math.floor(secs / 60)
  const rem = secs % 60
  return `${mins}:${rem.toString().padStart(2, '0')}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function transcriptBadge(status: RecordingMeta['transcriptStatus']): { label: string; color: string } {
  switch (status) {
    case 'completed':
      return { label: 'Transcribed', color: 'var(--c-success)' }
    case 'processing':
      return { label: 'Processing…', color: 'var(--c-warning, #f59e0b)' }
    case 'pending':
      return { label: 'Pending', color: 'var(--c-warning, #f59e0b)' }
    case 'failed':
      return { label: 'Failed', color: 'var(--c-error)' }
    default:
      return { label: 'No transcript', color: 'var(--c-text-muted)' }
  }
}

// ── API helpers ──────────────────────────────────────────────────────

function apiBase(orgId: string): string {
  return `/api/orgs/${encodeURIComponent(orgId)}/recordings`
}

async function fetchRecordings(orgId: string): Promise<RecordingMeta[]> {
  const res = await fetch(apiBase(orgId))
  if (!res.ok) throw new Error(`Failed to fetch recordings: ${res.status}`)
  const data = await res.json()
  return Array.isArray(data) ? data : (data.recordings ?? [])
}

async function uploadRecording(orgId: string, file: File): Promise<RecordingMeta> {
  const form = new FormData()
  form.append('audio', file)
  const res = await fetch(apiBase(orgId), { method: 'POST', body: form })
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
  return res.json()
}

async function deleteRecording(orgId: string, id: string): Promise<void> {
  const res = await fetch(`${apiBase(orgId)}/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`Delete failed: ${res.status}`)
}

async function startTranscription(orgId: string, id: string): Promise<void> {
  const res = await fetch(`${apiBase(orgId)}/${encodeURIComponent(id)}/transcribe`, { method: 'POST' })
  if (!res.ok) throw new Error(`Transcription request failed: ${res.status}`)
}

async function fetchTranscript(orgId: string, id: string): Promise<string> {
  const res = await fetch(`${apiBase(orgId)}/${encodeURIComponent(id)}/transcript`)
  if (!res.ok) throw new Error(`Transcript fetch failed: ${res.status}`)
  return res.text()
}

async function searchRecordings(orgId: string, query: string): Promise<RecordingMeta[]> {
  const res = await fetch(`${apiBase(orgId)}/search?q=${encodeURIComponent(query)}`)
  if (!res.ok) throw new Error(`Search failed: ${res.status}`)
  const data = await res.json()
  return Array.isArray(data) ? data : (data.recordings ?? [])
}

// ── Component ────────────────────────────────────────────────────────

const RecordingsPanel: Component = () => {
  const ws = () => activeWorkspace()

  const [recordings, setRecordings] = createSignal<RecordingMeta[]>([])
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [search, setSearch] = createSignal('')
  const [selectedId, setSelectedId] = createSignal<string | null>(null)
  const [expandedTranscriptId, setExpandedTranscriptId] = createSignal<string | null>(null)
  const [transcriptText, setTranscriptText] = createSignal<string | null>(null)
  const [transcriptLoading, setTranscriptLoading] = createSignal(false)
  const [confirmDeleteId, setConfirmDeleteId] = createSignal<string | null>(null)
  const [uploading, setUploading] = createSignal(false)

  let fileInputRef: HTMLInputElement | undefined
  let searchDebounce: ReturnType<typeof setTimeout> | undefined

  // ── Data fetching ────────────────────────────────────────────────

  async function loadRecordings(orgId: string) {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchRecordings(orgId)
      setRecordings(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load recordings')
      setRecordings([])
    } finally {
      setLoading(false)
    }
  }

  createEffect(
    on(
      () => ws()?.orgId,
      (orgId) => {
        setSelectedId(null)
        setExpandedTranscriptId(null)
        setTranscriptText(null)
        setSearch('')
        if (orgId) loadRecordings(orgId)
        else {
          setRecordings([])
          setError(null)
        }
      }
    )
  )

  // ── Search ───────────────────────────────────────────────────────

  function handleSearchInput(value: string) {
    setSearch(value)
    clearTimeout(searchDebounce)
    const orgId = ws()?.orgId
    if (!orgId) return

    if (value.trim().length >= 3) {
      searchDebounce = setTimeout(async () => {
        try {
          const results = await searchRecordings(orgId, value.trim())
          setRecordings(results)
        } catch {
          // Fall back to local filter on server search failure
        }
      }, 400)
    } else if (value.trim().length === 0) {
      loadRecordings(orgId)
    }
  }

  onCleanup(() => clearTimeout(searchDebounce))

  const filtered = () => {
    const q = search().toLowerCase().trim()
    if (!q) return recordings()
    return recordings().filter(
      (r) => r.name.toLowerCase().includes(q) || (r.tags && r.tags.some((t) => t.toLowerCase().includes(q)))
    )
  }

  // ── Upload ───────────────────────────────────────────────────────

  async function handleUpload(file: File) {
    const orgId = ws()?.orgId
    if (!orgId) return
    setUploading(true)
    setError(null)
    try {
      const newRec = await uploadRecording(orgId, file)
      setRecordings((prev) => [newRec, ...prev])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  // ── Delete ───────────────────────────────────────────────────────

  async function handleDelete(id: string) {
    const orgId = ws()?.orgId
    if (!orgId) return
    try {
      await deleteRecording(orgId, id)
      setRecordings((prev) => prev.filter((r) => r.id !== id))
      if (selectedId() === id) setSelectedId(null)
      if (expandedTranscriptId() === id) {
        setExpandedTranscriptId(null)
        setTranscriptText(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setConfirmDeleteId(null)
    }
  }

  // ── Transcription ────────────────────────────────────────────────

  async function handleTranscribe(id: string) {
    const orgId = ws()?.orgId
    if (!orgId) return
    try {
      await startTranscription(orgId, id)
      setRecordings((prev) => prev.map((r) => (r.id === id ? { ...r, transcriptStatus: 'pending' as const } : r)))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Transcription request failed')
    }
  }

  async function toggleTranscript(rec: RecordingMeta) {
    if (expandedTranscriptId() === rec.id) {
      setExpandedTranscriptId(null)
      setTranscriptText(null)
      return
    }
    const orgId = ws()?.orgId
    if (!orgId) return

    setExpandedTranscriptId(rec.id)
    if (rec.transcript) {
      setTranscriptText(rec.transcript)
      return
    }

    setTranscriptLoading(true)
    try {
      const text = await fetchTranscript(orgId, rec.id)
      setTranscriptText(text)
    } catch {
      setTranscriptText('Failed to load transcript.')
    } finally {
      setTranscriptLoading(false)
    }
  }

  // ── Audio URL ────────────────────────────────────────────────────

  function audioUrl(rec: RecordingMeta): string {
    const orgId = ws()?.orgId ?? ''
    return `${apiBase(orgId)}/${encodeURIComponent(rec.id)}/audio`
  }

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div class="flex h-full flex-col">
      {/* Header */}
      <div class="flex items-center justify-between border-b px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
        <span class="text-xs font-medium" style={{ color: 'var(--c-text-heading)' }}>
          Recordings
        </span>
        <button
          class="rounded px-2 py-0.5 text-xs font-medium"
          style={{
            background: 'var(--c-accent)',
            color: 'var(--c-text-on-accent, #fff)',
            opacity: uploading() ? '0.6' : '1',
            cursor: uploading() ? 'not-allowed' : 'pointer'
          }}
          disabled={uploading() || !ws()?.orgId}
          onClick={() => fileInputRef?.click()}
        >
          {uploading() ? 'Uploading…' : 'Upload'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          class="hidden"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0]
            if (file) handleUpload(file)
            e.currentTarget.value = ''
          }}
        />
      </div>

      {/* Search */}
      <div class="border-b px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
        <input
          type="text"
          placeholder="Search recordings…"
          class="w-full rounded border px-2 py-1 text-xs"
          style={{
            background: 'var(--c-bg-raised)',
            'border-color': 'var(--c-border)',
            color: 'var(--c-text)'
          }}
          value={search()}
          onInput={(e) => handleSearchInput(e.currentTarget.value)}
        />
      </div>

      {/* Error banner */}
      <Show when={error()}>
        <div
          class="flex items-center gap-2 border-b px-3 py-1.5"
          style={{ 'border-color': 'var(--c-border)', background: 'var(--c-bg-secondary)' }}
        >
          <span class="flex-1 text-xs" style={{ color: 'var(--c-error)' }}>
            {error()}
          </span>
          <button class="text-xs" style={{ color: 'var(--c-text-muted)' }} onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      </Show>

      {/* Content */}
      <div class="flex-1 overflow-auto p-2">
        {/* Loading */}
        <Show when={loading()}>
          <div class="flex flex-col items-center gap-2 py-8">
            <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
              Loading recordings…
            </p>
          </div>
        </Show>

        {/* Empty state */}
        <Show when={!loading() && filtered().length === 0 && !error()}>
          <div class="flex flex-col items-center gap-2 py-8">
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              style={{ color: 'var(--c-text-muted)' }}
            >
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
            <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
              {search().trim() ? 'No recordings match your search' : 'No recordings yet'}
            </p>
            <Show when={!search().trim()}>
              <p class="text-center text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                Upload an audio file to get started
              </p>
            </Show>
          </div>
        </Show>

        {/* Recording list */}
        <Show when={!loading() && filtered().length > 0}>
          <div class="flex flex-col gap-1.5">
            <For each={filtered()}>
              {(rec) => {
                const badge = () => transcriptBadge(rec.transcriptStatus)
                const isSelected = () => selectedId() === rec.id
                const isExpanded = () => expandedTranscriptId() === rec.id

                return (
                  <div
                    class="rounded-lg border transition-colors"
                    style={{
                      background: isSelected() ? 'var(--c-bg-raised)' : 'var(--c-bg)',
                      'border-color': isSelected() ? 'var(--c-accent)' : 'var(--c-border)'
                    }}
                  >
                    {/* Card header */}
                    <button
                      class="flex w-full flex-col gap-1 p-2.5 text-left"
                      onClick={() => setSelectedId(isSelected() ? null : rec.id)}
                    >
                      <div class="flex items-center justify-between gap-2">
                        <span class="min-w-0 truncate text-xs font-medium" style={{ color: 'var(--c-text-heading)' }}>
                          {rec.name}
                        </span>
                        <span
                          class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                          style={{ background: 'var(--c-bg-secondary)', color: badge().color }}
                        >
                          {badge().label}
                        </span>
                      </div>
                      <div class="flex items-center gap-2 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                        <span>{formatDuration(rec.duration)}</span>
                        <span>·</span>
                        <span>{formatBytes(rec.sizeBytes)}</span>
                        <span>·</span>
                        <span>{formatDate(rec.createdAt)}</span>
                      </div>
                      <Show when={rec.tags && rec.tags.length > 0}>
                        <div class="flex flex-wrap gap-1">
                          <For each={rec.tags}>
                            {(tag) => (
                              <span
                                class="rounded-full px-1.5 py-0 text-[10px]"
                                style={{ background: 'var(--c-bg-tertiary)', color: 'var(--c-text-muted)' }}
                              >
                                {tag}
                              </span>
                            )}
                          </For>
                        </div>
                      </Show>
                    </button>

                    {/* Expanded: audio player + actions */}
                    <Show when={isSelected()}>
                      <div class="border-t px-2.5 py-2" style={{ 'border-color': 'var(--c-border)' }}>
                        {/* Audio player */}
                        <audio
                          controls
                          class="mb-2 w-full"
                          style={{ height: '32px' }}
                          src={audioUrl(rec)}
                          preload="none"
                        />

                        {/* Action buttons */}
                        <div class="flex flex-wrap items-center gap-1.5">
                          <Show when={rec.transcriptStatus === 'none' || rec.transcriptStatus === 'failed'}>
                            <button
                              class="rounded px-2 py-0.5 text-[10px] font-medium"
                              style={{ background: 'var(--c-accent)', color: 'var(--c-text-on-accent, #fff)' }}
                              onClick={(e) => {
                                e.stopPropagation()
                                handleTranscribe(rec.id)
                              }}
                            >
                              Transcribe
                            </button>
                          </Show>

                          <Show when={rec.transcriptStatus === 'processing'}>
                            <span class="text-[10px]" style={{ color: 'var(--c-warning, #f59e0b)' }}>
                              Transcribing{rec.transcriptionProgress != null ? ` ${rec.transcriptionProgress}%` : '…'}
                            </span>
                          </Show>

                          <Show when={rec.transcriptStatus === 'completed'}>
                            <button
                              class="rounded px-2 py-0.5 text-[10px] font-medium"
                              style={{
                                background: isExpanded() ? 'var(--c-accent)' : 'var(--c-bg-secondary)',
                                color: isExpanded() ? 'var(--c-text-on-accent, #fff)' : 'var(--c-text)'
                              }}
                              onClick={(e) => {
                                e.stopPropagation()
                                toggleTranscript(rec)
                              }}
                            >
                              {isExpanded() ? 'Hide Transcript' : 'Show Transcript'}
                            </button>
                          </Show>

                          <div class="flex-1" />

                          {/* Delete with confirmation */}
                          <Show
                            when={confirmDeleteId() === rec.id}
                            fallback={
                              <button
                                class="rounded px-2 py-0.5 text-[10px]"
                                style={{ color: 'var(--c-error)' }}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setConfirmDeleteId(rec.id)
                                }}
                              >
                                Delete
                              </button>
                            }
                          >
                            <span class="text-[10px]" style={{ color: 'var(--c-error)' }}>
                              Delete?
                            </span>
                            <button
                              class="rounded px-1.5 py-0.5 text-[10px] font-medium"
                              style={{ background: 'var(--c-error)', color: '#fff' }}
                              onClick={(e) => {
                                e.stopPropagation()
                                handleDelete(rec.id)
                              }}
                            >
                              Yes
                            </button>
                            <button
                              class="rounded px-1.5 py-0.5 text-[10px]"
                              style={{ color: 'var(--c-text-muted)' }}
                              onClick={(e) => {
                                e.stopPropagation()
                                setConfirmDeleteId(null)
                              }}
                            >
                              No
                            </button>
                          </Show>
                        </div>

                        {/* Transcript content */}
                        <Show when={isExpanded()}>
                          <div
                            class="mt-2 max-h-48 overflow-auto rounded border p-2"
                            style={{ 'border-color': 'var(--c-border)', background: 'var(--c-bg-secondary)' }}
                          >
                            <Show when={transcriptLoading()}>
                              <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                                Loading transcript…
                              </p>
                            </Show>
                            <Show when={!transcriptLoading() && transcriptText()}>
                              <pre
                                class="text-xs leading-relaxed whitespace-pre-wrap"
                                style={{ color: 'var(--c-text)' }}
                              >
                                {transcriptText()}
                              </pre>
                            </Show>
                          </div>
                        </Show>
                      </div>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}

export default RecordingsPanel
