// Meeting detail view — §8.9.2
import { createSignal, Show } from 'solid-js'
import type { Meeting } from './store.js'
import { TranscriptView } from './TranscriptView.js'
import { ActionItems } from './ActionItems.js'
import { SpeakerTimeline } from './SpeakerTimeline.js'

export type MeetingTab = 'summary' | 'transcript' | 'actions' | 'audio'

export interface MeetingDetailProps {
  meeting: Meeting
  onTitleChange?: (title: string) => void
  onSeek?: (ms: number) => void
  onRenameSpeaker?: (oldName: string) => void
  onToggleActionItem?: (id: string) => void
}

export const MEETING_TABS: { key: MeetingTab; label: string }[] = [
  { key: 'summary', label: 'Summary' },
  { key: 'transcript', label: 'Transcript' },
  { key: 'actions', label: 'Action Items' },
  { key: 'audio', label: 'Audio' }
]

export function formatDetailDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function MeetingDetail(props: MeetingDetailProps) {
  const [activeTab, setActiveTab] = createSignal<MeetingTab>('summary')
  const m = () => props.meeting

  return (
    <div class="flex h-full flex-col" style={{ background: 'var(--c-bg)' }}>
      {/* Header */}
      <div class="border-b p-4" style={{ 'border-color': 'var(--c-border)' }}>
        <input
          type="text"
          class="w-full bg-transparent text-lg font-semibold outline-none"
          style={{ color: 'var(--c-text-heading)' }}
          value={m().title}
          onInput={(e) => props.onTitleChange?.(e.currentTarget.value)}
        />
        <div class="mt-1 flex gap-3 text-xs" style={{ color: 'var(--c-text-muted)' }}>
          <span>{formatDetailDate(m().date)}</span>
          <span>{Math.floor(m().durationMs / 60000)}m</span>
          <span>{m().participants.join(', ')}</span>
        </div>
      </div>

      {/* Tabs */}
      <div class="flex border-b" style={{ 'border-color': 'var(--c-border)' }}>
        {MEETING_TABS.map((tab) => (
          <button
            class="px-4 py-2 text-sm font-medium transition-colors"
            style={{
              color: activeTab() === tab.key ? 'var(--c-accent)' : 'var(--c-text-muted)',
              'border-bottom': activeTab() === tab.key ? '2px solid var(--c-accent)' : '2px solid transparent'
            }}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div class="flex-1 overflow-y-auto">
        <Show when={activeTab() === 'summary'}>
          <div class="p-4">
            <Show when={m().summary}>
              <p class="text-sm leading-relaxed" style={{ color: 'var(--c-text)' }}>
                {m().summary}
              </p>
            </Show>
            <Show when={m().keyDecisions?.length}>
              <h4 class="mt-4 mb-2 text-xs font-semibold uppercase" style={{ color: 'var(--c-text-muted)' }}>
                Key Decisions
              </h4>
              <ul class="list-inside list-disc text-sm" style={{ color: 'var(--c-text)' }}>
                {m().keyDecisions!.map((d) => (
                  <li>{d}</li>
                ))}
              </ul>
            </Show>
            <Show when={m().keyTopics?.length}>
              <h4 class="mt-4 mb-2 text-xs font-semibold uppercase" style={{ color: 'var(--c-text-muted)' }}>
                Key Topics
              </h4>
              <ul class="list-inside list-disc text-sm" style={{ color: 'var(--c-text)' }}>
                {m().keyTopics!.map((t) => (
                  <li>{t}</li>
                ))}
              </ul>
            </Show>
          </div>
        </Show>

        <Show when={activeTab() === 'transcript'}>
          <TranscriptView
            segments={m().transcript ?? []}
            onSeek={props.onSeek}
            onRenameSpeaker={props.onRenameSpeaker}
          />
        </Show>

        <Show when={activeTab() === 'actions'}>
          <ActionItems items={m().actionItems ?? []} onToggle={props.onToggleActionItem} />
        </Show>

        <Show when={activeTab() === 'audio'}>
          <div class="p-4">
            <Show when={m().audioUrl}>
              <audio controls class="w-full" src={m().audioUrl} />
            </Show>
            <Show when={m().speakerTimeline?.length}>
              <SpeakerTimeline segments={m().speakerTimeline!} totalDurationMs={m().durationMs} onSeek={props.onSeek} />
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}
