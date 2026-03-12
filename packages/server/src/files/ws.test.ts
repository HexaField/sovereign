import { describe, it } from 'vitest'

describe('Files WS Channel', () => {
  it.todo('registers files channel with correct server message types')
  it.todo('bridges file.created bus event to file.changed WS message')
  it.todo('bridges file.deleted bus event to file.changed WS message')
  it.todo('scopes messages by projectId')
  it.todo('only sends to clients subscribed with matching project scope')
})
