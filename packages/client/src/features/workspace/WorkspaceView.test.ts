import { describe, it } from 'vitest'

describe('WorkspaceView', () => {
  describe('§3.1 — Desktop Layout', () => {
    it.todo('§3.1 — renders three columns: sidebar, main content, chat panel')
    it.todo('§3.1 — sidebar has tab bar at top switching sidebar content')
    it.todo('§3.1 — sidebar tabs include: Files, Git, Threads, Planning, Notifications, Terminal, Recordings, Logs')
    it.todo('§3.1 — only one sidebar tab visible at a time')
    it.todo('§3.1 — main content area supports multiple open tabs with tab bar')
    it.todo('§3.1 — right panel shows chat interface for active thread')
    it.todo('§3.1 — no status bar rendered')
    it.todo('§3.1 — all panels scope data to active workspace orgId and projectId')
  })

  describe('§3.2 — Expand Chat Mode', () => {
    it.todo('§3.2 — chat panel has expand button to fill entire workspace view')
    it.todo('§3.2 — expanded chat looks identical to current voice-ui chat interface')
    it.todo('§3.2 — expanded chat shows collapse button to return to multi-panel view')
    it.todo('§3.2 — expanded/collapsed state stored in workspace store')
    it.todo('§3.2 — expanded chat includes header, input, message list, voice controls, thread drawer')
    it.todo('§3.2 — Cmd+Shift+E toggles expand/collapse')
  })

  describe('§3.5 — Right Panel Chat', () => {
    it.todo('§3.5 — reuses existing ChatView, InputArea, MessageBubble components')
    it.todo('§3.5 — subscribes to chat WS channel scoped to active thread key')
    it.todo('§3.5 — panel header shows thread label and expand button')
    it.todo('§3.5 — supports message forwarding via ForwardDialog')
    it.todo('§3.5 — selecting thread in sidebar updates right panel')
    it.todo('§3.5 — right panel has resizable width with drag divider')
    it.todo('§3.5 — default width 360px, min 280px, max 600px')
  })

  describe('§7.3 — Mobile Workspace', () => {
    it.todo('§7.3 — collapses panels into single swipeable tab strip on mobile')
    it.todo('§7.3 — header shows active tab name')
    it.todo('§7.3 — swiping left/right switches between tabs')
    it.todo('§7.3 — tapping header tab name opens dropdown listing all tabs')
    it.todo('§7.3 — only one tab visible at a time, fills full viewport')
    it.todo(
      '§7.3 — tab order: Files → File Viewer → Chat → Git → Threads → Planning → Notifications → Terminal → Recordings → Logs'
    )
    it.todo('§7.3 — swipe gestures animate slide transition')
    it.todo('§7.3 — active tab persists to localStorage')
    it.todo('§7.3 — tapping file in Files auto-switches to File Viewer tab')
    it.todo('§7.3 — tapping thread in Threads auto-switches to Chat tab')
  })
})
