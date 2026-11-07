// The Forge's Decisions view: questions agents left for the user
// (decision_open). Filter, sort and group them; pick several to group,
// assign a thread, or resolve together — each receiving thread then gets one
// message with all of its resolutions. Logic lives in decisions-model.ts.

import { createMemo, createSignal, For, onCleanup, Show, type Component, type JSX } from 'solid-js'
import type { Decision } from '@sovereign/core'
import type { ForgeApi } from './api.js'
import type { ThreadChoice } from './NodeCard.js'
import { useDismiss } from './dismiss.js'
import MobileSheet from './MobileSheet.js'
import type { DecisionControls } from './mobile.js'
import { renderMarkdown } from '../../lib/markdown.js'
import {
  activeDecisionFilterCount,
  ageLabel,
  DECISION_GROUP_BYS,
  DECISION_SORTS,
  decisionFilterOptions,
  deliverySummary,
  filterDecisions,
  groupDecisionsBy,
  groupLabel,
  knownGroups,
  parseDecisionFilters,
  resolvePayload,
  draftResolution,
  pickOption,
  answeredDecisions,
  NONE,
  type Draft,
  sortDecisions,
  SOURCE_KIND_LABELS,
  sourceTarget,
  sourceText,
  threadLabel,
  toggleIn,
  toggleSection,
  type DecisionFilters,
  type Option
} from './decisions-model.js'

const LS_FILTERS = 'sovereign:forge:decisions:filters'

export interface DecisionsViewProps {
  membrane: string
  api: ForgeApi
  /** Every decision of the membrane, open and resolved (loaded by ForgeView). */
  decisions: Decision[]
  loading: boolean
  error: string | null
  reload: () => Promise<void>
  threads: () => ThreadChoice[]
  onOpenThread: (id: string) => void
  /** Show a work-graph node (a plan's or a PR's): the graph opens with it selected. */
  onSelectNode: (id: string) => void
  /** Phone layout: the filter row moves into a sheet behind the top bar's Filters button. */
  narrow?: boolean
  /** Phone layout: hands the top bar the filter count and the sheet. */
  onMobileControls?: (c: DecisionControls | null) => void
}

const btn = 'rounded border px-2 py-0.5 text-xs transition-colors disabled:opacity-40 hover:bg-[var(--c-hover-bg)]'
const btnStyle = { 'border-color': 'var(--c-border)', color: 'var(--c-text)', background: 'var(--c-bg)' }
const chip =
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] whitespace-nowrap transition-colors'
const chipStyle = (on: boolean) => ({
  'border-color': on ? 'var(--c-accent)' : 'var(--c-border)',
  color: on ? 'var(--c-accent)' : 'var(--c-text)',
  background: 'var(--c-bg)'
})
const menuBox =
  'absolute top-full left-0 z-[61] mt-1 max-h-72 min-w-[180px] overflow-y-auto rounded border py-1 shadow-lg'
const menuStyle = { background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)' }
const inputStyle = { 'border-color': 'var(--c-border)', color: 'var(--c-text)', background: 'var(--c-bg)' }
const muted = { color: 'var(--c-text-muted)' }

const readFilters = (): DecisionFilters => {
  try {
    return parseDecisionFilters(localStorage.getItem(LS_FILTERS))
  } catch {
    return parseDecisionFilters(null)
  }
}

/** A chip that opens a multi-select menu. */
const ChipMenu: Component<{
  label: string
  options: Option[]
  picked: string[]
  onToggle: (v: string) => void
  testid: string
}> = (p) => {
  const [open, setOpen] = createSignal(false)
  let el: HTMLDivElement | undefined
  useDismiss(
    open,
    () => el,
    () => setOpen(false)
  )
  return (
    <div class="relative" ref={el}>
      <button
        class={chip}
        style={chipStyle(p.picked.length > 0)}
        onClick={() => setOpen(!open())}
        data-testid={p.testid}
      >
        {p.label}
        <Show when={p.picked.length}>
          <span>({p.picked.length})</span>
        </Show>
        <span class="opacity-60">▾</span>
      </button>
      <Show when={open()}>
        <div class={menuBox} style={menuStyle}>
          <Show when={p.options.length} fallback={<div class="px-3 py-1 text-xs opacity-60">None</div>}>
            <For each={p.options}>
              {(o) => (
                <button
                  class="flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-[var(--c-hover-bg)]"
                  style={{ color: 'var(--c-text)' }}
                  onClick={() => p.onToggle(o.value)}
                >
                  <span class="w-3">{p.picked.includes(o.value) ? '✓' : ''}</span>
                  <span class="flex-1 truncate">{o.label}</span>
                  <span class="opacity-60">{o.count}</span>
                </button>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  )
}

const sheetChip = 'inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors'

const SheetSection: Component<{ title: string; children: JSX.Element }> = (p) => (
  <div class="px-4 py-2">
    <div class="mb-1.5 text-[11px] font-semibold tracking-wider uppercase" style={muted}>
      {p.title}
    </div>
    <div class="flex flex-wrap gap-1.5">{p.children}</div>
  </div>
)

/** The phone sheet's version of a ChipMenu: every option shown as a 40 px chip. */
const SheetPicks: Component<{
  title: string
  options: Option[]
  picked: string[]
  onToggle: (v: string) => void
  testid: string
}> = (p) => (
  <SheetSection title={p.title}>
    <Show
      when={p.options.length}
      fallback={
        <span class="text-xs" style={muted}>
          None
        </span>
      }
    >
      <For each={p.options}>
        {(o) => (
          <button
            class={sheetChip}
            style={chipStyle(p.picked.includes(o.value))}
            aria-pressed={p.picked.includes(o.value)}
            onClick={() => p.onToggle(o.value)}
            data-testid={p.testid}
          >
            <span class="max-w-[14rem] truncate">{o.label}</span>
            <span class="text-xs" style={muted}>
              {o.count}
            </span>
          </button>
        )}
      </For>
    </Show>
  </SheetSection>
)

const DecisionsView: Component<DecisionsViewProps> = (props) => {
  const [filters, setFiltersSignal] = createSignal<DecisionFilters>(readFilters())
  const [filtersOpen, setFiltersOpen] = createSignal(false)
  if (props.onMobileControls) {
    props.onMobileControls({
      filterCount: () => activeDecisionFilterCount(filters()),
      openFilters: () => setFiltersOpen(true)
    })
    onCleanup(() => props.onMobileControls?.(null))
  }
  const setFilters = (patch: Partial<DecisionFilters>): void => {
    const next = { ...filters(), ...patch }
    setFiltersSignal(next)
    try {
      localStorage.setItem(LS_FILTERS, JSON.stringify(next))
    } catch {
      /* storage off: the filters last this visit */
    }
  }
  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set())
  const [bulk, setBulk] = createSignal<'group' | 'thread' | null>(null)
  const [groupName, setGroupName] = createSignal('')
  const [threadPick, setThreadPick] = createSignal('')
  const [drafts, setDrafts] = createSignal<Record<string, Draft>>({})
  const [editing, setEditing] = createSignal<string | null>(null)
  const [notice, setNotice] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  const threadNames = createMemo(() => new Map(props.threads().map((t) => [t.id, t.label])))
  const name = (id: string) => threadNames().get(id)
  const threadChoices = createMemo(() =>
    props
      .threads()
      .filter((t) => !t.archived)
      .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))
  )
  const options = createMemo(() => decisionFilterOptions(props.decisions, filters().status, name))
  const shown = createMemo(() => sortDecisions(filterDecisions(props.decisions, filters(), name), filters().sort, name))
  const sections = createMemo(() => groupDecisionsBy(shown(), filters().groupBy, name))
  const byId = createMemo(() => new Map(props.decisions.map((d) => [d.id, d])))
  /** The selection, in the order shown; ids that left the list drop out. */
  const picked = createMemo(() => shown().filter((d) => selected().has(d.id)))
  const groups = createMemo(() => knownGroups(props.decisions))

  const toggle = (id: string) => {
    const next = new Set(selected())
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }
  const toggleExpanded = (id: string) => {
    const next = new Set(expanded())
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setExpanded(next)
  }
  const run = async (fn: () => Promise<string | void>): Promise<boolean> => {
    setBusy(true)
    try {
      const msg = await fn()
      await props.reload()
      if (msg) setNotice(msg)
      return true
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  const applyGroup = () =>
    run(async () => {
      const ids = picked().map((d) => d.id)
      await props.api.groupDecisions(props.membrane, ids, { group: groupName().trim() || null })
      setBulk(null)
      return groupName().trim() ? `Grouped ${ids.length} as "${groupName().trim()}".` : `Ungrouped ${ids.length}.`
    })
  const applyThread = () =>
    run(async () => {
      const ids = picked().map((d) => d.id)
      await props.api.groupDecisions(props.membrane, ids, { threadId: threadPick() || null })
      setBulk(null)
      return `Assigned ${ids.length} to ${threadPick() ? threadLabel(threadPick(), name) : 'no thread'}.`
    })
  /** Every open decision with an answer, filtered out or not, goes in one call: one message per thread. */
  const answered = createMemo(() => answeredDecisions(props.decisions, drafts()))
  const resolveAnswered = () => {
    const { body } = resolvePayload(props.membrane, answered(), drafts())
    if (!body.items.length) return
    void run(async () => {
      const res = await props.api.resolveDecisions(body)
      const done = new Set(res.resolved.map((d) => d.id))
      setSelected(new Set([...selected()].filter((id) => !done.has(id))))
      setDrafts(Object.fromEntries(Object.entries(drafts()).filter(([id]) => !done.has(id))))
      return deliverySummary(res, name)
    })
  }
  const setNote = (id: string, note: string) => setDrafts({ ...drafts(), [id]: { ...drafts()[id], note } })
  const pick = (id: string, option: string) => setDrafts({ ...drafts(), [id]: pickOption(drafts()[id], option) })
  /** The answer box: free text, or the context added to a picked option. */
  const notePlaceholder = (d: Decision): string =>
    drafts()[d.id]?.choice
      ? 'Add context (optional)'
      : d.options?.length
        ? 'Pick an option above, or write an answer'
        : 'Resolution'

  const openSource = (d: Decision) => {
    const t = sourceTarget(d.source)
    if (t.kind === 'thread') props.onOpenThread(t.id)
    else if (t.kind === 'node') props.onSelectNode(t.id)
    else if (t.kind === 'file')
      window.dispatchEvent(new CustomEvent('sovereign:open-file', { detail: { path: t.path } }))
  }

  const OptionChips: Component<{ d: Decision; onPick?: (o: string) => void }> = (p) => (
    <Show when={p.d.options?.length}>
      <div class="mt-1 flex flex-wrap gap-1">
        <For each={p.d.options}>
          {(o) => (
            <button
              class={chip}
              style={chipStyle(drafts()[p.d.id]?.choice === o)}
              disabled={!p.onPick}
              onClick={() => p.onPick?.(o)}
              title={p.onPick ? 'Pick this answer (click again to unpick); add context below' : undefined}
              data-testid="decision-option"
            >
              {o}
            </button>
          )}
        </For>
      </div>
    </Show>
  )

  const Row: Component<{ d: Decision }> = (p) => {
    const d = () => byId().get(p.d.id) ?? p.d
    const [group, setGroup] = createSignal(d().group ?? '')
    const [thread, setThread] = createSignal(d().threadId ?? '')
    const saveEdit = () =>
      run(async () => {
        await props.api.updateDecision(props.membrane, d().id, {
          group: group().trim() || null,
          threadId: thread() || null
        })
        setEditing(null)
      })
    return (
      <div
        class="flex gap-2 border-b px-3 py-2"
        style={{ 'border-color': 'var(--c-border)' }}
        data-testid="decision-row"
      >
        <input
          type="checkbox"
          class="mt-1"
          checked={selected().has(d().id)}
          onChange={() => toggle(d().id)}
          aria-label="Select"
        />
        <div class="min-w-0 flex-1">
          <div class="flex items-start gap-2">
            <span
              class="flex-1 text-sm"
              style={{ 'text-decoration': d().status === 'resolved' ? 'line-through' : 'none' }}
            >
              {d().question}
            </span>
            <button
              class={btn}
              style={btnStyle}
              title="Edit the group and thread"
              onClick={() => {
                setGroup(d().group ?? '')
                setThread(d().threadId ?? '')
                setEditing(editing() === d().id ? null : d().id)
              }}
            >
              Edit
            </button>
          </div>
          <OptionChips d={d()} onPick={d().status === 'open' ? (o) => pick(d().id, o) : undefined} />
          <Show when={d().resolution}>
            <div class="mt-1 text-xs" style={{ color: 'var(--c-accent)' }}>
              → {d().resolution}
            </div>
          </Show>
          <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]" style={muted}>
            <Show when={d().context}>
              <button class="hover:underline" onClick={() => toggleExpanded(d().id)}>
                {expanded().has(d().id) ? '▾' : '▸'} Context
              </button>
            </Show>
            <Show when={d().source}>
              {(s) => (
                <Show when={sourceTarget(s()).kind !== 'none'} fallback={<span>From: {sourceText(s())}</span>}>
                  <button
                    class="hover:underline"
                    style={{ color: 'var(--c-accent)' }}
                    onClick={() => openSource(d())}
                    title={`${SOURCE_KIND_LABELS[s().kind]}: ${s().ref}`}
                  >
                    {SOURCE_KIND_LABELS[s().kind]}: {sourceText(s())}
                  </button>
                </Show>
              )}
            </Show>
            <span>{groupLabel(d().group)}</span>
            <Show when={d().threadId} fallback={<span>No thread</span>}>
              {(t) => (
                <button class="hover:underline" onClick={() => props.onOpenThread(t())}>
                  → {threadLabel(t(), name)}
                </button>
              )}
            </Show>
            <span title={d().createdAt}>{ageLabel(d().createdAt, Date.now())}</span>
          </div>
          <Show when={d().context && expanded().has(d().id)}>
            <div
              class="prose prose-sm mt-1 max-w-none text-xs"
              style={{ color: 'var(--c-text)' }}
              // eslint-disable-next-line solid/no-innerhtml
              innerHTML={renderMarkdown(d().context!)}
            />
          </Show>
          <Show when={d().status === 'open'}>
            <textarea
              class="mt-1 w-full rounded border px-1.5 py-0.5 text-xs"
              style={{
                ...inputStyle,
                'border-color': draftResolution(drafts()[d().id]) ? 'var(--c-accent)' : inputStyle['border-color']
              }}
              rows={1}
              placeholder={notePlaceholder(d())}
              value={drafts()[d().id]?.note ?? ''}
              onInput={(e) => setNote(d().id, e.currentTarget.value)}
              data-testid="decision-answer"
            />
          </Show>
          <Show when={editing() === d().id}>
            <div class="mt-2 flex flex-wrap items-center gap-1 text-xs">
              <input
                class="rounded border px-1.5 py-0.5"
                style={inputStyle}
                list="decision-groups"
                placeholder="Group"
                value={group()}
                onInput={(e) => setGroup(e.currentTarget.value)}
              />
              <select
                class="rounded border px-1.5 py-0.5"
                style={inputStyle}
                value={thread()}
                onChange={(e) => setThread(e.currentTarget.value)}
              >
                <option value="">No thread</option>
                <For each={threadChoices()}>{(t) => <option value={t.id}>{t.label}</option>}</For>
              </select>
              <button class={btn} style={btnStyle} disabled={busy()} onClick={() => void saveEdit()}>
                Save
              </button>
            </div>
          </Show>
        </div>
      </div>
    )
  }

  return (
    <div class="flex min-h-0 flex-1 flex-col" data-testid="forge-decisions">
      <datalist id="decision-groups">
        <For each={groups()}>{(g) => <option value={g} />}</For>
      </datalist>

      <Show when={props.narrow && filtersOpen()}>
        <MobileSheet
          title="Decision filters"
          tall
          onClose={() => setFiltersOpen(false)}
          testid="decisions-filters-sheet"
        >
          <div class="pb-4">
            <SheetSection title="Status">
              <For each={['open', 'resolved', 'all'] as const}>
                {(s) => (
                  <button
                    class={sheetChip}
                    style={chipStyle(filters().status === s)}
                    aria-pressed={filters().status === s}
                    onClick={() => setFilters({ status: s })}
                    data-testid={`decisions-status-${s}`}
                  >
                    {s === 'open' ? 'Open' : s === 'resolved' ? 'Resolved' : 'All'}
                  </button>
                )}
              </For>
            </SheetSection>
            <SheetSection title="Search">
              <input
                class="h-10 w-full rounded border px-2 text-sm"
                style={inputStyle}
                placeholder="Search decisions"
                value={filters().q}
                onInput={(e) => setFilters({ q: e.currentTarget.value })}
                data-testid="decisions-search"
              />
            </SheetSection>
            <SheetPicks
              title="Group"
              options={options().groups}
              picked={filters().groups}
              onToggle={(v) => setFilters({ groups: toggleIn(filters().groups, v) })}
              testid="decisions-filter-group"
            />
            <SheetPicks
              title="Thread"
              options={options().threads}
              picked={filters().threads}
              onToggle={(v) => setFilters({ threads: toggleIn(filters().threads, v) })}
              testid="decisions-filter-thread"
            />
            <SheetPicks
              title="Source"
              options={options().sourceKinds}
              picked={filters().sourceKinds}
              onToggle={(v) => setFilters({ sourceKinds: toggleIn(filters().sourceKinds, v as never) })}
              testid="decisions-filter-source"
            />
            <SheetSection title="Sort">
              <select
                class="h-10 w-full rounded border px-2 text-sm"
                style={inputStyle}
                value={filters().sort}
                onChange={(e) => setFilters({ sort: e.currentTarget.value as DecisionFilters['sort'] })}
              >
                <For each={DECISION_SORTS}>{(s) => <option value={s.value}>{s.label}</option>}</For>
              </select>
            </SheetSection>
            <SheetSection title="Group by">
              <select
                class="h-10 w-full rounded border px-2 text-sm"
                style={inputStyle}
                value={filters().groupBy}
                onChange={(e) => setFilters({ groupBy: e.currentTarget.value as DecisionFilters['groupBy'] })}
              >
                <For each={DECISION_GROUP_BYS}>{(g) => <option value={g.value}>{g.label}</option>}</For>
              </select>
            </SheetSection>
            <Show
              when={filters().groups.length || filters().threads.length || filters().sourceKinds.length || filters().q}
            >
              <div class="px-4 pt-2">
                <button
                  class="min-h-10 w-full rounded border px-3 text-sm"
                  style={chipStyle(false)}
                  onClick={() => setFilters({ groups: [], threads: [], sourceKinds: [], q: '' })}
                >
                  Clear filters
                </button>
              </div>
            </Show>
          </div>
        </MobileSheet>
      </Show>

      {/* Filters (a phone has them in the sheet above) */}
      <Show when={!props.narrow}>
        <div
          class="flex flex-wrap items-center gap-1.5 border-b px-3 py-1.5"
          style={{ 'border-color': 'var(--c-border)' }}
        >
          <For each={['open', 'resolved', 'all'] as const}>
            {(s) => (
              <button
                class={chip}
                style={chipStyle(filters().status === s)}
                onClick={() => setFilters({ status: s })}
                data-testid={`decisions-status-${s}`}
              >
                {s === 'open' ? 'Open' : s === 'resolved' ? 'Resolved' : 'All'}
              </button>
            )}
          </For>
          <ChipMenu
            label="Group"
            options={options().groups}
            picked={filters().groups}
            onToggle={(v) => setFilters({ groups: toggleIn(filters().groups, v) })}
            testid="decisions-filter-group"
          />
          <ChipMenu
            label="Thread"
            options={options().threads}
            picked={filters().threads}
            onToggle={(v) => setFilters({ threads: toggleIn(filters().threads, v) })}
            testid="decisions-filter-thread"
          />
          <ChipMenu
            label="Source"
            options={options().sourceKinds}
            picked={filters().sourceKinds}
            onToggle={(v) => setFilters({ sourceKinds: toggleIn(filters().sourceKinds, v as never) })}
            testid="decisions-filter-source"
          />
          <input
            class="min-w-[8rem] flex-1 rounded border px-1.5 py-0.5 text-xs"
            style={inputStyle}
            placeholder="Search decisions"
            value={filters().q}
            onInput={(e) => setFilters({ q: e.currentTarget.value })}
            data-testid="decisions-search"
          />
          <select
            class="rounded border px-1.5 py-0.5 text-xs"
            style={inputStyle}
            value={filters().sort}
            onChange={(e) => setFilters({ sort: e.currentTarget.value as DecisionFilters['sort'] })}
            title="Sort"
          >
            <For each={DECISION_SORTS}>{(s) => <option value={s.value}>Sort: {s.label}</option>}</For>
          </select>
          <select
            class="rounded border px-1.5 py-0.5 text-xs"
            style={inputStyle}
            value={filters().groupBy}
            onChange={(e) => setFilters({ groupBy: e.currentTarget.value as DecisionFilters['groupBy'] })}
            title="Group by"
          >
            <For each={DECISION_GROUP_BYS}>{(g) => <option value={g.value}>{g.label}</option>}</For>
          </select>
          <Show
            when={filters().groups.length || filters().threads.length || filters().sourceKinds.length || filters().q}
          >
            <button
              class="text-[11px] hover:underline"
              style={muted}
              onClick={() => setFilters({ groups: [], threads: [], sourceKinds: [], q: '' })}
            >
              Clear
            </button>
          </Show>
        </div>
      </Show>

      {/* Resolve: every answered decision in one call, one message per thread. */}
      <Show when={props.decisions.some((d) => d.status === 'open')}>
        <div
          class="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-xs max-sm:order-last max-sm:flex-nowrap max-sm:border-t max-sm:border-b-0 max-sm:px-2"
          style={{
            'border-color': 'var(--c-border)',
            background: 'var(--c-bg-raised)',
            'padding-bottom': props.narrow ? 'max(0.375rem, env(safe-area-inset-bottom))' : undefined
          }}
          data-testid="decisions-resolve-bar"
        >
          <button
            class={`${btn} max-sm:min-h-10 max-sm:flex-1 max-sm:text-sm`}
            style={btnStyle}
            disabled={busy() || !answered().length}
            onClick={resolveAnswered}
            data-testid="decisions-resolve-send"
          >
            Resolve {answered().length} and send
          </button>
          <span class="max-sm:hidden" style={muted}>
            {answered().length
              ? `${answered().length} answered: pick an option and/or write an answer on each, then send them all at once.`
              : 'Pick an option and/or write an answer on each decision, then send them all at once.'}
          </span>
          <Show when={answered().length}>
            <button class="hover:underline max-sm:min-h-10 max-sm:px-2" style={muted} onClick={() => setDrafts({})}>
              Clear answers
            </button>
          </Show>
        </div>
      </Show>

      {/* Bulk actions */}
      <Show when={picked().length}>
        <div
          class="flex flex-wrap items-center gap-1.5 border-b px-3 py-1.5 text-xs"
          style={{ 'border-color': 'var(--c-border)', background: 'var(--c-bg-raised)' }}
          data-testid="decisions-bulk"
        >
          <span>{picked().length} selected</span>
          <button class={btn} style={btnStyle} onClick={() => setBulk(bulk() === 'group' ? null : 'group')}>
            Group as…
          </button>
          <button class={btn} style={btnStyle} onClick={() => setBulk(bulk() === 'thread' ? null : 'thread')}>
            Assign thread…
          </button>
          <button class="hover:underline" style={muted} onClick={() => setSelected(new Set<string>())}>
            Clear selection
          </button>
          <Show when={bulk() === 'group'}>
            <span class="flex items-center gap-1">
              <input
                class="rounded border px-1.5 py-0.5"
                style={inputStyle}
                list="decision-groups"
                placeholder="New or existing group (empty: none)"
                value={groupName()}
                onInput={(e) => setGroupName(e.currentTarget.value)}
              />
              <button class={btn} style={btnStyle} disabled={busy()} onClick={() => void applyGroup()}>
                Apply
              </button>
            </span>
          </Show>
          <Show when={bulk() === 'thread'}>
            <span class="flex items-center gap-1">
              <select
                class="rounded border px-1.5 py-0.5"
                style={inputStyle}
                value={threadPick()}
                onChange={(e) => setThreadPick(e.currentTarget.value)}
              >
                <option value="">No thread</option>
                <For each={threadChoices()}>{(t) => <option value={t.id}>{t.label}</option>}</For>
              </select>
              <button class={btn} style={btnStyle} disabled={busy()} onClick={() => void applyThread()}>
                Apply
              </button>
            </span>
          </Show>
        </div>
      </Show>

      <Show when={notice()}>
        <div class="flex items-center gap-2 border-b px-3 py-1 text-xs" style={{ 'border-color': 'var(--c-border)' }}>
          <span class="flex-1" data-testid="decisions-notice">
            {notice()}
          </span>
          <button class="hover:underline" style={muted} onClick={() => setNotice(null)}>
            ✕
          </button>
        </div>
      </Show>

      {/* The list */}
      <div class="min-h-0 flex-1 overflow-y-auto">
        <Show when={props.error}>
          <div class="px-3 py-2 text-xs" style={{ color: 'var(--c-error)' }}>
            {props.error}
          </div>
        </Show>
        <Show
          when={shown().length}
          fallback={
            <div class="px-3 py-6 text-center text-sm" style={muted} data-testid="decisions-empty">
              <Show
                when={props.decisions.length || props.loading}
                fallback={
                  <>
                    No decisions yet. Agents open them with <code>decision_open</code> instead of asking you in chat;
                    resolve them here, several at once.
                  </>
                }
              >
                {props.loading && !props.decisions.length ? 'Loading decisions…' : 'No decisions match these filters.'}
              </Show>
            </div>
          }
        >
          <For each={sections()}>
            {(s) => (
              <div>
                <Show when={filters().groupBy !== 'none'}>
                  <label
                    class="sticky top-0 z-[1] flex items-center gap-2 border-b px-3 py-1 text-xs font-medium"
                    style={{ 'border-color': 'var(--c-border)', background: 'var(--c-bg-raised)' }}
                  >
                    <input
                      type="checkbox"
                      checked={s.items.every((d) => selected().has(d.id))}
                      onChange={() =>
                        setSelected(
                          toggleSection(
                            selected(),
                            s.items.map((d) => d.id)
                          )
                        )
                      }
                      aria-label={`Select all in ${s.label}`}
                    />
                    <span class="flex-1">{s.label}</span>
                    <Show when={filters().groupBy === 'thread' && s.key !== NONE}>
                      <button
                        class="rounded border px-1.5 font-normal hover:bg-[var(--c-hover-bg)]"
                        style={{ 'border-color': 'var(--c-border)', color: 'var(--c-text-muted)' }}
                        onClick={(e) => {
                          e.preventDefault()
                          props.onOpenThread(s.key)
                        }}
                        data-testid="forge-decisions-open-thread"
                      >
                        Open thread
                      </button>
                    </Show>
                    <span style={muted}>{s.items.length}</span>
                  </label>
                </Show>
                <For each={s.items}>{(d) => <Row d={d} />}</For>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}

export default DecisionsView
