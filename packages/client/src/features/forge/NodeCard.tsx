// The selected node's card: an HTML overlay on the canvas.

import { createMemo, createSignal, For, Show, type Component } from 'solid-js'
import { defaultWorkPrompt, type AgentOverlay, type WorkEdge, type WorkNode, type WorkStream } from '@sovereign/core'
import {
  agentStatusLine,
  assignBody,
  defaultThreadLabel,
  kindLabel,
  linkedGroups,
  shortRef,
  taskSection
} from './card-model.js'
import { cardRethinkItems } from './rethink-model.js'
import type { ForgeApi } from './api.js'
import { CI_COLORS, REVIEW_COLORS, STATE_COLORS } from './style.js'
import { threadChoices } from './membrane.js'

export interface ThreadChoice {
  id: string
  label: string
  membraneId?: string
  lastActivity?: number
  archived?: boolean
}

export interface NodeCardProps {
  node: WorkNode
  nodesById: Map<string, WorkNode>
  edges: WorkEdge[]
  streams: WorkStream[]
  overlay?: AgentOverlay
  membrane: string
  api: ForgeApi
  threads: () => ThreadChoice[]
  onFocus: (id: string) => void
  onClose: () => void
  onOpenThread: (id: string) => void
  /** Something changed server-side (stream membership, edge, assignment): refetch. */
  onChanged: () => void
}

const sectionTitle = 'mb-1 mt-3 text-[10px] font-semibold tracking-wider uppercase'
const muted = { color: 'var(--c-text-muted)' }
const btn = 'rounded border px-2 py-0.5 text-xs transition-colors hover:opacity-80 disabled:opacity-40'
const btnStyle = { 'border-color': 'var(--c-border)', color: 'var(--c-text)', background: 'var(--c-bg)' }

const NodeCard: Component<NodeCardProps> = (props) => {
  const n = () => props.node
  const groups = createMemo(() => linkedGroups(n().id, props.edges, props.nodesById))
  const task = createMemo(() => taskSection(n(), props.streams, props.edges, props.nodesById))
  const agent = createMemo(() => agentStatusLine(props.overlay))
  const notes = createMemo(() => cardRethinkItems(n().id, n().rethink, props.edges))
  const [error, setError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  // ── Assign ──
  const [assignOpen, setAssignOpen] = createSignal(false)
  const [threadId, setThreadId] = createSignal<string>('__new__')
  const [newLabel, setNewLabel] = createSignal('')
  const [prompt, setPrompt] = createSignal('')
  const [assigned, setAssigned] = createSignal<{ threadId: string; taskId: string } | null>(null)
  const openAssign = (): void => {
    setNewLabel(defaultThreadLabel(n()))
    setPrompt(defaultWorkPrompt(n()))
    setThreadId(props.overlay?.thread?.id ?? '__new__')
    setAssigned(null)
    setAssignOpen(true)
  }
  const choices = createMemo(() => threadChoices(props.threads(), props.membrane).slice(0, 200))

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const send = () =>
    run(async () => {
      const body = assignBody({
        nodeId: n().id,
        threadId: threadId() === '__new__' ? null : threadId(),
        newLabel: newLabel(),
        prompt: prompt()
      })
      const res = await props.api.assign(body)
      setAssigned(res)
      props.onChanged()
    })

  // ── Add to stream ──
  const [streamPick, setStreamPick] = createSignal('')
  const addToStream = () =>
    run(async () => {
      if (!streamPick()) return
      await props.api.addMember(streamPick(), n().id)
      setStreamPick('')
      props.onChanged()
    })
  const removeFromStream = (id: string) =>
    run(async () => {
      await props.api.removeMember(id, n().id)
      props.onChanged()
    })

  const edgeAction = (e: WorkEdge, accept: boolean) =>
    run(async () => {
      if (accept) await props.api.acceptEdge(e)
      else await props.api.deleteEdge(e)
      props.onChanged()
    })

  return (
    <div
      data-testid="forge-card"
      class="flex max-h-full w-[360px] flex-col overflow-hidden rounded-lg border shadow-xl"
      style={{ background: 'var(--c-bg-raised)', 'border-color': 'var(--c-border)', color: 'var(--c-text)' }}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div class="flex items-start gap-2 border-b px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
        <span class="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: STATE_COLORS[n().state] }} />
        <div class="min-w-0 flex-1">
          <div class="text-[11px]" style={muted}>
            {kindLabel(n())}
            <Show when={n().repo}> · {n().repo}</Show>
            <Show when={n().number !== undefined}> #{n().number}</Show> ·{' '}
            <span data-testid="forge-card-state">{n().state}</span>
          </div>
          <div class="text-sm leading-snug font-semibold" data-testid="forge-card-title">
            {n().title}
          </div>
        </div>
        <button class="shrink-0 px-1 text-lg leading-none" style={muted} onClick={props.onClose} title="Close (Esc)">
          ×
        </button>
      </div>

      <div class="overflow-y-auto px-3 pb-3 text-xs">
        <Show when={n().url}>
          <a
            href={n().url}
            target="_blank"
            rel="noopener noreferrer"
            class="mt-2 inline-block underline"
            style={{ color: 'var(--c-accent)' }}
            data-testid="forge-card-github"
          >
            Open on {n().forge === 'github' ? 'GitHub' : n().forge} ↗
          </a>
        </Show>

        <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <Show when={n().branch}>
            {(b) => (
              <>
                <dt style={muted}>Branch</dt>
                <dd class="break-all">
                  {b().head} → {b().base}
                  <Show when={b().ahead !== undefined || b().behind !== undefined}>
                    <span style={muted}>
                      {' '}
                      (+{b().ahead ?? 0} / −{b().behind ?? 0})
                    </span>
                  </Show>
                  <Show when={b().conflict}>
                    <span class="ml-1 font-semibold" style={{ color: '#ef4444' }}>
                      conflict
                    </span>
                  </Show>
                </dd>
              </>
            )}
          </Show>
          <Show when={n().author}>
            <dt style={muted}>Author</dt>
            <dd>{n().author}</dd>
          </Show>
          <Show when={n().assignees.length}>
            <dt style={muted}>Assignees</dt>
            <dd>{n().assignees.join(', ')}</dd>
          </Show>
          <Show when={n().reviewers.length}>
            <dt style={muted}>Reviewers</dt>
            <dd class="flex flex-wrap gap-1">
              <For each={n().reviewers}>
                {(r) => (
                  <span
                    class="rounded px-1"
                    style={{ border: `1px solid ${REVIEW_COLORS[r.state]}`, color: REVIEW_COLORS[r.state] }}
                  >
                    {r.login}: {r.state.replace('_', ' ')}
                  </span>
                )}
              </For>
            </dd>
          </Show>
          <Show when={n().ci && n().ci !== 'none'}>
            <dt style={muted}>CI</dt>
            <dd style={{ color: CI_COLORS[n().ci!] ?? undefined }}>{n().ci}</dd>
          </Show>
          <Show when={n().labels.length}>
            <dt style={muted}>Labels</dt>
            <dd class="flex flex-wrap gap-1">
              <For each={n().labels}>
                {(l) => (
                  <span class="rounded px-1" style={{ background: 'var(--c-bg)' }}>
                    {l}
                  </span>
                )}
              </For>
            </dd>
          </Show>
          <dt style={muted}>Updated</dt>
          <dd>{new Date(n().updatedAt).toLocaleString()}</dd>
          <Show when={n().closedAt}>
            <dt style={muted}>Closed</dt>
            <dd>{new Date(n().closedAt!).toLocaleString()}</dd>
          </Show>
        </dl>

        <Show when={groups().length}>
          <div class={sectionTitle} style={muted}>
            Linked
          </div>
          <For each={groups()}>
            {(g) => (
              <div class="mb-1">
                <div style={muted}>{g.label}</div>
                <For each={g.items}>
                  {(item) => (
                    <div class="flex items-center gap-1">
                      <button
                        class="min-w-0 flex-1 truncate text-left hover:underline"
                        style={{ color: item.node ? 'var(--c-accent)' : 'var(--c-text-muted)' }}
                        disabled={!item.node}
                        title={item.edge.reason ?? (item.node ? 'Focus' : 'Not loaded')}
                        onClick={() => props.onFocus(item.id)}
                        data-testid="forge-card-link"
                      >
                        {item.node
                          ? `${shortRef(item.node)} ${item.node.number !== undefined ? item.node.title : ''}`
                          : item.id}
                      </button>
                      <Show when={item.edge.kind === 'related' && item.edge.source === 'rethink'}>
                        <button
                          class={btn}
                          style={btnStyle}
                          disabled={busy()}
                          title="Keep this link"
                          onClick={() => edgeAction(item.edge, true)}
                        >
                          ✓
                        </button>
                        <button
                          class={btn}
                          style={btnStyle}
                          disabled={busy()}
                          title="Delete this link"
                          onClick={() => edgeAction(item.edge, false)}
                        >
                          ✕
                        </button>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </Show>

        <div class={sectionTitle} style={muted}>
          Task
        </div>
        <Show
          when={n().taskId}
          fallback={<div style={muted}>No task yet — assigning or adding to a stream creates one.</div>}
        >
          <div>
            State: {n().state}
            <Show when={n().status}>
              <span style={muted}> · {n().status}</span>
            </Show>
          </div>
        </Show>
        <Show when={task().children.length}>
          <div class="mt-1" style={muted}>
            Child tasks
          </div>
          <For each={task().children}>
            {(c) => (
              <button
                class="block truncate text-left hover:underline"
                style={{ color: 'var(--c-accent)' }}
                onClick={() => props.onFocus(c.id)}
              >
                {shortRef(c)} {c.number !== undefined ? c.title : ''}
              </button>
            )}
          </For>
        </Show>
        <div class="mt-1 flex flex-wrap items-center gap-1">
          <For each={task().streams}>
            {(s) => (
              <span class="inline-flex items-center gap-1 rounded px-1.5" style={{ background: 'var(--c-bg)' }}>
                ◆ {s.name}
                <button
                  style={muted}
                  title="Remove from stream"
                  disabled={busy()}
                  onClick={() => removeFromStream(s.id)}
                >
                  ×
                </button>
              </span>
            )}
          </For>
        </div>
        <Show when={task().addable.length}>
          <div class="mt-1 flex gap-1">
            <select
              class="min-w-0 flex-1 rounded border px-1 py-0.5 text-xs"
              style={btnStyle}
              value={streamPick()}
              onChange={(e) => setStreamPick(e.currentTarget.value)}
              data-testid="forge-card-stream-pick"
            >
              <option value="">Add to stream…</option>
              <For each={task().addable}>{(s) => <option value={s.id}>{s.name}</option>}</For>
            </select>
            <button class={btn} style={btnStyle} disabled={!streamPick() || busy()} onClick={addToStream}>
              Add
            </button>
          </div>
        </Show>

        <div class={sectionTitle} style={muted}>
          Agent
        </div>
        <div data-testid="forge-card-agent">
          <Show when={props.overlay?.thread} fallback={<span style={muted}>{agent().label}</span>}>
            {(t) => (
              <div>
                <button
                  class="hover:underline"
                  style={{ color: 'var(--c-accent)' }}
                  onClick={() => props.onOpenThread(t().id)}
                  data-testid="forge-card-thread"
                >
                  {t().label}
                </button>
                <span style={muted}> · {agent().label}</span>
              </div>
            )}
          </Show>
          <Show when={props.overlay?.subagents.length}>
            <For each={props.overlay!.subagents}>
              {(s) => (
                <div style={muted}>
                  ↳ {s.label} <span>({Math.max(0, Math.round((Date.now() - s.startedAt) / 60000))} min)</span>
                </div>
              )}
            </For>
          </Show>
          <Show when={props.overlay?.ciWatch}>
            {(c) => (
              <div style={muted}>
                CI watch: {c().state} since {new Date(c().since).toLocaleTimeString()}
              </div>
            )}
          </Show>
        </div>

        <Show
          when={assignOpen()}
          fallback={
            <button class={`${btn} mt-2`} style={btnStyle} onClick={openAssign} data-testid="forge-assign-open">
              Assign to a thread…
            </button>
          }
        >
          <div class="mt-2 flex flex-col gap-1 rounded border p-2" style={{ 'border-color': 'var(--c-border)' }}>
            <select
              class="rounded border px-1 py-0.5 text-xs"
              style={btnStyle}
              value={threadId()}
              onChange={(e) => setThreadId(e.currentTarget.value)}
              data-testid="forge-assign-thread"
            >
              <option value="__new__">New thread</option>
              <For each={choices()}>{(t) => <option value={t.id}>{t.label || t.id}</option>}</For>
            </select>
            <Show when={threadId() === '__new__'}>
              <input
                class="rounded border px-1 py-0.5 text-xs"
                style={btnStyle}
                value={newLabel()}
                onInput={(e) => setNewLabel(e.currentTarget.value)}
                placeholder="Thread label"
                data-testid="forge-assign-label"
              />
            </Show>
            <textarea
              class="h-24 resize-y rounded border px-1 py-0.5 text-xs"
              style={btnStyle}
              value={prompt()}
              onInput={(e) => setPrompt(e.currentTarget.value)}
              placeholder="Prompt (optional)"
              data-testid="forge-assign-prompt"
            />
            <div class="flex gap-1">
              <button
                class={btn}
                style={{ ...btnStyle, background: 'var(--c-accent)', color: 'var(--c-text-on-accent, #fff)' }}
                disabled={busy() || (threadId() === '__new__' && !newLabel().trim())}
                onClick={send}
                data-testid="forge-assign-send"
              >
                Send
              </button>
              <button class={btn} style={btnStyle} onClick={() => setAssignOpen(false)}>
                Cancel
              </button>
            </div>
            <Show when={assigned()}>
              {(a) => (
                <div data-testid="forge-assign-done">
                  Assigned.{' '}
                  <button
                    class="underline"
                    style={{ color: 'var(--c-accent)' }}
                    onClick={() => props.onOpenThread(a().threadId)}
                  >
                    Open thread
                  </button>
                </div>
              )}
            </Show>
          </div>
        </Show>

        <Show when={notes().length}>
          <div class={sectionTitle} style={muted}>
            Rethink notes
          </div>
          <For each={notes()}>
            {(item) => {
              const o = item.otherId ? props.nodesById.get(item.otherId) : undefined
              return (
                <div class="mb-1" data-testid="forge-card-rethink-note">
                  <span style={{ color: '#a855f7' }}>{item.tag}</span>
                  <Show when={item.otherId}> → {o ? shortRef(o) : item.otherId}</Show>
                  <Show when={item.confidence !== undefined}>
                    <span style={muted}> ({Math.round((item.confidence ?? 0) * 100)}%)</span>
                  </Show>
                  <Show when={item.at}>
                    <span style={muted}> · {new Date(item.at!).toLocaleString()}</span>
                  </Show>
                  <Show when={item.text}>
                    <div style={muted}>{item.text}</div>
                  </Show>
                </div>
              )
            }}
          </For>
        </Show>

        <Show when={error()}>
          <div class="mt-2" style={{ color: 'var(--c-error, #ef4444)' }} data-testid="forge-card-error">
            {error()}
          </div>
        </Show>
      </div>
    </div>
  )
}

export default NodeCard
