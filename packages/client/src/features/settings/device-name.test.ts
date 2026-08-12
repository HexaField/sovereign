import { describe, it, expect, vi, beforeEach } from 'vitest'

const sent: unknown[] = []
const reconnectHandlers: Array<() => void> = []
let connected = false

vi.mock('../../ws/index.js', () => ({
  wsStore: {
    connected: () => connected,
    send: vi.fn((msg: unknown) => {
      sent.push(msg)
    }),
    on: vi.fn((type: string, handler: () => void) => {
      if (type === 'ws.reconnected') reconnectHandlers.push(handler)
      return () => {
        const idx = reconnectHandlers.indexOf(handler)
        if (idx >= 0) reconnectHandlers.splice(idx, 1)
      }
    })
  }
}))

import { DEVICE_NAME_KEY, deviceName, hasDeviceName, setDeviceName, initDeviceNameSync } from './device-name.js'

const store: Record<string, string> = {}
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, val: string) => {
    store[key] = val
  },
  removeItem: (key: string) => {
    delete store[key]
  }
}
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

describe('device name store', () => {
  beforeEach(() => {
    Object.keys(store).forEach((k) => delete store[k])
    sent.length = 0
    reconnectHandlers.length = 0
    connected = false
    setDeviceName('')
  })

  it('starts empty when localStorage holds no name', () => {
    expect(hasDeviceName()).toBe(false)
    expect(deviceName()).toBe('')
  })

  it('persists a trimmed name to localStorage under sovereign:deviceName', () => {
    setDeviceName('  Josh Phone  ')
    expect(store[DEVICE_NAME_KEY]).toBe('Josh Phone')
    expect(deviceName()).toBe('Josh Phone')
    expect(hasDeviceName()).toBe(true)
  })

  it('sends ws.device-name with the trimmed name on change', () => {
    setDeviceName('Josh Phone')
    expect(sent).toContainEqual({ type: 'ws.device-name', deviceName: 'Josh Phone' })
  })

  it('clears the stored name when set to an empty string', () => {
    setDeviceName('Josh Phone')
    setDeviceName('')
    expect(store[DEVICE_NAME_KEY]).toBeUndefined()
    expect(hasDeviceName()).toBe(false)
    expect(deviceName()).toBe('')
  })

  it('does not send ws.device-name when clearing', () => {
    setDeviceName('Josh Phone')
    sent.length = 0
    setDeviceName('')
    expect(sent).toHaveLength(0)
  })

  it('initDeviceNameSync sends nothing immediately when not yet connected', () => {
    store[DEVICE_NAME_KEY] = 'Josh Phone'
    connected = false
    const cleanup = initDeviceNameSync()
    expect(sent).toHaveLength(0)
    cleanup()
  })

  it('initDeviceNameSync announces a stored name immediately when already connected', () => {
    store[DEVICE_NAME_KEY] = 'Josh Phone'
    connected = true
    const cleanup = initDeviceNameSync()
    expect(sent).toContainEqual({ type: 'ws.device-name', deviceName: 'Josh Phone' })
    cleanup()
  })

  it('initDeviceNameSync announces the stored name on every ws.reconnected event', () => {
    store[DEVICE_NAME_KEY] = 'Josh Phone'
    const cleanup = initDeviceNameSync()
    sent.length = 0
    reconnectHandlers.forEach((h) => h())
    expect(sent).toContainEqual({ type: 'ws.device-name', deviceName: 'Josh Phone' })
    cleanup()
  })

  it('initDeviceNameSync sends nothing on reconnect when no name is stored', () => {
    const cleanup = initDeviceNameSync()
    reconnectHandlers.forEach((h) => h())
    expect(sent).toHaveLength(0)
    cleanup()
  })
})
