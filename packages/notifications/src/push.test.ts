import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createPushManager, type PushSubscription } from './push.js'

let tmpDir = ''

const fakeSub = (suffix: string): PushSubscription => ({
  endpoint: `https://example.invalid/push/${suffix}`,
  keys: {
    p256dh: `pkey-${suffix}`,
    auth: `auth-${suffix}`
  }
})

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-mgr-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('PushManager subscription persistence', () => {
  it('persists subscribe across instances', () => {
    const pm1 = createPushManager(tmpDir)
    pm1.subscribe('d1', fakeSub('a'))
    pm1.subscribe('d2', fakeSub('b'))

    const pm2 = createPushManager(tmpDir)
    expect(pm2.getSubscription('d1')?.endpoint).toContain('/push/a')
    expect(pm2.getSubscription('d2')?.endpoint).toContain('/push/b')
    expect(pm2.allSubscriptions().size).toBe(2)
  })

  it('persists unsubscribe', () => {
    const pm1 = createPushManager(tmpDir)
    pm1.subscribe('d1', fakeSub('a'))
    pm1.unsubscribe('d1')

    const pm2 = createPushManager(tmpDir)
    expect(pm2.getSubscription('d1')).toBeUndefined()
  })

  it('writes a parseable JSON file', () => {
    const pm = createPushManager(tmpDir)
    pm.subscribe('d1', fakeSub('a'))
    const file = path.join(tmpDir, 'notifications', 'push-subscriptions.json')
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(parsed.d1.endpoint).toContain('/push/a')
  })

  it('ignores corrupt subscription records on load', () => {
    fs.mkdirSync(path.join(tmpDir, 'notifications'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, 'notifications', 'push-subscriptions.json'),
      JSON.stringify({
        good: fakeSub('a'),
        'missing-keys': { endpoint: 'https://x' },
        'missing-endpoint': { keys: { p256dh: 'k', auth: 'a' } }
      })
    )
    const pm = createPushManager(tmpDir)
    expect(pm.allSubscriptions().size).toBe(1)
    expect(pm.getSubscription('good')).toBeDefined()
  })

  it('tolerates a missing data dir', () => {
    // Should not throw when constructed without a data dir.
    const pm = createPushManager()
    expect(pm.allSubscriptions().size).toBe(0)
    pm.subscribe('d1', fakeSub('a')) // no-op persistence; still in memory
    expect(pm.getSubscription('d1')).toBeDefined()
  })

  it('sendAll handles an empty subscription map without crashing', async () => {
    const pm = createPushManager(tmpDir)
    await expect(pm.sendAll({ type: 'noop' })).resolves.toBeUndefined()
  })

  it('sendToDevices filters out missing devices', async () => {
    const pm = createPushManager(tmpDir)
    pm.subscribe('d1', fakeSub('a'))
    // Real push won't fire (no VAPID actually set in test env), but the call
    // should resolve without throwing for unknown devices.
    await expect(pm.sendToDevices(['d1', 'd-missing'], { type: 'noop' })).resolves.toBeUndefined()
  })
})
