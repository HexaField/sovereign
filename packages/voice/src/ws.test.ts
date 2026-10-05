import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { WsChannelOptions } from '@sovereign/core'
import { registerVoiceStreamChannel } from './ws.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function setup() {
  let channel: WsChannelOptions | undefined
  const log: string[] = []
  const ws = {
    registerChannel: (_name: string, options: WsChannelOptions) => {
      channel = options
    },
    sendTo: vi.fn(),
    sendToDeviceName: vi.fn((name: string, msg: Record<string, unknown>) => {
      log.push(`draft ${name} ${msg.threadId} "${msg.text}"${msg.done ? ' done' : ''}`)
    }),
    getDeviceName: (id: string) => (id === 'node' ? 'Mac' : undefined)
  }
  const presence = {
    threadId: () => 'presence-thread',
    send: vi.fn(async (text: string) => {
      log.push(`send "${text}"`)
      return { delivered: true }
    })
  }
  registerVoiceStreamChannel({ ws, transcribeUrl: 'http://stt/transcribe', presence })
  const send = (type: string, payload: Record<string, unknown> = {}, from = 'node') =>
    channel!.onMessage!(type, { type, ...payload }, from)
  const disconnect = (from = 'node') => channel!.onDisconnect!(from)
  return { ws, presence, log, send, disconnect }
}

const pcmSeconds = (s: number) => Buffer.alloc(Math.round(s * 16000) * 2, 1).toString('base64')

describe('voice-stream channel — deliver: presence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockFetch.mockReset()
    mockFetch.mockImplementation(async () => new Response(JSON.stringify({ text: 'hello there' })))
  })
  afterEach(() => vi.useRealTimers())

  it('shows the live text as a draft in the presence thread, then sends the final text there', async () => {
    const { log, presence, send } = setup()
    send('voice-stream.start', { format: 'pcm16', sampleRate: 16000, deliver: 'presence' })
    send('voice-stream.chunk', { audio: pcmSeconds(1) })
    await vi.advanceTimersByTimeAsync(1600)
    send('voice-stream.stop')
    await vi.runAllTimersAsync()

    expect(log).toEqual([
      'draft Mac presence-thread ""',
      'draft Mac presence-thread "hello there"',
      'send "hello there"',
      'draft Mac presence-thread "" done'
    ])
    expect(presence.send).toHaveBeenCalledWith('hello there', { deviceId: 'node', deviceName: 'Mac' })
  })

  it('sends nothing for silence, and still clears the draft', async () => {
    mockFetch.mockImplementation(async () => new Response(JSON.stringify({ text: '' })))
    const { log, presence, send } = setup()
    send('voice-stream.start', { format: 'pcm16', deliver: 'presence' })
    send('voice-stream.chunk', { audio: pcmSeconds(1) })
    send('voice-stream.stop')
    await vi.runAllTimersAsync()

    expect(presence.send).not.toHaveBeenCalled()
    expect(log[log.length - 1]).toBe('draft Mac presence-thread "" done')
  })

  it('keeps a new stream’s draft when the previous stop’s send resolves after the new start', async () => {
    const { log, presence, send } = setup()
    let release!: () => void
    presence.send.mockImplementationOnce(async (text: string) => {
      await new Promise<void>((r) => (release = r))
      log.push(`send "${text}"`)
      return { delivered: true }
    })
    send('voice-stream.start', { format: 'pcm16', deliver: 'presence' })
    send('voice-stream.chunk', { audio: pcmSeconds(1) })
    send('voice-stream.stop')
    await vi.advanceTimersByTimeAsync(0) // final pass done, send pending

    send('voice-stream.start', { format: 'pcm16', deliver: 'presence' })
    send('voice-stream.chunk', { audio: pcmSeconds(1) })
    release()
    await vi.advanceTimersByTimeAsync(1600)

    expect(log).toEqual([
      'draft Mac presence-thread ""',
      'draft Mac presence-thread ""',
      'send "hello there"',
      'draft Mac presence-thread "hello there"'
    ])
  })

  it('sends one device’s messages in the order spoken, however long each takes to transcribe', async () => {
    // Longer audio transcribes slower: the first message would otherwise land second.
    mockFetch.mockImplementation(async (_url: string, init: { body: FormData }) => {
      const bytes = (init.body.get('file') as Blob).size
      await new Promise((r) => setTimeout(r, bytes > 40_000 ? 5000 : 10))
      return new Response(JSON.stringify({ text: bytes > 40_000 ? 'first' : 'second' }))
    })
    const { presence, send } = setup()
    send('voice-stream.start', { format: 'pcm16', deliver: 'presence' })
    send('voice-stream.chunk', { audio: pcmSeconds(2) })
    send('voice-stream.stop')
    send('voice-stream.start', { format: 'pcm16', deliver: 'presence' })
    send('voice-stream.chunk', { audio: pcmSeconds(1) })
    send('voice-stream.stop')
    await vi.runAllTimersAsync()

    expect(presence.send.mock.calls.map((c) => c[0])).toEqual(['first', 'second'])
  })

  it('clears the draft once when the node disconnects while its message sends', async () => {
    const { log, send, disconnect } = setup()
    send('voice-stream.start', { format: 'pcm16', deliver: 'presence' })
    send('voice-stream.chunk', { audio: pcmSeconds(1) })
    send('voice-stream.stop')
    disconnect()
    await vi.runAllTimersAsync()

    expect(log.filter((l) => l.endsWith('done'))).toHaveLength(1)
    expect(log).toContain('send "hello there"')
  })

  it('leaves a browser stream alone: transcripts to the sender only, no draft, no send', async () => {
    const { ws, presence, send } = setup()
    send('voice-stream.start', {}, 'tab')
    send('voice-stream.chunk', { audio: Buffer.alloc(3000).toString('base64') }, 'tab')
    send('voice-stream.stop', {}, 'tab')
    await vi.runAllTimersAsync()

    expect(ws.sendTo).toHaveBeenCalledWith('tab', { type: 'voice-stream.transcript', text: 'hello there', final: true })
    expect(ws.sendToDeviceName).not.toHaveBeenCalled()
    expect(presence.send).not.toHaveBeenCalled()
  })
})
