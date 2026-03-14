import { type Component, createSignal, onMount, onCleanup, For, Show, createEffect } from 'solid-js'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { wsStore } from '../../../ws/index.js'
import { activeWorkspace } from '../store.js'

export function getTerminalCwd(orgId: string, projectId: string | null): string {
  if (projectId) return `${orgId}/${projectId}`
  return orgId
}

interface TerminalTab {
  id: string
  name: string
  terminal: Terminal
  fitAddon: FitAddon
}

const TerminalPanel: Component = () => {
  const ws = () => activeWorkspace()
  const [tabs, setTabs] = createSignal<TerminalTab[]>([])
  const [activeTabId, setActiveTabId] = createSignal<string | null>(null)
  let containerRef: HTMLDivElement | undefined
  const cleanups: Array<() => void> = []

  const activeTab = () => tabs().find((t) => t.id === activeTabId())

  const createTerminalSession = async () => {
    const workspace = ws()
    const cwd = workspace?.activeProjectId
      ? `${workspace.orgId}/${workspace.activeProjectId}`
      : (workspace?.orgId ?? undefined)

    try {
      const res = await fetch('/api/terminal/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, cols: 80, rows: 24 })
      })
      if (!res.ok) throw new Error('Failed to create terminal session')
      const session = await res.json()
      return session as { id: string; pid: number; cwd: string; shell: string; cols: number; rows: number }
    } catch (err) {
      console.error('Failed to create terminal session:', err)
      return null
    }
  }

  const addTerminal = async () => {
    const session = await createTerminalSession()
    if (!session) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#e0e0e0',
        selectionBackground: '#3a3a5e'
      }
    })
    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)

    const tabIndex = tabs().length + 1
    const tab: TerminalTab = {
      id: session.id,
      name: `Terminal ${tabIndex}`,
      terminal: term,
      fitAddon
    }

    // Subscribe to terminal channel with sessionId scope
    wsStore.subscribe(['terminal'], { sessionId: session.id })

    // Listen for data from server
    const unsubData = wsStore.on('terminal.data', (msg: any) => {
      if (msg.sessionId === session.id && msg.data) {
        term.write(msg.data)
      }
    })

    // Listen for session closed
    const unsubClosed = wsStore.on('terminal.closed', (msg: any) => {
      if (msg.id === session.id) {
        removeTab(session.id)
      }
    })

    // Pipe keystrokes to server
    const onDataDisposable = term.onData((data) => {
      wsStore.send({ type: 'terminal.input', data } as any)
    })

    // Handle resize
    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      wsStore.send({ type: 'terminal.resize', cols, rows } as any)
    })

    cleanups.push(() => {
      unsubData()
      unsubClosed()
      onDataDisposable.dispose()
      onResizeDisposable.dispose()
      wsStore.unsubscribe(['terminal'])
      term.dispose()
    })

    setTabs((prev) => [...prev, tab])
    setActiveTabId(session.id)
  }

  const removeTab = (id: string) => {
    const tab = tabs().find((t) => t.id === id)
    if (!tab) return

    // Close session on server
    fetch(`/api/terminal/sessions/${id}`, { method: 'DELETE' }).catch(() => {})

    tab.terminal.dispose()
    setTabs((prev) => prev.filter((t) => t.id !== id))

    if (activeTabId() === id) {
      const remaining = tabs().filter((t) => t.id !== id)
      setActiveTabId(remaining.length > 0 ? remaining[0].id : null)
    }
  }

  // Mount/unmount terminal when active tab changes
  createEffect(() => {
    const tab = activeTab()
    if (!tab || !containerRef) return

    // Clear container
    containerRef.innerHTML = ''
    tab.terminal.open(containerRef)
    tab.fitAddon.fit()
    tab.terminal.focus()
  })

  // Resize observer
  onMount(() => {
    if (!containerRef) return

    const resizeObserver = new ResizeObserver(() => {
      const tab = activeTab()
      if (tab) {
        try {
          tab.fitAddon.fit()
        } catch {
          // ignore fit errors during transitions
        }
      }
    })
    resizeObserver.observe(containerRef)

    cleanups.push(() => resizeObserver.disconnect())

    // Auto-create first terminal
    addTerminal()
  })

  onCleanup(() => {
    for (const cleanup of cleanups) cleanup()
  })

  return (
    <div class="flex h-full flex-col" style={{ background: '#1a1a2e' }}>
      {/* Toolbar */}
      <div
        class="flex items-center gap-1 border-b px-2 py-1"
        style={{ 'border-color': 'var(--c-border)', background: 'var(--c-bg-secondary, #16162a)' }}
      >
        <div class="flex flex-1 items-center gap-1 overflow-x-auto">
          <For each={tabs()}>
            {(tab) => (
              <button
                class="flex items-center gap-1 rounded px-2 py-0.5 text-xs whitespace-nowrap"
                style={{
                  background: activeTabId() === tab.id ? 'var(--c-accent, #3a3a5e)' : 'transparent',
                  color: activeTabId() === tab.id ? 'var(--c-text, #e0e0e0)' : 'var(--c-text-muted, #888)'
                }}
                onClick={() => setActiveTabId(tab.id)}
              >
                <span>{tab.name}</span>
                <span
                  class="ml-1 hover:text-red-400"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeTab(tab.id)
                  }}
                >
                  ×
                </span>
              </button>
            )}
          </For>
        </div>
        <button
          class="rounded px-2 py-0.5 text-xs"
          style={{ background: 'var(--c-accent, #3a3a5e)', color: 'var(--c-text, #e0e0e0)' }}
          onClick={addTerminal}
        >
          + New
        </button>
      </div>

      {/* Terminal container */}
      <div class="flex-1 overflow-hidden" ref={containerRef}>
        <Show when={tabs().length === 0}>
          <div class="flex h-full items-center justify-center">
            <p class="text-xs" style={{ color: 'var(--c-text-muted, #888)' }}>
              No terminal sessions
            </p>
          </div>
        </Show>
      </div>
    </div>
  )
}

export default TerminalPanel
