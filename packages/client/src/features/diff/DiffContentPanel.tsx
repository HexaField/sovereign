import { createResource, createSignal, createMemo, Show, For } from 'solid-js'
import { threadKey } from '../threads/store.js'
import {
  selectedFile,
  setSelectedFile,
  selectedRepo,
  selectedCommit,
  setSelectedCommit,
  diffViewMode,
  setDiffViewMode,
  fetchGitContext,
  fetchFileDiff,
  type ThreadGitContext,
  type DiffViewMode
} from './store.js'
import {
  parseDiff,
  countAdditions,
  countDeletions,
  type ParsedDiffFile,
  type DiffHunk,
  type DiffLine
} from './diff-parser.js'
import { highlightLine, preloadHighlighter } from './highlight.js'

// ── Helpers ──────────────────────────────────────────────────────────────

function lineBg(type: string): string {
  switch (type) {
    case 'add':
      return 'rgba(34, 197, 94, 0.12)'
    case 'del':
      return 'rgba(239, 68, 68, 0.12)'
    default:
      return 'transparent'
  }
}

function lineGutterBg(type: string): string {
  switch (type) {
    case 'add':
      return 'rgba(34, 197, 94, 0.22)'
    case 'del':
      return 'rgba(239, 68, 68, 0.22)'
    default:
      return 'transparent'
  }
}

function contextFileCount(ctx: ThreadGitContext): number {
  return ctx.files?.length ?? 0
}

// ── Split-view line pairing ──────────────────────────────────────────────

export interface SplitLinePair {
  left: DiffLine | null
  right: DiffLine | null
}

export function pairLinesForSplit(lines: DiffLine[]): SplitLinePair[] {
  const pairs: SplitLinePair[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.type === 'context' || line.type === 'header') {
      pairs.push({ left: line, right: line })
      i++
      continue
    }

    const dels: DiffLine[] = []
    while (i < lines.length && lines[i].type === 'del') {
      dels.push(lines[i])
      i++
    }

    const adds: DiffLine[] = []
    while (i < lines.length && lines[i].type === 'add') {
      adds.push(lines[i])
      i++
    }

    const maxLen = Math.max(dels.length, adds.length)
    for (let j = 0; j < maxLen; j++) {
      pairs.push({
        left: j < dels.length ? dels[j] : null,
        right: j < adds.length ? adds[j] : null
      })
    }
  }

  return pairs
}

// ── Main component ───────────────────────────────────────────────────────

export function DiffContentPanel() {
  const [collapsedFiles, setCollapsedFiles] = createSignal<Set<string>>(new Set())

  const toggleFileCollapsed = (filePath: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(filePath)) next.delete(filePath)
      else next.add(filePath)
      return next
    })
  }

  preloadHighlighter()

  const [contexts] = createResource(threadKey, async (tid) => {
    if (!tid) return null
    return fetchGitContext(tid)
  })

  const sortedContexts = createMemo<ThreadGitContext[]>(() => {
    const ctxs = contexts()
    if (!ctxs?.length) return []
    return [...ctxs].sort((a, b) => contextFileCount(b) - contextFileCount(a))
  })

  const activeContext = createMemo<ThreadGitContext | null>(() => {
    const ctxs = sortedContexts()
    if (!ctxs.length) return null
    const sel = selectedRepo()
    return ctxs.find((c) => c.repoRoot === sel) ?? ctxs[0]
  })

  const [commitFullDiff] = createResource(
    () => {
      const tid = threadKey()
      const ctx = activeContext()
      const commit = selectedCommit()
      if (!tid || !ctx || !commit) return null
      return { threadId: tid, repo: ctx.repoRoot, commit }
    },
    async (params) => {
      if (!params) return null
      return fetchFileDiff(params.threadId, params.repo, undefined, params.commit)
    }
  )

  const commitFiles = createMemo(() => {
    if (!selectedCommit()) return null
    const raw = commitFullDiff()
    if (!raw) return null
    const parsed = parseDiff(raw)
    return parsed.map((f) => ({
      path: f.to,
      additions: countAdditions(f),
      deletions: countDeletions(f)
    }))
  })

  const displayFiles = createMemo(() => commitFiles() ?? activeContext()?.files ?? [])

  const [diffContent] = createResource(
    () => {
      const tid = threadKey()
      const ctx = activeContext()
      if (!tid || !ctx) return null
      return {
        threadId: tid,
        repo: ctx.repoRoot,
        file: selectedFile() ?? undefined,
        commit: selectedCommit() ?? undefined
      }
    },
    async (params) => {
      if (!params) return null
      return fetchFileDiff(params.threadId, params.repo, params.file, params.commit)
    }
  )

  const parsedDiff = createMemo<ParsedDiffFile[]>(() => {
    const raw = diffContent()
    if (!raw) return []
    return parseDiff(raw)
  })

  const totalFiles = createMemo(() => displayFiles().length)

  const totalStats = createMemo(() => {
    const files = displayFiles()
    let adds = 0
    let dels = 0
    for (const f of files) {
      adds += f.additions
      dels += f.deletions
    }
    return { additions: adds, deletions: dels }
  })

  const viewLabel = createMemo(() => {
    const commit = selectedCommit()
    if (commit === 'uncommitted') return 'Uncommitted'
    if (commit) return `Commit ${commit.slice(0, 7)}`
    return 'Branch diff'
  })

  return (
    <div class="flex h-full flex-col overflow-hidden" style={{ background: 'var(--c-bg)' }}>
      {/* Header bar — stats + controls */}
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '10px',
          padding: '6px 12px',
          'border-bottom': '1px solid var(--c-border)',
          'flex-shrink': '0',
          'flex-wrap': 'wrap'
        }}
      >
        <Show when={selectedCommit()}>
          <span
            style={{
              background: 'rgba(234, 179, 8, 0.15)',
              color: '#eab308',
              padding: '2px 8px',
              'border-radius': '10px',
              'font-size': '11px',
              'font-family': 'monospace'
            }}
          >
            {viewLabel()}
          </span>
        </Show>

        <ViewModeToggle />

        <div style={{ 'margin-left': 'auto', display: 'flex', 'align-items': 'center', gap: '10px' }}>
          <span style={{ 'font-size': '11px', color: 'var(--c-text-muted)' }}>
            {totalFiles()} file{totalFiles() !== 1 ? 's' : ''}
          </span>
          <Show when={totalStats().additions > 0}>
            <span style={{ 'font-size': '11px', color: '#22c55e' }}>+{totalStats().additions}</span>
          </Show>
          <Show when={totalStats().deletions > 0}>
            <span style={{ 'font-size': '11px', color: '#ef4444' }}>−{totalStats().deletions}</span>
          </Show>
          <Show when={selectedFile() || selectedCommit()}>
            <button
              onClick={() => {
                setSelectedFile(null)
                setSelectedCommit(null)
              }}
              style={{
                background: 'var(--c-hover-bg)',
                border: '1px solid var(--c-border)',
                color: 'var(--c-text)',
                padding: '2px 8px',
                'border-radius': '6px',
                cursor: 'pointer',
                'font-size': '11px'
              }}
            >
              View all
            </button>
          </Show>
        </div>
      </div>

      {/* Diff content */}
      <div class="flex-1 overflow-auto">
        <Show when={contexts.loading || diffContent.loading}>
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
              padding: '40px',
              color: 'var(--c-text-muted)'
            }}
          >
            Loading…
          </div>
        </Show>

        <Show when={!contexts.loading && !diffContent.loading && totalFiles() === 0}>
          <div
            style={{
              display: 'flex',
              'align-items': 'center',
              'justify-content': 'center',
              padding: '40px',
              color: 'var(--c-text-muted)',
              'flex-direction': 'column',
              gap: '8px'
            }}
          >
            <span style={{ 'font-size': '32px' }}>∅</span>
            <span>No changes{activeContext() ? ` in ${activeContext()!.repoName}` : ''}</span>
          </div>
        </Show>

        <Show when={!diffContent.loading && parsedDiff().length > 0}>
          <div style={{ 'font-family': "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace" }}>
            <For each={parsedDiff()}>
              {(file) => (
                <div style={{ 'margin-bottom': '2px' }}>
                  <div
                    onClick={() => toggleFileCollapsed(file.to)}
                    style={{
                      padding: '8px 16px',
                      background: 'var(--c-bg-raised)',
                      'border-bottom': '1px solid var(--c-border)',
                      'border-top': '1px solid var(--c-border)',
                      display: 'flex',
                      'align-items': 'center',
                      gap: '8px',
                      position: 'sticky',
                      top: '0',
                      'z-index': '10',
                      cursor: 'pointer',
                      'user-select': 'none'
                    }}
                  >
                    <span
                      style={{
                        color: 'var(--c-text-muted)',
                        'font-size': '10px',
                        width: '12px',
                        'flex-shrink': '0',
                        transition: 'transform 0.15s ease',
                        transform: collapsedFiles().has(file.to) ? 'rotate(-90deg)' : 'rotate(0)'
                      }}
                    >
                      ▾
                    </span>
                    <Show when={file.binary}>
                      <span
                        style={{
                          background: 'rgba(107, 114, 128, 0.2)',
                          padding: '1px 6px',
                          'border-radius': '4px',
                          'font-size': '10px',
                          color: 'var(--c-text-muted)'
                        }}
                      >
                        BINARY
                      </span>
                    </Show>
                    <Show when={file.renamed}>
                      <span style={{ color: '#a78bfa', 'font-size': '12px' }}>
                        {file.from} → {file.to}
                      </span>
                    </Show>
                    <Show when={!file.renamed}>
                      <span style={{ 'font-size': '12px', color: 'var(--c-text)' }}>{file.to}</span>
                    </Show>
                  </div>

                  <Show when={!collapsedFiles().has(file.to)}>
                    <Show when={!file.binary}>
                      <Show
                        when={diffViewMode() === 'unified'}
                        fallback={<SplitDiffFileView hunks={file.hunks} filePath={file.to} />}
                      >
                        <For each={file.hunks}>
                          {(hunk) => (
                            <div>
                              <div
                                style={{
                                  padding: '4px 16px',
                                  background: 'rgba(99, 102, 241, 0.06)',
                                  color: 'var(--c-text-muted)',
                                  'font-size': '11px',
                                  'border-bottom': '1px solid var(--c-border)'
                                }}
                              >
                                @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@ {hunk.header}
                              </div>
                              <For each={hunk.lines}>
                                {(line: DiffLine) => <UnifiedLineRow line={line} filePath={file.to} />}
                              </For>
                            </div>
                          )}
                        </For>
                      </Show>
                    </Show>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={!diffContent.loading && parsedDiff().length === 0 && totalFiles() > 0 && !!diffContent()}>
          <div style={{ padding: '40px', 'text-align': 'center', color: 'var(--c-text-muted)' }}>
            No diff content (file may have only whitespace changes)
          </div>
        </Show>
      </div>

      <style>{`
        .hljs-keyword, .hljs-selector-tag { color: #c586c0; }
        .hljs-built_in { color: #4ec9b0; }
        .hljs-type, .hljs-title.class_ { color: #4ec9b0; }
        .hljs-title.function_ { color: #dcdcaa; }
        .hljs-string, .hljs-template-variable { color: #ce9178; }
        .hljs-number, .hljs-literal { color: #b5cea8; }
        .hljs-comment, .hljs-quote { color: #6a9955; font-style: italic; }
        .hljs-regexp { color: #d16969; }
        .hljs-variable, .hljs-attr { color: #9cdcfe; }
        .hljs-params { color: #9cdcfe; }
        .hljs-meta, .hljs-meta .hljs-keyword { color: #569cd6; }
        .hljs-tag { color: #808080; }
        .hljs-name, .hljs-selector-id, .hljs-selector-class { color: #569cd6; }
        .hljs-attribute { color: #9cdcfe; }
        .hljs-symbol, .hljs-bullet { color: #b5cea8; }
        .hljs-addition { color: #22c55e; }
        .hljs-deletion { color: #ef4444; }
        .hljs-operator { color: #d4d4d4; }
        .hljs-punctuation { color: #d4d4d4; }
        .hljs-property { color: #9cdcfe; }
        .hljs-title { color: #dcdcaa; }
        .hljs-section { color: #569cd6; }
        .hljs-subst { color: #d4d4d4; }
      `}</style>
    </div>
  )
}

// ── View mode toggle ─────────────────────────────────────────────────────

function ViewModeToggle() {
  const mode = diffViewMode
  const toggle = (m: DiffViewMode) => setDiffViewMode(m)

  const btnStyle = (active: boolean) => ({
    padding: '2px 8px',
    'border-radius': '4px',
    border: 'none',
    background: active ? 'var(--c-accent)' : 'transparent',
    color: active ? '#fff' : 'var(--c-text-muted)',
    cursor: 'pointer',
    'font-size': '11px',
    'font-weight': active ? '600' : '400',
    transition: 'all 0.15s ease'
  })

  return (
    <div
      style={{
        display: 'inline-flex',
        'align-items': 'center',
        gap: '2px',
        background: 'var(--c-bg)',
        'border-radius': '6px',
        padding: '2px',
        border: '1px solid var(--c-border)'
      }}
    >
      <button onClick={() => toggle('unified')} style={btnStyle(mode() === 'unified')} title="Unified diff view">
        Unified
      </button>
      <button onClick={() => toggle('split')} style={btnStyle(mode() === 'split')} title="Side-by-side diff view">
        Split
      </button>
    </div>
  )
}

// ── Unified line row ─────────────────────────────────────────────────────

function UnifiedLineRow(props: { line: DiffLine; filePath: string }) {
  const prefix = () => {
    switch (props.line.type) {
      case 'add':
        return '+'
      case 'del':
        return '-'
      case 'header':
        return ''
      default:
        return ' '
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        background: lineBg(props.line.type),
        'font-size': '12px',
        'line-height': '20px',
        'white-space': 'pre',
        'overflow-x': 'auto'
      }}
    >
      <span
        style={{
          width: '48px',
          'min-width': '48px',
          'text-align': 'right',
          'padding-right': '8px',
          color: 'var(--c-text-muted)',
          'user-select': 'none',
          background: lineGutterBg(props.line.type),
          'font-size': '11px',
          opacity: '0.7'
        }}
      >
        {props.line.oldLine ?? ''}
      </span>
      <span
        style={{
          width: '48px',
          'min-width': '48px',
          'text-align': 'right',
          'padding-right': '8px',
          color: 'var(--c-text-muted)',
          'user-select': 'none',
          background: lineGutterBg(props.line.type),
          'font-size': '11px',
          opacity: '0.7'
        }}
      >
        {props.line.newLine ?? ''}
      </span>
      <span
        style={{
          width: '16px',
          'min-width': '16px',
          'text-align': 'center',
          color: props.line.type === 'add' ? '#22c55e' : props.line.type === 'del' ? '#ef4444' : 'var(--c-text-muted)',
          'user-select': 'none',
          'font-weight': '700'
        }}
      >
        {prefix()}
      </span>
      <span style={{ 'padding-right': '16px' }} innerHTML={highlightLine(props.line.content, props.filePath)} />
    </div>
  )
}

// ── Split (side-by-side) view ────────────────────────────────────────────

function SplitDiffFileView(props: { hunks: DiffHunk[]; filePath: string }) {
  return (
    <For each={props.hunks}>
      {(hunk) => {
        const pairs = createMemo(() => pairLinesForSplit(hunk.lines))
        return (
          <div>
            <div
              style={{
                padding: '4px 16px',
                background: 'rgba(99, 102, 241, 0.06)',
                color: 'var(--c-text-muted)',
                'font-size': '11px',
                'border-bottom': '1px solid var(--c-border)'
              }}
            >
              @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@ {hunk.header}
            </div>
            <div style={{ display: 'flex' }}>
              <div style={{ flex: '1', 'min-width': '0', 'border-right': '1px solid var(--c-border)' }}>
                <For each={pairs()}>
                  {(pair) => <SplitHalfRow line={pair.left} side="old" filePath={props.filePath} />}
                </For>
              </div>
              <div style={{ flex: '1', 'min-width': '0' }}>
                <For each={pairs()}>
                  {(pair) => <SplitHalfRow line={pair.right} side="new" filePath={props.filePath} />}
                </For>
              </div>
            </div>
          </div>
        )
      }}
    </For>
  )
}

function SplitHalfRow(props: { line: DiffLine | null; side: 'old' | 'new'; filePath: string }) {
  if (!props.line) {
    return (
      <div
        style={{
          display: 'flex',
          'font-size': '12px',
          'line-height': '20px',
          'white-space': 'pre',
          background: 'rgba(107, 114, 128, 0.04)',
          'min-height': '20px'
        }}
      >
        <span
          style={{
            width: '40px',
            'min-width': '40px',
            'text-align': 'right',
            'padding-right': '8px',
            'user-select': 'none',
            'font-size': '11px'
          }}
        />
        <span style={{ flex: '1' }} />
      </div>
    )
  }

  const lineNum = () => (props.side === 'old' ? props.line!.oldLine : props.line!.newLine)
  const type = () => props.line!.type
  const bg = () => {
    const t = type()
    if (t === 'add') return lineBg('add')
    if (t === 'del') return lineBg('del')
    return 'transparent'
  }

  return (
    <div
      style={{
        display: 'flex',
        background: bg(),
        'font-size': '12px',
        'line-height': '20px',
        'white-space': 'pre',
        'overflow-x': 'auto'
      }}
    >
      <span
        style={{
          width: '40px',
          'min-width': '40px',
          'text-align': 'right',
          'padding-right': '8px',
          color: 'var(--c-text-muted)',
          'user-select': 'none',
          background: lineGutterBg(type()),
          'font-size': '11px',
          opacity: '0.7'
        }}
      >
        {lineNum() ?? ''}
      </span>
      <span
        style={{ 'padding-right': '8px', 'padding-left': '4px' }}
        innerHTML={highlightLine(props.line!.content, props.filePath)}
      />
    </div>
  )
}
