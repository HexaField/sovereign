export interface TerminalSession {
  id: string
  cwd: string
  shell: string
  cols: number
  rows: number
  createdAt: string
}

export interface TerminalTabInfo {
  id: string
  title: string
  sessionId: string
}
