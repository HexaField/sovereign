// Pinned Recipes dropdown panel
import { createSignal, Show, For, onMount, onCleanup, createEffect } from 'solid-js'
import { Portal } from 'solid-js/web'
import {
  recipes,
  reloadRecipes,
  addRecipe,
  removeRecipe,
  updateRecipe,
  executeRecipeStreaming,
  type Recipe,
  type StreamingExecution
} from './store.js'

// ── Recipe Button (sits in header) ───────────────────────────────────

export function RecipeButton() {
  const [open, setOpen] = createSignal(false)
  let containerRef!: HTMLDivElement
  let dropdownRef!: HTMLDivElement

  const toggle = () => {
    const next = !open()
    setOpen(next)
    if (next) reloadRecipes()
  }

  // Close on click outside
  const handleClickOutside = (e: MouseEvent) => {
    if (
      containerRef &&
      !containerRef.contains(e.target as Node) &&
      (!dropdownRef || !dropdownRef.contains(e.target as Node))
    ) {
      setOpen(false)
    }
  }

  onMount(() => document.addEventListener('mousedown', handleClickOutside))
  onCleanup(() => document.removeEventListener('mousedown', handleClickOutside))

  // Position dropdown relative to button
  createEffect(() => {
    if (!open()) return
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!dropdownRef || !containerRef) return
        const btn = containerRef.querySelector('button')
        if (!btn) return
        const r = btn.getBoundingClientRect()
        const dropW = 360
        let left = r.right - dropW
        if (left < 8) left = 8
        if (left + dropW > window.innerWidth - 8) left = window.innerWidth - dropW - 8
        let top = r.bottom + 4
        if (top + dropdownRef.offsetHeight > window.innerHeight - 8) {
          top = r.top - dropdownRef.offsetHeight - 4
        }
        dropdownRef.style.left = `${left}px`
        dropdownRef.style.top = `${top}px`
      })
    )
  })

  return (
    <div ref={containerRef} style={{ position: 'relative', 'z-index': '50' }}>
      <button
        onClick={toggle}
        class="flex cursor-pointer items-center justify-center rounded border-none transition-colors"
        style={{
          width: '24px',
          height: '24px',
          background: open() ? 'var(--c-bg-tertiary, var(--c-hover-bg))' : 'transparent',
          color: 'var(--c-text-muted)',
          'font-size': '14px',
          padding: '0'
        }}
        onMouseEnter={(e) => {
          if (!open()) e.currentTarget.style.background = 'var(--c-bg-tertiary, var(--c-hover-bg))'
        }}
        onMouseLeave={(e) => {
          if (!open()) e.currentTarget.style.background = 'transparent'
        }}
        title="Pinned Recipes"
      >
        🧁
      </button>

      <Show when={open()}>
        <Portal>
          <div
            ref={dropdownRef}
            class="rounded-xl shadow-2xl"
            style={{
              position: 'fixed',
              'z-index': '999',
              width: '360px',
              background: 'var(--c-bg-raised)',
              border: '1px solid var(--c-border)',
              'max-height': '500px',
              'overflow-y': 'auto',
              left: '-9999px',
              top: '-9999px'
            }}
          >
            {/* Header */}
            <div
              style={{
                padding: '10px 14px 8px',
                'border-bottom': '1px solid var(--c-border)',
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'space-between'
              }}
            >
              <span class="text-sm font-semibold" style={{ color: 'var(--c-text-heading)' }}>
                Pinned Recipes
              </span>
              <span class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                {recipes().length} saved
              </span>
            </div>

            {/* Recipe List */}
            <div style={{ padding: '6px' }}>
              <Show
                when={recipes().length > 0}
                fallback={
                  <div class="text-center text-xs" style={{ color: 'var(--c-text-muted)', padding: '16px 8px' }}>
                    No recipes yet. Add one below.
                  </div>
                }
              >
                <For each={recipes()}>{(recipe) => <RecipeItem recipe={recipe} />}</For>
              </Show>
            </div>

            {/* Add button */}
            <div style={{ padding: '6px 6px 8px', 'border-top': '1px solid var(--c-border)' }}>
              <button
                class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition-colors"
                style={{ color: 'var(--c-accent)', background: 'transparent', border: 'none', cursor: 'pointer' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                onClick={() => addRecipe()}
              >
                <span>+</span>
                <span>Add Recipe</span>
              </button>
            </div>
          </div>
        </Portal>
      </Show>
    </div>
  )
}

// ── Single recipe row ────────────────────────────────────────────────

function RecipeItem(props: { recipe: Recipe }) {
  const [expanded, setExpanded] = createSignal(false)
  const [running, setRunning] = createSignal(false)
  const [logLines, setLogLines] = createSignal<{ type: 'stdout' | 'stderr'; text: string }[]>([])
  const [exitCode, setExitCode] = createSignal<number | null>(null)
  let executionRef: StreamingExecution | null = null
  let logContainerRef: HTMLDivElement | undefined

  // Auto-scroll log to bottom
  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      if (logContainerRef) {
        logContainerRef.scrollTop = logContainerRef.scrollHeight
      }
    })
  }

  const run = () => {
    setRunning(true)
    setLogLines([])
    setExitCode(null)
    setExpanded(true)

    executionRef = executeRecipeStreaming(props.recipe, {
      onStdout: (text) => {
        setLogLines((prev) => [...prev, { type: 'stdout', text }])
        scrollToBottom()
      },
      onStderr: (text) => {
        setLogLines((prev) => [...prev, { type: 'stderr', text }])
        scrollToBottom()
      },
      onExit: (code) => {
        setExitCode(code)
        setRunning(false)
        executionRef = null
      },
      onError: (message) => {
        setLogLines((prev) => [...prev, { type: 'stderr', text: message }])
        setRunning(false)
        executionRef = null
        scrollToBottom()
      }
    })
  }

  const stop = () => {
    if (executionRef) {
      executionRef.abort()
      executionRef = null
    }
  }

  onCleanup(() => {
    // Kill running process when component unmounts
    if (executionRef) {
      executionRef.abort()
    }
  })

  return (
    <div
      class="mb-1 rounded-lg"
      style={{
        background: 'var(--c-bg)',
        border: '1px solid var(--c-border)'
      }}
    >
      {/* Collapsed row */}
      <div class="flex items-center gap-2" style={{ padding: '6px 8px' }}>
        <button
          class="min-w-0 flex-1 truncate text-left text-xs font-medium transition-colors"
          style={{
            color: 'var(--c-text)',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: '0'
          }}
          onClick={() => setExpanded(!expanded())}
          title={expanded() ? 'Collapse' : 'Expand to edit'}
        >
          {props.recipe.name || 'Untitled'}
        </button>

        <button
          class="shrink-0 rounded px-2 py-0.5 text-xs font-medium transition-colors"
          style={{
            color: '#fff',
            background: running() ? 'var(--c-danger, #ef4444)' : 'var(--c-accent)',
            border: 'none',
            cursor: 'pointer'
          }}
          onClick={() => (running() ? stop() : run())}
        >
          {running() ? '■' : '▶'}
        </button>

        <button
          class="shrink-0 rounded px-1.5 py-0.5 text-xs transition-colors"
          style={{
            color: 'var(--c-text-muted)',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer'
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--c-danger, #ef4444)')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--c-text-muted)')}
          onClick={() => removeRecipe(props.recipe.id)}
          title="Delete recipe"
        >
          ✕
        </button>
      </div>

      {/* Expanded editor */}
      <Show when={expanded()}>
        <div style={{ padding: '0 8px 8px', display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
          {/* Name */}
          <input
            class="w-full rounded border px-2 py-1 text-xs outline-none"
            style={{
              background: 'var(--c-bg-raised)',
              'border-color': 'var(--c-border)',
              color: 'var(--c-text)'
            }}
            value={props.recipe.name}
            onInput={(e) => updateRecipe(props.recipe.id, { name: e.currentTarget.value })}
            placeholder="Recipe name"
          />

          {/* Script */}
          <textarea
            class="w-full rounded border px-2 py-1 text-xs outline-none"
            style={{
              background: 'var(--c-bg-raised)',
              'border-color': 'var(--c-border)',
              color: 'var(--c-text)',
              'font-family': 'monospace',
              'min-height': '60px',
              resize: 'vertical'
            }}
            value={props.recipe.script}
            onInput={(e) => updateRecipe(props.recipe.id, { script: e.currentTarget.value })}
            placeholder="echo 'Hello {{name}}'"
          />

          {/* Params */}
          <Show when={props.recipe.params.length > 0}>
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
              <For each={props.recipe.params}>
                {(param, i) => (
                  <div class="flex items-center gap-2">
                    <label
                      class="shrink-0 text-[10px] font-medium"
                      style={{ color: 'var(--c-text-muted)', width: '60px' }}
                    >
                      {param.label || param.key}
                    </label>
                    <input
                      class="flex-1 rounded border px-2 py-0.5 text-xs outline-none"
                      style={{
                        background: 'var(--c-bg-raised)',
                        'border-color': 'var(--c-border)',
                        color: 'var(--c-text)'
                      }}
                      value={param.value}
                      onInput={(e) => {
                        const updated = [...props.recipe.params]
                        updated[i()] = { ...updated[i()], value: e.currentTarget.value }
                        updateRecipe(props.recipe.id, { params: updated })
                      }}
                    />
                    <button
                      class="shrink-0 text-[10px]"
                      style={{
                        color: 'var(--c-text-muted)',
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer'
                      }}
                      onClick={() => {
                        const updated = props.recipe.params.filter((_: unknown, idx: number) => idx !== i())
                        updateRecipe(props.recipe.id, { params: updated })
                      }}
                      title="Remove param"
                    >
                      ✕
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>

          {/* Add param button */}
          <button
            class="flex items-center gap-1 self-start rounded px-2 py-0.5 text-[10px] transition-colors"
            style={{
              color: 'var(--c-accent)',
              background: 'transparent',
              border: '1px dashed var(--c-border)',
              cursor: 'pointer'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            onClick={() => {
              const key = `param${props.recipe.params.length + 1}`
              updateRecipe(props.recipe.id, {
                params: [...props.recipe.params, { key, value: '', label: key }]
              })
            }}
          >
            + Add Param
          </button>

          {/* Run / Stop button (expanded) */}
          <button
            class="flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-colors"
            style={{
              background: running() ? 'var(--c-danger, #ef4444)' : 'var(--c-accent)',
              border: 'none',
              cursor: 'pointer'
            }}
            onClick={() => (running() ? stop() : run())}
          >
            {running() ? (
              <>
                <span>■</span> Stop
              </>
            ) : (
              <>
                <span>▶</span> Run
              </>
            )}
          </button>

          {/* Streaming log area */}
          <Show when={logLines().length > 0 || exitCode() !== null}>
            <div
              ref={logContainerRef}
              class="overflow-auto rounded text-[11px]"
              style={{
                background: 'var(--c-bg)',
                border: '1px solid var(--c-border)',
                padding: '6px 8px',
                'max-height': '200px',
                'font-family': 'monospace',
                'white-space': 'pre-wrap',
                'word-break': 'break-all',
                color: 'var(--c-text)'
              }}
            >
              <For each={logLines()}>
                {(line) => (
                  <div style={{ color: line.type === 'stderr' ? 'var(--c-danger, #ef4444)' : 'inherit' }}>
                    {line.text}
                  </div>
                )}
              </For>
              <Show when={running()}>
                <div class="mt-1 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                  <span style={{ animation: 'pulse 1.5s ease-in-out infinite' }}>●</span> Running…
                </div>
              </Show>
              <Show when={exitCode() !== null}>
                <div
                  class="mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium"
                  style={{
                    background: exitCode() === 0 ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                    color: exitCode() === 0 ? 'rgb(34,197,94)' : 'var(--c-danger, #ef4444)'
                  }}
                >
                  exit {exitCode()}
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}
