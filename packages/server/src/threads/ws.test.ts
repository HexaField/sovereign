import { describe, it } from 'vitest'

describe('Threads WS Channel', () => {
  it.todo('MUST register threads WS channel')
  it.todo('MUST send thread.created when a new thread is created')
  it.todo('MUST send thread.updated when thread metadata changes')
  it.todo('MUST send thread.event.routed when an entity event is routed to a thread')
  it.todo('MUST send thread.status when thread status changes')
  it.todo('MUST scope by { orgId, projectId } — client subscribed with scope only receives matching events')
  it.todo('MUST support unscoped subscription for all thread events')
})
