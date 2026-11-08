// What a change does to the concept tree (Graphcoder P1b), in three depths:
// skim (one line), grok (the tree pruned to the touched concepts, each with
// its model, before → after where the page changed), master (a concept's
// changed symbols, the tests that reach them, its files).

import { For, Show, type Component } from 'solid-js'
import type { ChangeStructure, ConceptTouch } from '@sovereign/graphcoder-core/contract'
import { conceptDetail, conceptMarker, signalText, touchCounts } from './concept-model.js'
import { testLabel } from './structure-model.js'

const muted = { color: 'var(--c-text-muted)' }
const warn = { color: 'var(--c-warning, #f59e0b)' }
/** Tests listed per concept */
const TESTS_SHOWN = 8

/** One line before → after, or just the line when it did not change */
const Shift: Component<{ label: string; before?: string; after: string }> = (props) => (
  <Show when={props.after || props.before}>
    <div>
      <span style={muted}>{props.label}: </span>
      <Show when={props.before !== undefined && props.before !== props.after} fallback={props.after}>
        <s style={muted}>{props.before}</s> → {props.after}
      </Show>
    </div>
  </Show>
)

const Concept: Component<{ structure: ChangeStructure; touch: ConceptTouch; indent: number }> = (props) => {
  const t = () => props.touch
  const marker = () => conceptMarker(t())
  const detail = () => conceptDetail(props.structure, t())
  return (
    <details data-testid="graphcoder-concept-touch" style={{ 'padding-left': `${props.indent * 0.75}rem` }}>
      <summary class="cursor-pointer truncate" title={t().file}>
        <Show when={marker().text}>
          <span class="rounded border px-1" style={{ 'border-color': 'var(--c-border)' }} title={marker().title}>
            {marker().text}
          </span>{' '}
        </Show>
        <span style={marker().text ? {} : muted}>{t().title}</span>
        <Show when={touchCounts(t())}>{(c) => <span style={muted}> {c()}</span>}</Show>
        <Show when={signalText(t())}>{(s) => <span style={warn}> · {s()}</span>}</Show>
      </summary>
      <div class="pl-3">
        <Shift label="Model" before={t().before?.model} after={t().model} />
        <Shift label="Why" before={t().before?.why} after={t().why} />
        <For each={detail().symbols}>
          {(g) => (
            <div>
              <span style={muted}>
                {g.sign}
                {g.items.length} {g.label.toLowerCase()}:
              </span>{' '}
              {g.items.map((i) => i.qualifiedName).join(', ')}
            </div>
          )}
        </For>
        <Show when={detail().tests.length}>
          <div
            class="truncate"
            title={detail()
              .tests.map((r) => r.id)
              .join('\n')}
          >
            <span style={muted}>Tests ({detail().tests.length}): </span>
            {detail()
              .tests.slice(0, TESTS_SHOWN)
              .map((r) => testLabel(r).name)
              .join(', ')}
            {detail().tests.length > TESTS_SHOWN ? ' …' : ''}
          </div>
        </Show>
        <For each={detail().files}>
          {(f) => (
            <div class="truncate" style={muted}>
              {f}
            </div>
          )}
        </For>
      </div>
    </details>
  )
}

export const ConceptImpact: Component<{ structure: ChangeStructure }> = (props) => (
  <Show when={props.structure.concepts}>
    {(c) => {
      const top = () => Math.min(...c().pages.map((p) => p.depth))
      const touched = () => c().pages.filter((p) => p.page || touchCounts(p)).length
      return (
        <div class="mt-1" data-testid="graphcoder-concepts">
          <div title={`Concept tree: ${c().dir}/`}>{c().summary || 'Touches no concept'}</div>
          <Show when={c().pages.length}>
            <details>
              <summary class="cursor-pointer" style={muted}>
                Concepts ({touched()})
              </summary>
              <For each={c().pages}>
                {(touch) => <Concept structure={props.structure} touch={touch} indent={touch.depth - top()} />}
              </For>
            </details>
          </Show>
        </div>
      )
    }}
  </Show>
)

export default ConceptImpact
