import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createEventBus } from '@template/core'
import type { BusEvent } from '@template/core'
import { createConfigStore } from './config.js'
import type { ConfigChange } from './types.js'

let tmpDir: string
let bus: ReturnType<typeof createEventBus>
let events: BusEvent[]

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'))
  bus = createEventBus(tmpDir)
  events = []
  bus.on('config.*', (e) => {
    events.push(e)
  })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('ConfigStore', () => {
  describe('startup', () => {
    it('loads config from disk on startup', () => {
      fs.mkdirSync(tmpDir, { recursive: true })
      fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ server: { port: 9999, host: 'localhost' } }))
      const store = createConfigStore(bus, tmpDir)
      expect(store.get('server.port')).toBe(9999)
    })

    it('validates config on startup', () => {
      fs.mkdirSync(tmpDir, { recursive: true })
      fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ server: { port: 'bad' } }))
      const store = createConfigStore(bus, tmpDir)
      // Falls back to defaults on invalid
      expect(store.get('server.port')).toBe(3001)
    })

    it('applies defaults for missing keys', () => {
      const store = createConfigStore(bus, tmpDir)
      expect(store.get('server.port')).toBe(3001)
      expect(store.get('terminal.maxSessions')).toBe(10)
    })

    it('creates config.json if it does not exist', () => {
      createConfigStore(bus, tmpDir)
      expect(fs.existsSync(path.join(tmpDir, 'config.json'))).toBe(true)
    })
  })

  describe('get', () => {
    it('returns full resolved config with no path', () => {
      const store = createConfigStore(bus, tmpDir)
      const full = store.get()
      expect(full).toHaveProperty('server')
      expect(full).toHaveProperty('terminal')
    })

    it('returns namespaced value with dot-path notation', () => {
      const store = createConfigStore(bus, tmpDir)
      expect(store.get('server.host')).toBe('localhost')
    })

    it('returns default value for unset key', () => {
      const store = createConfigStore(bus, tmpDir)
      expect(store.get('worktrees.staleDays')).toBe(14)
    })

    it('returns env override over file value', () => {
      process.env.SOVEREIGN_SERVER__PORT = '5555'
      try {
        const store = createConfigStore(bus, tmpDir)
        expect(store.get('server.port')).toBe(5555)
      } finally {
        delete process.env.SOVEREIGN_SERVER__PORT
      }
    })
  })

  describe('set', () => {
    it('sets value at dot-path', () => {
      const store = createConfigStore(bus, tmpDir)
      store.set('server.port', 8080)
      expect(store.get('server.port')).toBe(8080)
    })

    it('validates before writing', () => {
      const store = createConfigStore(bus, tmpDir)
      expect(() => store.set('server.port', 'not-a-number')).toThrow()
    })

    it('rejects invalid value with detailed errors', () => {
      const store = createConfigStore(bus, tmpDir)
      expect(() => store.set('server.port', -1)).toThrow(/Invalid config/)
    })

    it('emits config.changed on bus with path, oldValue, newValue', () => {
      const store = createConfigStore(bus, tmpDir)
      store.set('server.port', 4000)
      const ev = events.find((e) => e.type === 'config.changed')
      expect(ev).toBeTruthy()
      const payload = ev!.payload as ConfigChange
      expect(payload.path).toBe('server.port')
      expect(payload.oldValue).toBe(3001)
      expect(payload.newValue).toBe(4000)
    })

    it('writes updated config to disk', () => {
      const store = createConfigStore(bus, tmpDir)
      store.set('server.port', 7777)
      const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'))
      expect(onDisk.server.port).toBe(7777)
    })

    it('logs change to history', () => {
      const store = createConfigStore(bus, tmpDir)
      store.set('server.port', 6000)
      const hist = store.getHistory()
      expect(hist.length).toBeGreaterThanOrEqual(1)
      expect(hist[0].path).toBe('server.port')
    })
  })

  describe('patch', () => {
    it('deep merges partial config into existing', () => {
      const store = createConfigStore(bus, tmpDir)
      store.patch({ server: { port: 2000 } })
      expect(store.get('server.port')).toBe(2000)
      expect(store.get('server.host')).toBe('localhost')
    })

    it('validates merged result before writing', () => {
      const store = createConfigStore(bus, tmpDir)
      expect(() => store.patch({ server: { port: 'bad' } })).toThrow()
    })

    it('rejects invalid patch with detailed errors', () => {
      const store = createConfigStore(bus, tmpDir)
      expect(() => store.patch({ server: { port: -5 } })).toThrow(/Invalid config/)
    })

    it('emits config.changed for each changed path', () => {
      const store = createConfigStore(bus, tmpDir)
      store.patch({ server: { port: 1111 } })
      const changeEvents = events.filter((e) => e.type === 'config.changed')
      expect(changeEvents.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('hot-reload', () => {
    it('updates in-memory config on set without restart', () => {
      const store = createConfigStore(bus, tmpDir)
      store.set('server.port', 3333)
      expect(store.get('server.port')).toBe(3333)
    })

    it('modules pick up new values on next read', () => {
      const store = createConfigStore(bus, tmpDir)
      store.set('terminal.maxSessions', 20)
      expect(store.get('terminal.maxSessions')).toBe(20)
    })

    it('onChange handler fires for subscribed path', () => {
      const store = createConfigStore(bus, tmpDir)
      const changes: ConfigChange[] = []
      store.onChange('server.port', (c) => changes.push(c))
      store.set('server.port', 4444)
      expect(changes).toHaveLength(1)
      expect(changes[0].newValue).toBe(4444)
    })

    it('onChange returns unsubscribe function', () => {
      const store = createConfigStore(bus, tmpDir)
      const changes: ConfigChange[] = []
      const unsub = store.onChange('server.port', (c) => changes.push(c))
      unsub()
      store.set('server.port', 5555)
      expect(changes).toHaveLength(0)
    })
  })

  describe('env overrides', () => {
    it('env var takes precedence over file value', () => {
      process.env.SOVEREIGN_SERVER__PORT = '9999'
      try {
        fs.mkdirSync(tmpDir, { recursive: true })
        fs.writeFileSync(
          path.join(tmpDir, 'config.json'),
          JSON.stringify({ server: { port: 1234, host: 'localhost' } })
        )
        const store = createConfigStore(bus, tmpDir)
        expect(store.get('server.port')).toBe(9999)
      } finally {
        delete process.env.SOVEREIGN_SERVER__PORT
      }
    })

    it('env var is NOT written to disk', () => {
      process.env.SOVEREIGN_SERVER__PORT = '8888'
      try {
        const store = createConfigStore(bus, tmpDir)
        expect(store.get('server.port')).toBe(8888)
        const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf-8'))
        expect(onDisk.server?.port).not.toBe(8888)
      } finally {
        delete process.env.SOVEREIGN_SERVER__PORT
      }
    })

    it('double underscore maps to dot-path separator', () => {
      process.env.SOVEREIGN_TERMINAL__SHELL = '/bin/bash'
      try {
        const store = createConfigStore(bus, tmpDir)
        expect(store.get('terminal.shell')).toBe('/bin/bash')
      } finally {
        delete process.env.SOVEREIGN_TERMINAL__SHELL
      }
    })

    it('SOVEREIGN_ prefix required', () => {
      process.env.OTHER_SERVER__PORT = '7777'
      try {
        const store = createConfigStore(bus, tmpDir)
        expect(store.get('server.port')).toBe(3001) // default, not overridden
      } finally {
        delete process.env.OTHER_SERVER__PORT
      }
    })
  })

  describe('history', () => {
    it('appends change to JSONL file', () => {
      const store = createConfigStore(bus, tmpDir)
      store.set('server.port', 5000)
      const histFile = path.join(tmpDir, 'config-history.jsonl')
      expect(fs.existsSync(histFile)).toBe(true)
      const lines = fs.readFileSync(histFile, 'utf-8').trim().split('\n')
      expect(lines.length).toBeGreaterThanOrEqual(1)
    })

    it('records timestamp, path, oldValue, newValue, source', () => {
      const store = createConfigStore(bus, tmpDir)
      store.set('server.port', 5001)
      const hist = store.getHistory()
      expect(hist[0].timestamp).toBeTruthy()
      expect(hist[0].path).toBe('server.port')
      expect(hist[0].oldValue).toBe(3001)
      expect(hist[0].newValue).toBe(5001)
      expect(hist[0].source).toBe('api')
    })

    it('supports pagination with limit and offset', () => {
      const store = createConfigStore(bus, tmpDir)
      store.set('server.port', 5002)
      store.set('server.port', 5003)
      store.set('server.port', 5004)
      expect(store.getHistory({ limit: 1 })).toHaveLength(1)
      expect(store.getHistory({ offset: 1, limit: 1 })).toHaveLength(1)
      expect(store.getHistory({ offset: 1, limit: 1 })[0].newValue).toBe(5003)
    })
  })

  describe('export/import', () => {
    it('exportConfig returns full SovereignConfig', () => {
      const store = createConfigStore(bus, tmpDir)
      const exported = store.exportConfig()
      expect(exported.server.port).toBe(3001)
      expect(exported.terminal).toBeTruthy()
    })

    it('importConfig validates before applying', () => {
      const store = createConfigStore(bus, tmpDir)
      expect(() => store.importConfig({ server: { port: 'bad' } })).toThrow()
    })

    it('importConfig rejects invalid config', () => {
      const store = createConfigStore(bus, tmpDir)
      expect(() => store.importConfig('not-an-object')).toThrow()
    })

    it('importConfig applies valid config', () => {
      const store = createConfigStore(bus, tmpDir)
      store.importConfig({ server: { port: 7000, host: 'example.com' } })
      expect(store.get('server.port')).toBe(7000)
    })
  })

  describe('presets', () => {
    it('applies named preset as batch', () => {
      // Presets are a SHOULD — implemented via importConfig with preset objects
      const store = createConfigStore(bus, tmpDir)
      const devPreset = {
        server: { port: 3001, host: 'localhost' },
        terminal: { shell: '/bin/zsh', gracePeriodMs: 30000, maxSessions: 10 }
      }
      store.importConfig(devPreset)
      expect(store.get('server.port')).toBe(3001)
    })
  })
})
