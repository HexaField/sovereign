// Transcript view — §8.9.2
import { For } from 'solid-js'
import type { TranscriptSegment } from './store.js'

export interface TranscriptViewProps {
  segments: TranscriptSegment[]
  onSeek?: (ms: number) => void
  onRenameSpeaker?: (oldName: string) => void
}

const SPEAKER_COLORS = ['var(--c-accent)', '#e879f9', '#34d399', '#f59e0b', '#60a5fa', '#f472b6', '#a78bfa', '#fb923c']

export function getSpeakerColor(speaker: string, speakers: string[]): string {
  const idx = speakers.indexOf(speaker)
  return SPEAKER_COLORS[idx >= 0 ? idx % SPEAKER_COLORS.length : 0]
}

export function formatTimestamp(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${sec.toString().padStart(2, '0')}`
}

export function uniqueSpeakers(segments: TranscriptSegment[]): string[] {
  return [...new Set(segments.map((s) => s.speaker))]
}

export function TranscriptView(props: TranscriptViewProps) {
  const speakers = () => uniqueSpeakers(props.segments)

  return (
    <div class="flex flex-col gap-3 p-3">
      <For each={props.segments}>
        {(seg) => (
          <div class="flex gap-2 text-sm">
            <button
              class="shrink-0 cursor-pointer text-xs tabular-nums"
              style={{ color: 'var(--c-text-muted)' }}
              onClick={() => props.onSeek?.(seg.startMs)}
            >
              {formatTimestamp(seg.startMs)}
            </button>
            <button
              class="shrink-0 cursor-pointer font-medium"
              style={{ color: getSpeakerColor(seg.speaker, speakers()) }}
              onClick={() => props.onRenameSpeaker?.(seg.speaker)}
            >
              {seg.speaker}
            </button>
            <span style={{ color: 'var(--c-text)' }}>{seg.text}</span>
          </div>
        )}
      </For>
    </div>
  )
}
