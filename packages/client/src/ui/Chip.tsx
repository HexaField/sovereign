import { Show } from 'solid-js'
import type { JSX } from 'solid-js'

export function Chip(props: { label: string; icon?: JSX.Element; onRemove?: () => void }) {
  return (
    <span
      class="inline-flex items-center gap-1 rounded border px-2 py-0.5 font-mono text-xs transition-colors hover:border-[var(--c-accent)]"
      style={{
        'border-color': 'var(--c-border)',
        color: 'var(--c-text)'
      }}
    >
      <Show when={props.icon}>{props.icon}</Show>
      {props.label}
      <Show when={props.onRemove}>
        <button
          class="ml-1 cursor-pointer leading-none opacity-60 hover:opacity-100"
          onClick={props.onRemove}
          aria-label={`Remove ${props.label}`}
        >
          ✕
        </button>
      </Show>
    </span>
  )
}
