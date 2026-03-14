// Action items — §8.9.2
import { For } from 'solid-js'
import type { ActionItem } from './store.js'

export interface ActionItemsProps {
  items: ActionItem[]
  onToggle?: (id: string) => void
}

export function formatDueDate(date: string | null): string {
  if (!date) return ''
  const d = new Date(date)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function isOverdue(date: string | null): boolean {
  if (!date) return false
  return new Date(date).getTime() < Date.now()
}

export function ActionItems(props: ActionItemsProps) {
  return (
    <div class="flex flex-col gap-2 p-3">
      <For each={props.items}>
        {(item) => (
          <label
            class="flex cursor-pointer items-center gap-2 rounded border p-2 text-sm"
            style={{
              background: 'var(--c-bg-raised)',
              'border-color': 'var(--c-border)',
              'text-decoration': item.done ? 'line-through' : 'none',
              opacity: item.done ? '0.6' : '1'
            }}
          >
            <input
              type="checkbox"
              checked={item.done}
              onChange={() => props.onToggle?.(item.id)}
              class="accent-[var(--c-accent)]"
            />
            <span class="flex-1" style={{ color: 'var(--c-text)' }}>
              {item.text}
            </span>
            {item.assignee && (
              <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                @{item.assignee}
              </span>
            )}
            {item.dueDate && (
              <span
                class="text-xs"
                style={{
                  color: isOverdue(item.dueDate) && !item.done ? 'var(--c-danger, #ef4444)' : 'var(--c-text-muted)'
                }}
              >
                {formatDueDate(item.dueDate)}
              </span>
            )}
          </label>
        )}
      </For>
    </div>
  )
}
