import type { JSX } from 'solid-js'

export interface SettingsModalProps {
  open: () => boolean
  onClose: () => void
  children?: JSX.Element
}

export function SettingsModal(props: SettingsModalProps) {
  return <div>{props.children}</div>
}
