import type { JSX } from 'solid-js'

export function Card(props: { children?: JSX.Element; class?: string }) {
  return (
    <div
      class={`rounded-lg border ${props.class ?? ''}`}
      style={{
        background: 'var(--c-bg-raised)',
        'border-color': 'var(--c-border)'
      }}
    >
      {props.children}
    </div>
  )
}
