import { describe, it } from 'vitest'

describe('§5.4 Message Forwarding (Server)', () => {
  it.todo('MUST preserve original message content (markdown) in ForwardedMessage')
  it.todo('MUST preserve original author role (user/assistant/system)')
  it.todo('MUST preserve original timestamp')
  it.todo('MUST preserve source thread key and label')
  it.todo('MUST preserve file attachments from the original message')
  it.todo('MUST deliver forwarded message to target thread backend session')
  it.todo('MUST emit thread.message.forwarded bus event with { sourceThread, targetThread, messageId }')
  it.todo('MUST support forwarding across workspaces (project A to project B)')
  it.todo('MUST accept optional commentary to accompany the forwarded message')
})
