export interface PanelDefinition {
  id: string
  title: string
  icon: string
  component: () => any // SolidJS Component
  position: 'sidebar' | 'main' | 'bottom'
  defaultVisible?: boolean
}

export interface TabData {
  id: string
  title: string
  icon?: string
  component: () => any
  closable: boolean
  pinned: boolean
  data?: Record<string, unknown>
}

export interface ShellState {
  sidebarWidth: number
  sidebarCollapsed: boolean
  bottomHeight: number
  bottomVisible: boolean
  tabs: TabData[]
  activeTabId: string | null
  theme: 'dark' | 'light'
}

export interface Command {
  id: string
  label: string
  shortcut?: string
  action: () => void
  category?: string
}
