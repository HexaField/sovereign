import { describe, it } from 'vitest'

describe('§3.1 Connection Store', () => {
  it.todo('MUST expose connectionStatus: Accessor<ConnectionStatus>')
  it.todo('MUST expose statusText: Accessor<string> derived from connectionStatus')
  it.todo('MUST map connecting to Connecting…')
  it.todo('MUST map connected to Connected')
  it.todo('MUST map disconnected to Disconnected')
  it.todo('MUST map error to Connection error')
  it.todo('MUST subscribe to chat WS channel for backend.status messages')
  it.todo('MUST update connectionStatus when backend.status messages arrive')
})
