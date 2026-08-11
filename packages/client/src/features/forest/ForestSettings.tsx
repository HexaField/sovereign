// ── Forest settings panel ───────────────────────────────────────────
// Fully parametric settings for projection, nodes, links, transitions.

import { Show, For } from 'solid-js'
import { forestSettings, updateSettings, settingsOpen, setSettingsOpen, resetSettings, forestIndex } from './store.js'
import { allStrategies } from './projections/registry.js'
import type {
  EasingId,
  SizeMapping,
  ColorMapping,
  NodeShape,
  LabelVisibility,
  LinkVisibility,
  LinkStyle,
  LinkColorMapping
} from './types.js'

// ── Helpers ─────────────────────────────────────────────────────────

function SliderRow(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  return (
    <div class="flex items-center gap-2">
      <span class="w-24 shrink-0 text-xs" style={{ color: 'var(--c-text-muted)' }}>
        {props.label}
      </span>
      <input
        type="range"
        class="flex-1"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onInput={(e) => props.onChange(Number(e.currentTarget.value))}
      />
      <span class="w-10 text-right text-xs tabular-nums" style={{ color: 'var(--c-text-muted)' }}>
        {props.value}
      </span>
    </div>
  )
}

function SelectRow<T extends string>(props: {
  label: string
  value: T
  options: readonly T[]
  onChange: (v: T) => void
}) {
  return (
    <div class="flex items-center gap-2">
      <span class="w-24 shrink-0 text-xs" style={{ color: 'var(--c-text-muted)' }}>
        {props.label}
      </span>
      <select
        class="flex-1 rounded border px-2 py-1 text-xs"
        style={{ background: 'var(--c-bg)', color: 'var(--c-text)', 'border-color': 'var(--c-border)' }}
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value as T)}
      >
        <For each={[...props.options]}>{(opt) => <option value={opt}>{opt}</option>}</For>
      </select>
    </div>
  )
}

function SectionLabel(props: { text: string }) {
  return (
    <div class="mt-4 mb-2 text-[10px] font-semibold tracking-widest uppercase" style={{ color: 'var(--c-text-muted)' }}>
      {props.text}
    </div>
  )
}

function CheckRow(props: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label class="flex cursor-pointer items-center gap-2 text-xs" style={{ color: 'var(--c-text-muted)' }}>
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.currentTarget.checked)} />
      {props.label}
    </label>
  )
}

// ── Component ───────────────────────────────────────────────────────

export default function ForestSettings() {
  const s = () => forestSettings()
  const embDim = () => forestIndex()?.embeddingDim ?? 10

  return (
    <Show when={settingsOpen()}>
      {/* Backdrop */}
      <div
        class="fixed inset-0 z-[400]"
        style={{ background: 'rgba(0,0,0,0.3)' }}
        onClick={() => setSettingsOpen(false)}
      />

      {/* Panel — slides in from right on desktop, bottom on mobile */}
      <div
        class="fixed right-0 bottom-0 left-0 z-[401] max-h-[80vh] overflow-y-auto rounded-t-2xl p-4 md:top-0 md:right-0 md:bottom-0 md:left-auto md:max-h-full md:w-[320px] md:rounded-none md:rounded-l-2xl"
        style={{ background: 'var(--c-bg-raised)', border: '1px solid var(--c-border)' }}
      >
        <div class="mb-2 flex items-center justify-between">
          <span class="text-sm font-semibold" style={{ color: 'var(--c-text)' }}>
            Forest Settings
          </span>
          <div class="flex items-center gap-2">
            <button
              class="cursor-pointer rounded-md border-none px-2 py-1 text-[10px]"
              style={{ background: 'var(--c-hover-bg)', color: 'var(--c-text-muted)' }}
              onClick={resetSettings}
            >
              Reset
            </button>
            <button
              class="cursor-pointer border-none text-sm"
              style={{ color: 'var(--c-text-muted)' }}
              onClick={() => setSettingsOpen(false)}
            >
              ✕
            </button>
          </div>
        </div>

        {/* ── Projection ──────────────────────────── */}
        <SectionLabel text="Projection" />
        <div class="space-y-2">
          <SelectRow
            label="Strategy"
            value={s().projection.strategy}
            options={
              allStrategies().map((st) => st.id) as readonly string[] as readonly (
                | 'semantic'
                | 'ontological'
                | 'hash'
              )[]
            }
            onChange={(v) => updateSettings((p) => ({ ...p, projection: { ...p.projection, strategy: v } }))}
          />
          <Show when={s().projection.strategy === 'semantic'}>
            <div class="flex items-center gap-1">
              <span class="w-24 shrink-0 text-xs" style={{ color: 'var(--c-text-muted)' }}>
                Dimensions
              </span>
              {[0, 1, 2].map((axis) => (
                <select
                  class="w-14 rounded border px-1 py-0.5 text-xs"
                  style={{ background: 'var(--c-bg)', color: 'var(--c-text)', 'border-color': 'var(--c-border)' }}
                  value={s().projection.dimensions[axis]}
                  onChange={(e) => {
                    const dims = [...s().projection.dimensions] as [number, number, number]
                    dims[axis] = Number(e.currentTarget.value)
                    updateSettings((p) => ({ ...p, projection: { ...p.projection, dimensions: dims } }))
                  }}
                >
                  {Array.from({ length: Math.min(embDim(), 20) }, (_, i) => (
                    <option value={i}>PC{i + 1}</option>
                  ))}
                </select>
              ))}
            </div>
          </Show>
        </div>

        {/* ── Transition ──────────────────────────── */}
        <SectionLabel text="Transition" />
        <div class="space-y-2">
          <SliderRow
            label="Duration"
            value={s().transition.duration}
            min={100}
            max={3000}
            step={100}
            onChange={(v) => updateSettings((p) => ({ ...p, transition: { ...p.transition, duration: v } }))}
          />
          <SelectRow<EasingId>
            label="Easing"
            value={s().transition.easing}
            options={['linear', 'easeOut', 'easeInOut', 'spring']}
            onChange={(v) => updateSettings((p) => ({ ...p, transition: { ...p.transition, easing: v } }))}
          />
        </div>

        {/* ── Nodes ───────────────────────────────── */}
        <SectionLabel text="Nodes" />
        <div class="space-y-2">
          <SliderRow
            label="Size"
            value={s().node.size}
            min={0.1}
            max={2}
            step={0.1}
            onChange={(v) => updateSettings((p) => ({ ...p, node: { ...p.node, size: v } }))}
          />
          <SelectRow<SizeMapping>
            label="Size map"
            value={s().node.sizeMapping}
            options={['uniform', 'byLinks', 'byAge', 'byType']}
            onChange={(v) => updateSettings((p) => ({ ...p, node: { ...p.node, sizeMapping: v } }))}
          />
          <SelectRow<NodeShape>
            label="Shape"
            value={s().node.shape}
            options={['sphere', 'octahedron']}
            onChange={(v) => updateSettings((p) => ({ ...p, node: { ...p.node, shape: v } }))}
          />
          <SelectRow<ColorMapping>
            label="Colour"
            value={s().node.colorMapping}
            options={['byType', 'byTag', 'byAge', 'byCluster']}
            onChange={(v) => updateSettings((p) => ({ ...p, node: { ...p.node, colorMapping: v } }))}
          />
          <SliderRow
            label="Opacity"
            value={s().node.opacity}
            min={0.1}
            max={1}
            step={0.05}
            onChange={(v) => updateSettings((p) => ({ ...p, node: { ...p.node, opacity: v } }))}
          />
          <SelectRow<LabelVisibility>
            label="Labels"
            value={s().node.labelVisibility}
            options={['always', 'hover', 'selected', 'never']}
            onChange={(v) => updateSettings((p) => ({ ...p, node: { ...p.node, labelVisibility: v } }))}
          />
        </div>

        {/* ── Links ───────────────────────────────── */}
        <SectionLabel text="Links" />
        <div class="space-y-2">
          <SelectRow<LinkVisibility>
            label="Show"
            value={s().link.visibility}
            options={['all', 'selected-neighborhood', 'hover', 'none']}
            onChange={(v) => updateSettings((p) => ({ ...p, link: { ...p.link, visibility: v } }))}
          />
          <SelectRow<LinkStyle>
            label="Style"
            value={s().link.style}
            options={['line', 'arc']}
            onChange={(v) => updateSettings((p) => ({ ...p, link: { ...p.link, style: v } }))}
          />
          <SelectRow<LinkColorMapping>
            label="Colour"
            value={s().link.colorMapping}
            options={['byPredicate', 'uniform']}
            onChange={(v) => updateSettings((p) => ({ ...p, link: { ...p.link, colorMapping: v } }))}
          />
          <SliderRow
            label="Opacity"
            value={s().link.opacity}
            min={0.05}
            max={1}
            step={0.05}
            onChange={(v) => updateSettings((p) => ({ ...p, link: { ...p.link, opacity: v } }))}
          />
          <SliderRow
            label="Width"
            value={s().link.width}
            min={0.5}
            max={5}
            step={0.5}
            onChange={(v) => updateSettings((p) => ({ ...p, link: { ...p.link, width: v } }))}
          />
        </div>

        {/* ── Render styles ───────────────────────── */}
        <SectionLabel text="Render Styles" />
        <div class="space-y-1.5">
          <CheckRow
            label="Graph (nodes + links)"
            checked={s().styles.graph}
            onChange={(v) => updateSettings((p) => ({ ...p, styles: { ...p.styles, graph: v } }))}
          />
          <CheckRow
            label="Cloud (point density)"
            checked={s().styles.cloud}
            onChange={(v) => updateSettings((p) => ({ ...p, styles: { ...p.styles, cloud: v } }))}
          />
        </div>
      </div>
    </Show>
  )
}
