import { createSignal, type JSX, Show } from 'solid-js'

export interface SectionCardProps {
  title: string
  icon: string
  badge?: string | number
  defaultOpen?: boolean
  status?: 'healthy' | 'warning' | 'error' | 'unknown'
  children: JSX.Element
}

const statusColors: Record<string, string> = {
  healthy: 'var(--c-success, #22c55e)',
  warning: 'var(--c-warning, #eab308)',
  error: 'var(--c-danger, #ef4444)',
  unknown: 'var(--c-text-muted, #6b7280)'
}

export function SectionCard(props: SectionCardProps): JSX.Element {
  const [open, setOpen] = createSignal(props.defaultOpen ?? false)

  return (
    <div
      class="overflow-hidden rounded-lg border"
      style={{
        background: 'var(--c-bg-raised)',
        'border-color': 'var(--c-border)'
      }}
    >
      <button
        type="button"
        class="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-left"
        style={{
          background: 'transparent',
          color: 'var(--c-text)',
          border: 'none'
        }}
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open()}
      >
        <span class="text-lg" aria-hidden="true">
          {props.icon}
        </span>
        <span class="flex-1 font-medium">{props.title}</span>
        <Show when={props.status}>
          <span
            class="inline-block h-2 w-2 rounded-full"
            style={{ background: statusColors[props.status!] ?? statusColors.unknown }}
            title={props.status}
          />
        </Show>
        <Show when={props.badge !== undefined && props.badge !== 0}>
          <span
            class="rounded-full px-2 py-0.5 text-xs"
            style={{
              background: 'var(--c-accent)',
              color: 'var(--c-bg)'
            }}
          >
            {props.badge}
          </span>
        </Show>
        <span
          class="transition-transform"
          style={{
            transform: open() ? 'rotate(180deg)' : 'rotate(0deg)',
            color: 'var(--c-text-muted)'
          }}
          aria-hidden="true"
        >
          ▾
        </span>
      </button>
      <Show when={open()}>
        <div class="border-t px-4 pb-3" style={{ 'border-color': 'var(--c-border)' }}>
          {props.children}
        </div>
      </Show>
    </div>
  )
}
