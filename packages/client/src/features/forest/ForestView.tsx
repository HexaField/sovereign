// ── Forest view — knowledge forest tab ──────────────────────────────
// 3D visualisation of the AD4M knowledge graph with pluggable
// projection strategies, overlayable render styles, and parametric
// settings. Loads the pre-computed index from /api/forest/index.

import { Show, lazy, Suspense, onMount, createMemo } from 'solid-js'
import {
  forestLoading,
  forestError,
  forestIndex,
  forestSettings,
  filteredNodes,
  filteredLinks,
  nodePositions,
  nodeByIri,
  selectedNodeIri,
  setSelectedNodeIri,
  hoveredNodeIri,
  setHoveredNodeIri,
  queryOpen,
  setQueryOpen,
  settingsOpen,
  setSettingsOpen,
  loadForestIndex,
  rebuildForestIndex
} from './store.js'

const ForestCanvas = lazy(() => import('./ForestCanvas.js'))
const ForestQuery = lazy(() => import('./ForestQuery.js'))
const ForestSettings = lazy(() => import('./ForestSettings.js'))

export default function ForestView() {
  onMount(() => {
    // Load index on first mount if not already loaded
    if (!forestIndex()) void loadForestIndex()
  })

  const selectedNode = createMemo(() => {
    const iri = selectedNodeIri()
    if (!iri) return null
    return nodeByIri().get(iri) ?? null
  })

  const hoveredNode = createMemo(() => {
    const iri = hoveredNodeIri()
    if (!iri) return null
    return nodeByIri().get(iri) ?? null
  })

  return (
    <div class="relative flex h-full flex-col" style={{ background: 'var(--c-bg)' }}>
      {/* ── Toolbar ──────────────────────────────── */}
      <div
        class="flex shrink-0 items-center gap-2 px-3 py-1.5"
        style={{ 'border-bottom': '1px solid var(--c-border)' }}
      >
        {/* Filter button */}
        <button
          class="cursor-pointer rounded-md border px-2.5 py-1 text-xs font-medium transition-colors"
          style={{
            background: queryOpen() ? 'var(--c-accent)' : 'transparent',
            color: queryOpen() ? '#fff' : 'var(--c-text-muted)',
            'border-color': queryOpen() ? 'var(--c-accent)' : 'var(--c-border)'
          }}
          onClick={() => setQueryOpen(!queryOpen())}
        >
          ⚡ Filter
        </button>

        {/* Projection indicator */}
        <span class="text-[10px] tabular-nums" style={{ color: 'var(--c-text-muted)' }}>
          {forestSettings().projection.strategy}
        </span>

        {/* Node count */}
        <span class="text-[10px] tabular-nums" style={{ color: 'var(--c-text-muted)' }}>
          {filteredNodes().length} nodes
        </span>

        <div class="flex-1" />

        {/* Rebuild */}
        <button
          class="cursor-pointer rounded-md border-none px-2 py-1 text-[10px]"
          style={{ background: 'var(--c-hover-bg)', color: 'var(--c-text-muted)' }}
          onClick={() => void rebuildForestIndex()}
          disabled={forestLoading()}
        >
          {forestLoading() ? '...' : '↻ Rebuild'}
        </button>

        {/* Settings */}
        <button
          class="cursor-pointer rounded-md border px-2.5 py-1 text-xs font-medium transition-colors"
          style={{
            background: settingsOpen() ? 'var(--c-accent)' : 'transparent',
            color: settingsOpen() ? '#fff' : 'var(--c-text-muted)',
            'border-color': settingsOpen() ? 'var(--c-accent)' : 'var(--c-border)'
          }}
          onClick={() => setSettingsOpen(!settingsOpen())}
        >
          ⚙
        </button>
      </div>

      {/* ── Main content ─────────────────────────── */}
      <div class="relative flex-1">
        <Show
          when={!forestLoading() || forestIndex()}
          fallback={
            <div class="flex h-full items-center justify-center">
              <span class="text-sm" style={{ color: 'var(--c-text-muted)' }}>
                Loading knowledge forest...
              </span>
            </div>
          }
        >
          <Show
            when={!forestError()}
            fallback={
              <div class="flex h-full flex-col items-center justify-center gap-2 p-4">
                <span class="text-sm" style={{ color: 'var(--c-danger)' }}>
                  {forestError()}
                </span>
                <button
                  class="cursor-pointer rounded-lg border-none px-4 py-2 text-sm"
                  style={{ background: 'var(--c-accent)', color: '#fff' }}
                  onClick={() => void loadForestIndex()}
                >
                  Retry
                </button>
              </div>
            }
          >
            <Show
              when={filteredNodes().length > 0}
              fallback={
                <div class="flex h-full items-center justify-center">
                  <span class="text-sm" style={{ color: 'var(--c-text-muted)' }}>
                    No nodes in the knowledge graph yet.
                  </span>
                </div>
              }
            >
              <Suspense>
                <ForestCanvas
                  nodes={filteredNodes()}
                  links={filteredLinks()}
                  positions={nodePositions()}
                  settings={forestSettings()}
                  selectedIri={selectedNodeIri()}
                  hoveredIri={hoveredNodeIri()}
                  onSelect={setSelectedNodeIri}
                  onHover={setHoveredNodeIri}
                />
              </Suspense>
            </Show>
          </Show>
        </Show>

        {/* ── Node detail panel ────────────────────── */}
        <Show when={selectedNode() || hoveredNode()}>
          {(() => {
            const node = () => selectedNode() || hoveredNode()
            return (
              <div
                class="absolute bottom-3 left-3 z-50 max-w-[300px] rounded-xl p-3 shadow-lg"
                style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)' }}
              >
                <div class="mb-1 flex items-start justify-between gap-2">
                  <span class="text-sm font-semibold" style={{ color: 'var(--c-text)' }}>
                    {node()?.name}
                  </span>
                  <Show when={selectedNode()}>
                    <button
                      class="shrink-0 cursor-pointer border-none text-xs"
                      style={{ color: 'var(--c-text-muted)' }}
                      onClick={() => setSelectedNodeIri(null)}
                    >
                      ✕
                    </button>
                  </Show>
                </div>
                <div class="flex flex-wrap gap-1">
                  <span
                    class="rounded-full px-2 py-0.5 text-[10px]"
                    style={{ background: 'var(--c-hover-bg)', color: 'var(--c-text-muted)' }}
                  >
                    {node()?.entityType}
                  </span>
                  <span
                    class="rounded-full px-2 py-0.5 text-[10px]"
                    style={{ background: 'var(--c-hover-bg)', color: 'var(--c-text-muted)' }}
                  >
                    {node()?.kind}
                  </span>
                </div>
                <Show when={node()?.content}>
                  <p class="mt-2 line-clamp-3 text-xs leading-relaxed" style={{ color: 'var(--c-text-muted)' }}>
                    {node()?.content}
                  </p>
                </Show>
                <Show when={node()?.tags && node()!.tags.length > 0}>
                  <div class="mt-2 flex flex-wrap gap-1">
                    {node()!.tags.map((t) => (
                      <span
                        class="rounded px-1.5 py-0.5 text-[9px]"
                        style={{ background: 'var(--c-accent)', color: '#fff' }}
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </Show>
              </div>
            )
          })()}
        </Show>
      </div>

      {/* ── Overlays ─────────────────────────────── */}
      <Suspense>
        <ForestQuery />
        <ForestSettings />
      </Suspense>
    </div>
  )
}
