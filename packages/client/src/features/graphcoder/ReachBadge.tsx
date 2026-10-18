// The small reach badge on a Forge Kanban card.

import { Show, type Component } from 'solid-js'
import type { WorkNodeStructure } from '@sovereign/core/forge'
import { reachBadge } from './structure-model.js'

const TONES = { normal: 'var(--c-text)', muted: 'var(--c-text-muted)', error: 'var(--c-error, #ef4444)' } as const

export const ReachBadge: Component<{ structure?: WorkNodeStructure }> = (props) => (
  <Show when={reachBadge(props.structure)}>
    {(b) => (
      <span
        class="rounded border px-1"
        style={{ 'border-color': 'var(--c-border)', color: TONES[b().tone] }}
        title={b().title}
        data-testid="graphcoder-reach-badge"
      >
        {b().text}
      </span>
    )}
  </Show>
)

export default ReachBadge
