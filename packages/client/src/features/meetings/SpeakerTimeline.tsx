// Speaker timeline — §8.9.2
import { For } from 'solid-js'
import type { SpeakerSegment } from './store.js'

export interface SpeakerTimelineProps {
  segments: SpeakerSegment[]
  totalDurationMs: number
  onSeek?: (ms: number) => void
}

const SPEAKER_COLORS = ['var(--c-accent)', '#e879f9', '#34d399', '#f59e0b', '#60a5fa', '#f472b6', '#a78bfa', '#fb923c']

export function getTimelineSpeakers(segments: SpeakerSegment[]): string[] {
  return [...new Set(segments.map((s) => s.speaker))]
}

export function getSegmentStyle(
  seg: SpeakerSegment,
  totalMs: number,
  speakers: string[]
): { left: string; width: string; background: string } {
  const left = totalMs > 0 ? (seg.startMs / totalMs) * 100 : 0
  const width = totalMs > 0 ? ((seg.endMs - seg.startMs) / totalMs) * 100 : 0
  const idx = speakers.indexOf(seg.speaker)
  const bg = SPEAKER_COLORS[idx >= 0 ? idx % SPEAKER_COLORS.length : 0]
  return { left: `${left}%`, width: `${width}%`, background: bg }
}

export function SpeakerTimeline(props: SpeakerTimelineProps) {
  const speakers = () => getTimelineSpeakers(props.segments)

  return (
    <div class="flex flex-col gap-2 p-3">
      {/* Legend */}
      <div class="flex flex-wrap gap-2">
        <For each={speakers()}>
          {(speaker) => {
            const idx = speakers().indexOf(speaker)
            return (
              <div class="flex items-center gap-1 text-xs">
                <div
                  class="h-2.5 w-2.5 rounded-full"
                  style={{ background: SPEAKER_COLORS[idx % SPEAKER_COLORS.length] }}
                />
                <span style={{ color: 'var(--c-text-muted)' }}>{speaker}</span>
              </div>
            )
          }}
        </For>
      </div>

      {/* Timeline bar */}
      <div
        class="relative h-6 w-full cursor-pointer overflow-hidden rounded"
        style={{ background: 'var(--c-bg-raised)' }}
        onClick={(e) => {
          if (!props.onSeek || !props.totalDurationMs) return
          const rect = e.currentTarget.getBoundingClientRect()
          const pct = (e.clientX - rect.left) / rect.width
          props.onSeek(pct * props.totalDurationMs)
        }}
      >
        <For each={props.segments}>
          {(seg) => {
            const style = () => getSegmentStyle(seg, props.totalDurationMs, speakers())
            return (
              <div
                class="absolute top-0 h-full opacity-80"
                style={{
                  left: style().left,
                  width: style().width,
                  background: style().background
                }}
              />
            )
          }}
        </For>
      </div>
    </div>
  )
}
