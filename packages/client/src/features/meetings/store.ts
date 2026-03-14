// Meetings store — §8.9
import { createSignal } from 'solid-js'

export interface TranscriptSegment {
  speaker: string
  text: string
  startMs: number
  endMs: number
}

export interface ActionItem {
  id: string
  text: string
  assignee: string
  dueDate: string | null
  done: boolean
}

export interface SpeakerSegment {
  speaker: string
  startMs: number
  endMs: number
}

export interface Meeting {
  id: string
  title: string
  date: string
  durationMs: number
  participants: string[]
  status: 'recording' | 'transcribing' | 'summarizing' | 'complete' | 'error'
  hasTranscript: boolean
  hasSummary: boolean
  summary?: string
  keyDecisions?: string[]
  keyTopics?: string[]
  transcript?: TranscriptSegment[]
  actionItems?: ActionItem[]
  speakerTimeline?: SpeakerSegment[]
  audioUrl?: string
  threadKey?: string
  tags?: string[]
}

// ── Signals ──────────────────────────────────────────────────────────
const [meetings, setMeetings] = createSignal<Meeting[]>([])
const [searchQuery, setSearchQuery] = createSignal('')
const [loading, setLoading] = createSignal(false)

export { meetings, setMeetings, searchQuery, setSearchQuery, loading }

// ── Derived ──────────────────────────────────────────────────────────
export function sortedMeetings(): Meeting[] {
  return [...meetings()].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
}

export function filteredMeetings(): Meeting[] {
  const q = searchQuery().toLowerCase().trim()
  if (!q) return sortedMeetings()
  return sortedMeetings().filter(
    (m) =>
      m.title.toLowerCase().includes(q) ||
      (m.summary && m.summary.toLowerCase().includes(q)) ||
      (m.transcript && m.transcript.some((s) => s.text.toLowerCase().includes(q)))
  )
}

// ── Actions ──────────────────────────────────────────────────────────
export async function fetchMeetings(): Promise<void> {
  setLoading(true)
  try {
    const res = await fetch('/api/meetings')
    const data = await res.json()
    setMeetings(data.meetings ?? data ?? [])
  } catch {
    // silent
  } finally {
    setLoading(false)
  }
}

export function handleMeetingWsUpdate(msg: { type: string; meeting?: Meeting; meetingId?: string }): void {
  if (msg.type === 'meeting:updated' && msg.meeting) {
    setMeetings((prev) => {
      const idx = prev.findIndex((m) => m.id === msg.meeting!.id)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = msg.meeting!
        return next
      }
      return [msg.meeting!, ...prev]
    })
  } else if (msg.type === 'meeting:deleted' && msg.meetingId) {
    setMeetings((prev) => prev.filter((m) => m.id !== msg.meetingId))
  }
}

export function toggleActionItem(meetingId: string, itemId: string): void {
  setMeetings((prev) =>
    prev.map((m) => {
      if (m.id !== meetingId || !m.actionItems) return m
      return {
        ...m,
        actionItems: m.actionItems.map((ai) => (ai.id === itemId ? { ...ai, done: !ai.done } : ai))
      }
    })
  )
}

export function renameSpeaker(meetingId: string, oldName: string, newName: string): void {
  setMeetings((prev) =>
    prev.map((m) => {
      if (m.id !== meetingId) return m
      return {
        ...m,
        participants: m.participants.map((p) => (p === oldName ? newName : p)),
        transcript: m.transcript?.map((s) => (s.speaker === oldName ? { ...s, speaker: newName } : s)),
        speakerTimeline: m.speakerTimeline?.map((s) => (s.speaker === oldName ? { ...s, speaker: newName } : s))
      }
    })
  )
}

export function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60000)
  const h = Math.floor(totalMin / 60)
  const min = totalMin % 60
  if (h > 0) return `${h}h ${min}m`
  return `${min}m`
}

export function pendingCount(): number {
  return meetings().filter((m) => m.status === 'transcribing' || m.status === 'summarizing').length
}

export function totalHoursThisWeek(): number {
  const now = new Date()
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  return (
    meetings()
      .filter((m) => new Date(m.date) >= weekAgo)
      .reduce((sum, m) => sum + m.durationMs, 0) / 3600000
  )
}

export function openActionItems(): ActionItem[] {
  return meetings().flatMap((m) => (m.actionItems ?? []).filter((ai) => !ai.done))
}

export function recentMeetings(n = 5): Meeting[] {
  return sortedMeetings().slice(0, n)
}

export function createMeetingsStore() {
  return {
    meetings,
    setMeetings,
    searchQuery,
    setSearchQuery,
    loading,
    sortedMeetings,
    filteredMeetings,
    fetchMeetings,
    handleMeetingWsUpdate,
    toggleActionItem,
    renameSpeaker,
    formatDuration,
    pendingCount,
    totalHoursThisWeek,
    openActionItems,
    recentMeetings
  }
}
