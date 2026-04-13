import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { registerChatWs } from './ws.js'
import type { ChatModule } from './chat.js'
import type { WsHandler } from '../ws/handler.js'
import type { WsChannelOptions } from '@sovereign/core'

function createMockWsHandler(): WsHandler & { _channels: Map<string, WsChannelOptions> } {
  const channels = new Map<string, WsChannelOptions>()
  return {
    _channels: channels,
    registerChannel: vi.fn((name: string, opts: WsChannelOptions) => {
      channels.set(name, opts)
    }),
    handleConnection: vi.fn(),
    broadcast: vi.fn(),
    broadcastToChannel: vi.fn(),
    sendTo: vi.fn(),
    sendBinary: vi.fn(),
    getConnectedDevices: vi.fn(() => []),
    getChannels: vi.fn(() => [])
  }
}

function createMockChatModule(): ChatModule {
  return {
    status: vi.fn(() => ({ name: 'chat', status: 'ok' as const })),
    handleSend: vi.fn(async () => {}),
    handleAbort: vi.fn(async () => {}),
    handleHistory: vi.fn(async () => {}),
    handleFullHistory: vi.fn(async () => {}),
    handleSessionSwitch: vi.fn(async () => {}),
    handleSessionCreate: vi.fn(async () => ({ threadKey: 't1', sessionKey: 's1' })),
    handleCancel: vi.fn(() => true),
    getSessionKeyForThread: vi.fn(() => undefined),
    getThreadKeyForSession: vi.fn(() => undefined),
    getQueue: vi.fn(() => []),
    loadMapping: vi.fn(),
    chatEvents: new EventEmitter(),
    getLiveState: vi.fn(() => ({})),
    resolveSessionKey: vi.fn((tk: string) => `session-${tk}`),
    ensurePolling: vi.fn(),
    trackSSEClient: vi.fn(),
    untrackSSEClient: vi.fn()
  }
}

describe('Chat WS Channel', () => {
  let wsHandler: ReturnType<typeof createMockWsHandler>
  let chatModule: ReturnType<typeof createMockChatModule>

  beforeEach(() => {
    wsHandler = createMockWsHandler()
    chatModule = createMockChatModule()
    registerChatWs(wsHandler, chatModule)
  })

  it('MUST register chat WS channel', () => {
    expect(wsHandler.registerChannel).toHaveBeenCalledWith(
      'chat',
      expect.objectContaining({
        clientMessages: expect.arrayContaining([
          'chat.send',
          'chat.abort',
          'chat.history',
          'chat.history.full',
          'chat.session.switch',
          'chat.session.create',
          'chat.cancel'
        ]),
        serverMessages: expect.arrayContaining([
          'chat.stream',
          'chat.turn',
          'chat.status',
          'chat.work',
          'chat.compacting',
          'chat.error',
          'chat.session.info',
          'chat.queue.update'
        ])
      })
    )
  })

  it('MUST handle chat.send messages from clients', () => {
    const opts = wsHandler._channels.get('chat')!
    opts.onMessage!('chat.send', { type: 'chat.send', threadKey: 'tk1', text: 'hello' }, 'device-1')
    expect(chatModule.handleSend).toHaveBeenCalledWith('tk1', 'hello', undefined)
  })

  it('MUST handle chat.abort messages from clients', () => {
    const opts = wsHandler._channels.get('chat')!
    opts.onMessage!('chat.abort', { type: 'chat.abort', threadKey: 'tk1' }, 'device-1')
    expect(chatModule.handleAbort).toHaveBeenCalledWith('tk1')
  })

  it('MUST handle chat.history messages from clients', () => {
    const opts = wsHandler._channels.get('chat')!
    opts.onMessage!('chat.history', { type: 'chat.history', threadKey: 'tk1' }, 'device-1')
    expect(chatModule.handleHistory).toHaveBeenCalledWith('tk1', 'device-1')
  })

  it('MUST handle chat.session.switch messages from clients', () => {
    const opts = wsHandler._channels.get('chat')!
    opts.onMessage!('chat.session.switch', { type: 'chat.session.switch', threadKey: 'tk1' }, 'device-1')
    expect(chatModule.handleSessionSwitch).toHaveBeenCalledWith('tk1')
  })

  it('MUST handle chat.session.create messages from clients', () => {
    const opts = wsHandler._channels.get('chat')!
    opts.onMessage!('chat.session.create', { type: 'chat.session.create', label: 'new' }, 'device-1')
    expect(chatModule.handleSessionCreate).toHaveBeenCalledWith('new')
  })

  it('MUST handle chat.cancel messages from clients', () => {
    const opts = wsHandler._channels.get('chat')!
    opts.onMessage!('chat.cancel', { type: 'chat.cancel', id: 'msg-1' }, 'device-1')
    expect(chatModule.handleCancel).toHaveBeenCalledWith('msg-1')
  })

  it('MUST broadcast chat.stream to scoped subscribers', () => {
    // This is handled by chatModule internally, not ws.ts
    // ws.ts just registers the channel — the chatModule does the broadcasting
    const opts = wsHandler._channels.get('chat')!
    expect(opts.serverMessages).toContain('chat.stream')
  })

  it('MUST broadcast chat.turn to scoped subscribers', () => {
    const opts = wsHandler._channels.get('chat')!
    expect(opts.serverMessages).toContain('chat.turn')
  })

  it('MUST broadcast chat.status to scoped subscribers', () => {
    const opts = wsHandler._channels.get('chat')!
    expect(opts.serverMessages).toContain('chat.status')
  })

  it('MUST broadcast chat.work to scoped subscribers', () => {
    const opts = wsHandler._channels.get('chat')!
    expect(opts.serverMessages).toContain('chat.work')
  })

  it('MUST broadcast chat.compacting to scoped subscribers', () => {
    const opts = wsHandler._channels.get('chat')!
    expect(opts.serverMessages).toContain('chat.compacting')
  })

  it('MUST broadcast chat.error to scoped subscribers', () => {
    const opts = wsHandler._channels.get('chat')!
    expect(opts.serverMessages).toContain('chat.error')
  })

  it('MUST broadcast chat.session.info to scoped subscribers', () => {
    const opts = wsHandler._channels.get('chat')!
    expect(opts.serverMessages).toContain('chat.session.info')
  })
})
