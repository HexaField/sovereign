import { describe, it } from 'vitest'

describe('Git WS Channel', () => {
  it.todo('registers git channel with correct server message types')
  it.todo('bridges git.status.changed bus event to git.status WS message')
  it.todo('scopes messages by projectId')
  it.todo('only sends to clients subscribed with matching project scope')
})
