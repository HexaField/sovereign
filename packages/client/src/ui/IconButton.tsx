import type { JSX } from 'solid-js'

export function IconButton(props: { icon: JSX.Element; onClick?: () => void; disabled?: boolean; title?: string }) {
  return (
    <button
      class="inline-flex cursor-pointer items-center justify-center rounded p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      style={{
        background: 'transparent'
      }}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      aria-label={props.title}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--c-hover-bg)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
      }}
      onMouseDown={(e) => {
        e.currentTarget.style.background = 'var(--c-active-bg)'
      }}
      onMouseUp={(e) => {
        e.currentTarget.style.background = 'var(--c-hover-bg)'
      }}
    >
      {props.icon}
    </button>
  )
}
