// Meetings panel — §8.9.1
import { createSignal, For } from 'solid-js'
import { filteredMeetings, searchQuery, setSearchQuery } from './store.js'
import { MeetingCard } from './MeetingCard.js'
import type { Meeting } from './store.js'

export interface MeetingsPanelProps {
  onSelectMeeting?: (meeting: Meeting) => void
  onImport?: () => void
  onRecord?: () => void
}

export function MeetingsPanel(props: MeetingsPanelProps) {
  const [expandedId, setExpandedId] = createSignal<string | null>(null)

  return (
    <div class="flex h-full flex-col" style={{ background: 'var(--c-bg)' }}>
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
          onClick={() => props.onImport?.()}
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
        <div class="flex flex-col gap-2">
          <For each={filteredMeetings()}>
            {(meeting) => (
              <MeetingCard
                meeting={meeting}
                expanded={expandedId() === meeting.id}
                onToggleExpand={() => setExpandedId((prev) => (prev === meeting.id ? null : meeting.id))}
                onClick={() => props.onSelectMeeting?.(meeting)}
              />
            )}
          </For>
        </div>
      </div>
    </div>
  )
}
