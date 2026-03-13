import { createSignal, Show } from 'solid-js'
import type { JSX } from 'solid-js'

export function Tooltip(props: { text: string; position?: 'top' | 'bottom'; children?: JSX.Element }) {
  const [visible, setVisible] = createSignal(false)
  const pos = () => props.position ?? 'top'

  return (
    <span class="relative inline-flex" onMouseEnter={() => setVisible(true)} onMouseLeave={() => setVisible(false)}>
      {props.children}
      <Show when={visible()}>
        <span
          class="pointer-events-none absolute z-50 rounded px-2 py-1 text-xs whitespace-nowrap"
          style={{
            background: 'var(--c-menu-bg)',
            color: 'var(--c-text)',
            border: '1px solid var(--c-border)',
            ...(pos() === 'top'
              ? { bottom: '100%', left: '50%', transform: 'translateX(-50%)', 'margin-bottom': '4px' }
              : { top: '100%', left: '50%', transform: 'translateX(-50%)', 'margin-top': '4px' })
          }}
        >
          {props.text}
        </span>
      </Show>
    </span>
  )
}
