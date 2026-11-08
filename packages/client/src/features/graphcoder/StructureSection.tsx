// The "Structure" section of a Forge PR card: what the change does to the code.
// The node carries the state and the numbers; once ready, the full structure
// (concepts, modules, symbols, tests) loads from Graphcoder's cache-only route.
// "Concept map" opens the repo's concept tree at the change's head.

import { createResource, createSignal, For, Match, Show, Switch, type Component } from 'solid-js'
import type { WorkNodeStructure } from '@sovereign/core/forge'
import { createGraphcoderApi, type GraphcoderApi } from './api.js'
import { ConceptImpact } from './ConceptImpact.js'
import { ConceptTree } from './ConceptTree.js'
import { moduleCounts, reachText, symbolGroups, testLabel } from './structure-model.js'

const sectionTitle = 'mb-1 mt-3 text-[10px] font-semibold tracking-wider uppercase'
const muted = { color: 'var(--c-text-muted)' }
/** Tests listed before "N more" */
const TESTS_SHOWN = 12

const defaultApi = createGraphcoderApi()

export const StructureSection: Component<{ structure: WorkNodeStructure; api?: GraphcoderApi }> = (props) => {
  const api = () => props.api ?? defaultApi
  // Keyed by text, so a graph poll that hands over an equal node does not load it again
  const [detail] = createResource(
    () => {
      const s = props.structure
      return s.state === 'ready' ? JSON.stringify([s.path, s.base, s.head]) : false
    },
    (key) => {
      const [path, base, head] = JSON.parse(key) as [string, string, string]
      return api().cachedStructure({ path, base, head })
    }
  )
  const ready = () => {
    const d = detail()
    return d?.state === 'ready' ? d.structure : undefined
  }
  // The concept map loads only once opened: at another commit than the checkout's, the server indexes it first
  const [mapOpen, setMapOpen] = createSignal(false)

  return (
    <div data-testid="graphcoder-structure">
      <div class={sectionTitle} style={muted}>
        Structure
      </div>
      <Switch>
        <Match when={props.structure.state === 'computing'}>
          <div style={muted}>Computing…</div>
        </Match>
        <Match when={props.structure.state === 'failed'}>
          <div style={{ color: 'var(--c-error, #ef4444)' }}>
            {props.structure.error ?? 'Could not compute the structure'}
          </div>
        </Match>
        <Match when={detail.loading}>
          <div style={muted}>Loading…</div>
        </Match>
        <Match when={detail()?.state === 'failed' || detail()?.state === 'none'}>
          <div style={muted}>
            Not available yet{detail()?.state === 'failed' ? `: ${(detail() as { error: string }).error}` : ''}
          </div>
        </Match>
        <Match when={ready()}>
          {(s) => (
            <>
              <div title="The most hops between two changed symbols on the code graph">
                {reachText(s().reach, s().parts)}
              </div>

              <ConceptImpact structure={s()} />

              <div class="mt-1" style={muted}>
                Modules ({s().modules.length})
              </div>
              <For each={s().modules}>
                {(m) => (
                  <div class="flex gap-2" data-testid="graphcoder-module">
                    <span class="min-w-0 flex-1 truncate" title={m.module}>
                      {m.label}
                    </span>
                    <span style={muted}>{moduleCounts(m)}</span>
                  </div>
                )}
              </For>

              <div class="mt-1" style={muted}>
                Symbols
              </div>
              <For each={symbolGroups(s()).filter((g) => g.items.length > 0)}>
                {(g) => (
                  <details data-testid={`graphcoder-symbols-${g.key}`}>
                    <summary class="cursor-pointer">
                      {g.sign}
                      {g.items.length} {g.label.toLowerCase()}
                    </summary>
                    <For each={g.items}>
                      {(sym) => (
                        <div class="truncate pl-3" title={`${sym.kind} in ${sym.filePath}`}>
                          {sym.qualifiedName} <span style={muted}>{sym.filePath}</span>
                        </div>
                      )}
                    </For>
                  </details>
                )}
              </For>

              <div class="mt-1" style={muted}>
                Tests that reach it ({s().tests.length})
              </div>
              <Show when={s().tests.length} fallback={<div style={muted}>None found statically.</div>}>
                <For each={s().tests.slice(0, TESTS_SHOWN)}>
                  {(t) => {
                    const l = testLabel(t)
                    return (
                      <div class="truncate" title={l.file} data-testid="graphcoder-test">
                        {l.name} <span style={muted}>· {l.depth}</span>
                      </div>
                    )
                  }}
                </For>
                <Show when={s().tests.length > TESTS_SHOWN}>
                  <details>
                    <summary class="cursor-pointer" style={muted}>
                      {s().tests.length - TESTS_SHOWN} more
                    </summary>
                    <For each={s().tests.slice(TESTS_SHOWN)}>
                      {(t) => {
                        const l = testLabel(t)
                        return (
                          <div class="truncate" title={l.file}>
                            {l.name} <span style={muted}>· {l.depth}</span>
                          </div>
                        )
                      }}
                    </For>
                  </details>
                </Show>
              </Show>

              <details class="mt-1" onToggle={(e) => setMapOpen(e.currentTarget.open)}>
                <summary class="cursor-pointer" style={muted} title="The concept tree at this change's head">
                  Concept map
                </summary>
                <Show when={mapOpen()}>
                  <ConceptTree path={props.structure.path} ref={s().head} api={api()} />
                </Show>
              </details>
            </>
          )}
        </Match>
      </Switch>
    </div>
  )
}

export default StructureSection
