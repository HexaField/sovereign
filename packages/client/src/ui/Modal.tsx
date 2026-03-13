import type { Accessor, JSX } from 'solid-js'

export function Modal(props: { open: Accessor<boolean>; onClose: () => void; title?: string; children?: JSX.Element }) {
  void props
  return <div />
}
