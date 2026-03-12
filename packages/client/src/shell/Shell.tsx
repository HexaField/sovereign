import { type Component, onMount, onCleanup, Show, createSignal } from 'solid-js'
import { shellState, toggleSidebar, toggleBottomPanel, closeTab, setActiveTab, setSidebarWidth } from './shell-store.js'
import { registerCommand } from './commands.js'
import Header from './Header.js'
import Sidebar from './Sidebar.js'
import MainContent from './MainContent.js'
import BottomPanel from './BottomPanel.js'
import Divider from './Divider.js'
import CommandPalette from './CommandPalette.js'
import StatusBar from '../components/status-bar/StatusBar.js'

const Shell: Component = () => {
  const [isMobile, setIsMobile] = createSignal(window.innerWidth < 768)

  const onResize = () => setIsMobile(window.innerWidth < 768)

  onMount(() => {
    window.addEventListener('resize', onResize)

    // Register default commands
    registerCommand({
      id: 'shell.toggleSidebar',
      label: 'Toggle Sidebar',
      shortcut: 'Cmd+B',
      category: 'View',
      action: toggleSidebar
    })
    registerCommand({
      id: 'shell.toggleTerminal',
      label: 'Toggle Terminal',
      shortcut: 'Cmd+`',
      category: 'View',
      action: toggleBottomPanel
    })

    // Keyboard shortcuts
    const handleKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey

      if (mod && e.key === 'b') {
        e.preventDefault()
        toggleSidebar()
      } else if (mod && e.key === '`') {
        e.preventDefault()
        toggleBottomPanel()
      } else if (mod && e.key === 'w') {
        e.preventDefault()
        if (shellState.activeTabId) closeTab(shellState.activeTabId)
      } else if (mod && e.key >= '1' && e.key <= '9') {
        e.preventDefault()
        const idx = parseInt(e.key) - 1
        if (shellState.tabs[idx]) setActiveTab(shellState.tabs[idx].id)
      }
    }
    document.addEventListener('keydown', handleKey)

    return () => {
      document.removeEventListener('keydown', handleKey)
    }
  })

  onCleanup(() => {
    window.removeEventListener('resize', onResize)
  })

  return (
    <div class="flex h-screen flex-col bg-zinc-950 text-white">
      <Header />
      <div class="flex min-h-0 flex-1 overflow-hidden">
        <Show when={!isMobile()}>
          <Sidebar />
          <Show when={!shellState.sidebarCollapsed}>
            <Divider direction="horizontal" onResize={(delta) => setSidebarWidth(shellState.sidebarWidth + delta)} />
          </Show>
        </Show>
        <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
          <MainContent />
          <BottomPanel />
        </div>
      </div>
      <StatusBar />
      <CommandPalette />
    </div>
  )
}

export default Shell
