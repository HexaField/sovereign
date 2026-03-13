import { describe, it } from 'vitest'

describe('§5.4 ForwardDialog (Client)', () => {
  it.todo('MUST open as a Modal overlay when triggered from message context menu')
  it.todo('MUST show a thread picker listing all available threads with search/filter')
  it.todo('MUST exclude the current thread from the list')
  it.todo('MUST include "Add a note…" text input for optional commentary')
  it.todo('MUST preserve original message content, author, timestamp, source thread')
  it.todo('MUST show a preview of the message being forwarded (truncated to 3 lines)')
  it.todo('MUST send ForwardedMessage payload to POST /api/threads/:key/forward on Forward click')
  it.todo('MUST render forwarded message with "Forwarded from" header in target thread')
  it.todo('MUST support forwarding across workspaces')
})
