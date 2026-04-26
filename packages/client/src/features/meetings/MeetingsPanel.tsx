// Meetings panel — §8.9.1
import { createSignal, createEffect, on, Show, For } from 'solid-js'
import { filteredMeetings, searchQuery, setSearchQuery, fetchMeetings, loading } from './store.js'
import { MeetingCard } from './MeetingCard.js'
import { MeetingDetail } from './MeetingDetail.js'
import { ImportDialog } from './ImportDialog.js'
import type { Meeting } from './store.js'
import type { ImportFormData } from './ImportDialog.js'
import { activeWorkspace } from '../workspace/store.js'

export interface MeetingsPanelProps {
  onSelectMeeting?: (meeting: Meeting) => void
  onImport?: () => void
  onRecord?: () => void
}

export function MeetingsPanel(props: MeetingsPanelProps) {
  const ws = () => activeWorkspace()
  const [expandedId, setExpandedId] = createSignal<string | null>(null)
  const [selectedMeeting, setSelectedMeeting] = createSignal<Meeting | null>(null)
  const [showImport, setShowImport] = createSignal(false)

  // Fetch meetings on mount and when workspace changes
  createEffect(
    on(
      () => ws()?.orgId,
      (orgId) => {
        setSelectedMeeting(null)
        setExpandedId(null)
        if (orgId) {
          fetchMeetings(orgId)
        }
      }
    )
  )

  function handleSelectMeeting(meeting: Meeting) {
    setSelectedMeeting(meeting)
    props.onSelectMeeting?.(meeting)
  }

  function handleBack() {
    setSelectedMeeting(null)
  }

  async function handleImportSubmit(data: ImportFormData) {
    const orgId = ws()?.orgId
    if (!orgId) return
    try {
      const form = new FormData()
      form.append('title', data.title)
      if (data.threadKey) form.append('threadKey', data.threadKey)
      if (data.platform) form.append('platform', data.platform)
      if (data.startedAt) form.append('startedAt', data.startedAt)
      if (data.tags.length > 0) form.append('tags', JSON.stringify(data.tags))
      if (data.audioFile) form.append('audio', data.audioFile)
      if (data.transcriptFile) form.append('transcript', data.transcriptFile)

      await fetch(`/api/orgs/${encodeURIComponent(orgId)}/meetings/import`, {
        method: 'POST',
        body: form
      })
      // Refetch to pick up the new meeting
      fetchMeetings(orgId)
    } catch {
      // silent
    }
  }

  // Detail view
  const sel = () => selectedMeeting()

  return (
    <div class="flex h-full flex-col" style={{ background: 'var(--c-bg)' }}>
      {/* Detail view when a meeting is selected */}
      <Show when={sel()}>
        {(meeting) => (
          <>
            <div class="flex items-center gap-2 border-b px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
              <button class="rounded px-1.5 py-0.5 text-xs" style={{ color: 'var(--c-accent)' }} onClick={handleBack}>
                ← Back
              </button>
            </div>
            <div class="flex-1 overflow-auto">
              <MeetingDetail meeting={meeting()} />
            </div>
          </>
        )}
      </Show>

      {/* List view */}
      <Show when={!sel()}>
        {/* Search */}
        <div class="border-b p-3" style={{ 'border-color': 'var(--c-border)' }}>
          <input
            type="text"
            placeholder="Search meetings…"
            class="w-full rounded border px-2 py-1 text-sm"
            style={{
              background: 'var(--c-bg-raised)',
              'border-color': 'var(--c-border)',
              color: 'var(--c-text)'
            }}
            value={searchQuery()}
            onInput={(e) => setSearchQuery(e.currentTarget.value)}
          />
        </div>

        {/* Buttons */}
        <div class="flex gap-2 border-b p-3" style={{ 'border-color': 'var(--c-border)' }}>
          <button
            class="flex-1 rounded px-3 py-1.5 text-sm font-medium"
            style={{ background: 'var(--c-accent)', color: 'white' }}
            onClick={() => {
              if (props.onImport) {
                props.onImport()
              } else {
                setShowImport(true)
              }
            }}
          >
            Import
          </button>
          <button
            class="flex-1 rounded border px-3 py-1.5 text-sm font-medium"
            style={{ 'border-color': 'var(--c-accent)', color: 'var(--c-accent)' }}
            onClick={() => props.onRecord?.()}
          >
            Record
          </button>
        </div>

        {/* List */}
        <div class="flex-1 overflow-y-auto p-3">
          <Show when={loading()}>
            <p class="py-4 text-center text-xs" style={{ color: 'var(--c-text-muted)' }}>
              Loading meetings…
            </p>
          </Show>

          <Show when={!loading() && filteredMeetings().length === 0}>
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
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
              <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                {searchQuery().trim() ? 'No meetings match your search' : 'No meetings yet'}
              </p>
              <Show when={!searchQuery().trim()}>
                <p class="text-center text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                  Import a meeting or start recording to get started
                </p>
              </Show>
            </div>
          </Show>

          <Show when={!loading() && filteredMeetings().length > 0}>
            <div class="flex flex-col gap-2">
              <For each={filteredMeetings()}>
                {(meeting) => (
                  <MeetingCard
                    meeting={meeting}
                    expanded={expandedId() === meeting.id}
                    onToggleExpand={() => setExpandedId((prev) => (prev === meeting.id ? null : meeting.id))}
                    onClick={() => handleSelectMeeting(meeting)}
                  />
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>

      {/* Import Dialog */}
      <ImportDialog open={showImport()} onClose={() => setShowImport(false)} onSubmit={handleImportSubmit} />
    </div>
  )
}
