// An epic's status as a small coloured select: the label and the control in
// one (planned grey, active green, paused amber, archived muted). Used on the
// epics panel's rows and on a node card's epic.

import { For, type Component } from 'solid-js'
import type { EpicStatus } from '@sovereign/core'
import { EPIC_STATUSES } from '@sovereign/core/forge'
import { EPIC_STATUS_COLORS, EPIC_STATUS_LABELS } from './style.js'

export const EpicStatusSelect: Component<{
  status: EpicStatus
  onChange: (status: EpicStatus) => void
  disabled?: boolean
}> = (props) => (
  <select
    class="shrink-0 cursor-pointer rounded border-0 px-1 py-0 text-[10px] font-medium"
    style={{ color: EPIC_STATUS_COLORS[props.status].fg, background: EPIC_STATUS_COLORS[props.status].bg }}
    value={props.status}
    disabled={props.disabled}
    title="Epic status"
    onClick={(e) => e.stopPropagation()}
    onChange={(e) => props.onChange(e.currentTarget.value as EpicStatus)}
    data-testid="forge-epic-status"
  >
    <For each={EPIC_STATUSES}>{(s) => <option value={s}>{EPIC_STATUS_LABELS[s]}</option>}</For>
  </select>
)

export default EpicStatusSelect
