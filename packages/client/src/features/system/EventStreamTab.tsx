export default function EventStreamTab() {
  return null
}

export interface EventStreamEntry {
  id: number
  capturedAt: string
  type: string
  source: string
  payload: unknown
}

export function filterEvents(
  entries: EventStreamEntry[],
  _filter: { type?: string; source?: string }
): EventStreamEntry[] {
  return entries
}

export function formatEventType(_type: string): string {
  return ''
}

export function getEventCategoryColor(_type: string): string {
  return ''
}
