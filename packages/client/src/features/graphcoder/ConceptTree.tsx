// The concept map of a checkout (Graphcoder P2): its concept tree as a nested
// outline, each page with the code it owns and the scripted checks on it
// (stale links, claims shared with unrelated pages, names that resolve to no
// symbol), coverage of the indexed files, and what each page's code uses.

import { createMemo, createResource, For, Match, Show, Switch, type Component } from 'solid-js'
import type { ConceptMapReport, ConceptNode } from '@sovereign/graphcoder-core/contract'
import { createGraphcoderApi, type GraphcoderApi } from './api.js'
import { checkText, coverageText, pageChecks, subtreeFiles, usesOf } from './concept-model.js'

const muted = { color: 'var(--c-text-muted)' }
const warn = { color: 'var(--c-warning, #f59e0b)' }
const defaultApi = createGraphcoderApi()

const PageNode: Component<{ report: ConceptMapReport; page: ConceptNode; ctx: Ctx }> = (props) => {
  const p = () => props.page
  const checks = () => props.ctx.checks.get(p().id)
  const uses = () => usesOf(props.report, p().id)
  return (
    <details open={p().depth < 1} data-testid="graphcoder-concept">
      <summary class="cursor-pointer truncate" title={p().file}>
        {p().title}
        <span style={muted}>
          {' '}
          · {props.ctx.files.get(p().id) ?? 0} files{p().symbols ? ` · ${p().symbols} symbols` : ''}
        </span>
        <Show when={checkText(checks())}>{(t) => <span style={warn}> · {t()}</span>}</Show>
      </summary>
      <div class="pl-3">
        <Show when={p().model}>
          <div style={muted} title={p().why ? `Why: ${p().why}` : undefined}>
            {p().model}
          </div>
        </Show>
        <Show when={uses().length}>
          <div class="truncate" style={muted}>
            Uses:{' '}
            {uses()
              .map((u) => `${u.title} (${u.edges})`)
              .join(', ')}
          </div>
        </Show>
        <For each={checks()?.stale ?? []}>{(path) => <div style={warn}>stale link: {path}</div>}</For>
        <For each={checks()?.shared ?? []}>
          {(s) => (
            <div style={warn} title={s.pages.join(', ')}>
              shared: {s.path} ({s.files} files) with{' '}
              {s.pages
                .filter((id) => id !== p().id)
                .map((id) => props.ctx.titles.get(id) ?? id)
                .join(', ')}
            </div>
          )}
        </For>
        <Show when={checks()?.unresolved.length}>
          <div style={warn}>unresolved: {checks()!.unresolved.join(', ')}</div>
        </Show>
        <For
          each={p()
            .children.map((c) => props.ctx.byId.get(c))
            .filter((c): c is ConceptNode => !!c)}
        >
          {(child) => <PageNode report={props.report} page={child} ctx={props.ctx} />}
        </For>
      </div>
    </details>
  )
}

interface Ctx {
  byId: Map<string, ConceptNode>
  titles: Map<string, string>
  files: Map<string, number>
  checks: ReturnType<typeof pageChecks>
}

export const ConceptTree: Component<{ path: string; ref?: string; api?: GraphcoderApi }> = (props) => {
  const api = () => props.api ?? defaultApi
  const [result] = createResource(
    () => JSON.stringify([props.path, props.ref ?? null]),
    (key) => {
      const [path, ref] = JSON.parse(key) as [string, string | null]
      return api().concepts(path, ref ?? undefined)
    }
  )
  const ready = () => {
    const r = result()
    return r?.state === 'ready' ? r.report : undefined
  }
  const ctx = createMemo((): Ctx | undefined => {
    const report = ready()
    if (!report) return undefined
    return {
      byId: new Map(report.pages.map((p) => [p.id, p])),
      titles: new Map(report.pages.map((p) => [p.id, p.title])),
      files: subtreeFiles(report),
      checks: pageChecks(report)
    }
  })

  return (
    <div data-testid="graphcoder-concept-tree">
      <Switch>
        <Match when={result.loading}>
          <div style={muted}>Reading the concept tree…</div>
        </Match>
        <Match when={result()?.state === 'failed'}>
          <div style={warn}>{(result() as { error: string }).error}</div>
        </Match>
        <Match when={ready()}>
          {(report) => (
            <Show
              when={report().pages.length}
              fallback={
                <div style={muted}>
                  No concept tree under {report().dir}/ at {report().sha.slice(0, 8)}.
                </div>
              }
            >
              <div style={muted}>
                {report().dir}/ at {report().sha.slice(0, 8)} · {report().pages.length} pages · coverage{' '}
                {coverageText(report().coverage)}
              </div>
              <Show when={report().stale.length || report().shared.length}>
                <div style={warn}>
                  {report().stale.length} stale links · {report().shared.length} shared claims
                </div>
              </Show>
              <Show when={report().coverage.uncovered.length}>
                <details>
                  <summary class="cursor-pointer" style={muted}>
                    Files no page claims, by directory ({report().coverage.uncovered.length})
                  </summary>
                  <For each={report().coverage.uncovered}>
                    {(u) => (
                      <div class="truncate pl-3">
                        {u.dir} <span style={muted}>· {u.files}</span>
                      </div>
                    )}
                  </For>
                </details>
              </Show>
              <For each={report().pages.filter((p) => p.parent === null)}>
                {(root) => <PageNode report={report()} page={root} ctx={ctx()!} />}
              </For>
            </Show>
          )}
        </Match>
      </Switch>
    </div>
  )
}

export default ConceptTree
