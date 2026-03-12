import { describe, it } from 'vitest'

describe('Terminal Manager', () => {
  // Creation
  it.todo('creates a terminal session with PTY')
  it.todo('defaults shell to $SHELL or /bin/bash')
  it.todo('defaults cwd to worktree path when worktree is active')
  it.todo('validates cwd is within a known project/worktree path')
  it.todo('rejects cwd outside known paths')

  // Session management
  it.todo('lists all active terminal sessions')
  it.todo('gets a terminal session by id')
  it.todo('closes a terminal session and kills PTY')
  it.todo('cleans up PTY after WebSocket disconnect with grace period')

  // I/O
  it.todo('attaches to a session for bidirectional data')
  it.todo('writes data to PTY stdin')
  it.todo('reads data from PTY stdout')
  it.todo('handles binary data correctly')

  // Resize
  it.todo('resizes PTY on terminal resize')

  // Events
  it.todo('emits terminal.created on the bus')
  it.todo('emits terminal.closed on the bus')

  // Multiple sessions
  it.todo('supports multiple concurrent terminal sessions')
})

describe('Terminal WebSocket Handler', () => {
  it.todo('creates PTY session on WebSocket connect')
  it.todo('forwards WebSocket messages to PTY stdin')
  it.todo('forwards PTY stdout to WebSocket messages')
  it.todo('sends resize command from client to PTY')
  it.todo('closes PTY on WebSocket close')
  it.todo('supports reconnection to existing PTY within grace period')
})
