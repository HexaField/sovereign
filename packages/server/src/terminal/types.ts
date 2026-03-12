export interface TerminalSession {
  id: string
  pid: number
  cwd: string
  shell: string
  cols: number
  rows: number
  createdAt: string
}
