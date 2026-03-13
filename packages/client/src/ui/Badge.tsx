import { Show } from 'solid-js'

export function Badge(props: { count?: number; variant?: 'accent' | 'danger' | 'muted' }) {
  const colorMap = {
    accent: 'var(--c-accent)',
    danger: 'var(--c-danger)',
    muted: 'var(--c-text-muted)'
  }

  return (
    <Show when={props.count && props.count > 0}>
      <span
        class="inline-flex min-w-[18px] items-center justify-center rounded-full px-1.5 text-xs leading-tight font-semibold"
        style={{
          background: colorMap[props.variant ?? 'accent'],
          color: '#fff'
        }}
      >
        {props.count}
      </span>
    </Show>
  )
}
