import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { createEventBus } from '@template/core'
import type { BusEvent } from '@template/core'
import { createAuth, type Auth, type AuthConfig } from './auth.js'
import { createDeviceStore } from './devices.js'
import { generateChallenge, verifySignature, generateKeyPair, sign } from './crypto.js'
import { createAuthMiddleware } from './middleware.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-auth-test-'))
}

function setup(configOverrides?: Partial<AuthConfig>) {
  const dataDir = tmpDir()
  const bus = createEventBus(dataDir)
  const events: BusEvent[] = []
  bus.on('auth.*', (e) => {
    events.push(e)
  })
  const config: AuthConfig = { tokenExpiry: '1h', trustedProxies: [], ...configOverrides }
  const auth = createAuth(bus, dataDir, config)
  return { dataDir, bus, auth, events }
}

async function registerAndApproveAndAuth(auth: Auth) {
  const kp = generateKeyPair()
  const device = auth.registerDevice(kp.publicKey, 'test-device')
  auth.approveDevice(device.id)
  const challenge = auth.createChallenge(kp.publicKey)
  const sig = sign(kp.privateKey, challenge)
  const session = await auth.authenticate(kp.publicKey, challenge, sig)
  return { kp, device, session }
}

describe('Auth', () => {
  it('registers a device with Ed25519 public key', () => {
    const { auth } = setup()
    const kp = generateKeyPair()
    const device = auth.registerDevice(kp.publicKey, 'my-device')
    expect(device.publicKey).toBe(kp.publicKey)
    expect(device.name).toBe('my-device')
    expect(device.id).toBeTruthy()
  })

  it('authenticates a device via Ed25519 signature challenge', async () => {
    const { auth } = setup()
    const { session } = await registerAndApproveAndAuth(auth)
    expect(session.token).toBeTruthy()
    expect(session.deviceId).toBeTruthy()
  })

  it('persists device registry to disk', () => {
    const { auth, dataDir } = setup()
    const kp = generateKeyPair()
    auth.registerDevice(kp.publicKey, 'persist-test')
    const file = path.join(dataDir, 'auth', 'devices.json')
    expect(fs.existsSync(file)).toBe(true)
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(data).toHaveLength(1)
    expect(data[0].name).toBe('persist-test')
  })

  it('loads device registry from disk on startup', () => {
    const dataDir = tmpDir()
    const bus = createEventBus(dataDir)
    const config: AuthConfig = { tokenExpiry: '1h', trustedProxies: [] }

    // Create first auth, register device
    const auth1 = createAuth(bus, dataDir, config)
    const kp = generateKeyPair()
    auth1.registerDevice(kp.publicKey, 'reload-test')

    // Create second auth from same dataDir
    const auth2 = createAuth(bus, dataDir, config)
    expect(auth2.devices()).toHaveLength(1)
    expect(auth2.devices()[0].name).toBe('reload-test')
  })

  it('new devices start with pending status', () => {
    const { auth } = setup()
    const kp = generateKeyPair()
    const device = auth.registerDevice(kp.publicKey, 'pending-test')
    expect(device.status).toBe('pending')
  })

  it('emits auth.device.pending on new registration', () => {
    const { auth, events } = setup()
    const kp = generateKeyPair()
    auth.registerDevice(kp.publicKey, 'event-test')
    const pending = events.find((e) => e.type === 'auth.device.pending')
    expect(pending).toBeTruthy()
    expect((pending!.payload as Record<string, unknown>).name).toBe('event-test')
  })

  it('does not grant access to pending devices', async () => {
    const { auth } = setup()
    const kp = generateKeyPair()
    auth.registerDevice(kp.publicKey, 'pending')
    const challenge = auth.createChallenge(kp.publicKey)
    const sig = sign(kp.privateKey, challenge)
    await expect(auth.authenticate(kp.publicKey, challenge, sig)).rejects.toThrow('Device not approved')
  })

  it('issues session token after successful authentication', async () => {
    const { auth } = setup()
    const { session } = await registerAndApproveAndAuth(auth)
    expect(session.token).toBeTruthy()
    expect(session.expiresAt).toBeTruthy()
  })

  it('session tokens have configurable expiry', async () => {
    const { auth } = setup({ tokenExpiry: '2h' })
    const { session } = await registerAndApproveAndAuth(auth)
    const created = new Date(session.createdAt).getTime()
    const expires = new Date(session.expiresAt).getTime()
    const diff = expires - created
    // Should be ~2h (7200000ms), allow some tolerance
    expect(diff).toBeGreaterThan(7100000)
    expect(diff).toBeLessThan(7300000)
  })

  it('middleware rejects requests without token', async () => {
    const { auth } = setup()
    const app = express()
    app.use(createAuthMiddleware(auth))
    app.get('/test', (_req, res) => {
      res.json({ ok: true })
    })
    const res = await request(app).get('/test')
    expect(res.status).toBe(401)
  })

  it('middleware rejects requests with invalid token', async () => {
    const { auth } = setup()
    const app = express()
    app.use(createAuthMiddleware(auth))
    app.get('/test', (_req, res) => {
      res.json({ ok: true })
    })
    const res = await request(app).get('/test').set('Authorization', 'Bearer invalid-token')
    expect(res.status).toBe(401)
  })

  it('middleware rejects requests with expired token', async () => {
    const { auth } = setup({ tokenExpiry: '1s' })
    const { session } = await registerAndApproveAndAuth(auth)
    // Wait for token to expire
    await new Promise((r) => setTimeout(r, 1500))
    const app = express()
    app.use(createAuthMiddleware(auth))
    app.get('/test', (_req, res) => {
      res.json({ ok: true })
    })
    const res = await request(app).get('/test').set('Authorization', `Bearer ${session.token}`)
    expect(res.status).toBe(401)
  }, 10000)

  it('middleware allows requests with valid token', async () => {
    const { auth } = setup()
    const { session } = await registerAndApproveAndAuth(auth)
    const app = express()
    app.use(createAuthMiddleware(auth))
    app.get('/test', (_req, res) => {
      res.json({ ok: true })
    })
    const res = await request(app).get('/test').set('Authorization', `Bearer ${session.token}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('bypasses device auth for requests from trusted Tailscale proxy', async () => {
    const { auth } = setup({ trustedProxies: ['127.0.0.1', '::1', '::ffff:127.0.0.1'] })
    const app = express()
    app.use(createAuthMiddleware(auth))
    app.get('/test', (_req, res) => {
      res.json({ ok: true })
    })
    const res = await request(app).get('/test')
    expect(res.status).toBe(200)
  })

  it('emits auth.device.approved on device approval', () => {
    const { auth, events } = setup()
    const kp = generateKeyPair()
    const device = auth.registerDevice(kp.publicKey, 'approve-test')
    auth.approveDevice(device.id)
    const approved = events.find((e) => e.type === 'auth.device.approved')
    expect(approved).toBeTruthy()
  })

  it('emits auth.device.rejected on device rejection', () => {
    const { auth, events } = setup()
    const kp = generateKeyPair()
    const device = auth.registerDevice(kp.publicKey, 'reject-test')
    auth.rejectDevice(device.id)
    const rejected = events.find((e) => e.type === 'auth.device.rejected')
    expect(rejected).toBeTruthy()
  })

  it('emits auth.session.created on session creation', async () => {
    const { auth, events } = setup()
    await registerAndApproveAndAuth(auth)
    const created = events.find((e) => e.type === 'auth.session.created')
    expect(created).toBeTruthy()
  })

  it('emits auth.session.expired on session expiry', async () => {
    const { auth, events } = setup({ tokenExpiry: '1s' })
    const { session } = await registerAndApproveAndAuth(auth)
    await new Promise((r) => setTimeout(r, 1500))
    await auth.validateToken(session.token)
    const expired = events.find((e) => e.type === 'auth.session.expired')
    expect(expired).toBeTruthy()
  }, 10000)

  it('revokes a device and invalidates its sessions immediately', async () => {
    const { auth } = setup()
    const { device, session } = await registerAndApproveAndAuth(auth)
    auth.revokeDevice(device.id)
    const result = await auth.validateToken(session.token)
    expect(result.valid).toBe(false)
  })

  it('allows multiple concurrent sessions per device', async () => {
    const { auth } = setup()
    const kp = generateKeyPair()
    const device = auth.registerDevice(kp.publicKey, 'multi-session')
    auth.approveDevice(device.id)

    const c1 = auth.createChallenge(kp.publicKey)
    const s1 = await auth.authenticate(kp.publicKey, c1, sign(kp.privateKey, c1))

    const c2 = auth.createChallenge(kp.publicKey)
    const s2 = await auth.authenticate(kp.publicKey, c2, sign(kp.privateKey, c2))

    expect(s1.token).not.toBe(s2.token)
    const r1 = await auth.validateToken(s1.token)
    const r2 = await auth.validateToken(s2.token)
    expect(r1.valid).toBe(true)
    expect(r2.valid).toBe(true)
  })

  it('all approved devices have full access', async () => {
    const { auth } = setup()
    const { session } = await registerAndApproveAndAuth(auth)
    const result = await auth.validateToken(session.token)
    expect(result.valid).toBe(true)
    expect(result.deviceId).toBeTruthy()
    // No scoped permissions — just valid or not
  })
})

describe('Auth Devices Store', () => {
  it('reads devices from disk', () => {
    const dataDir = tmpDir()
    const dir = path.join(dataDir, 'auth')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'devices.json'),
      JSON.stringify([
        { id: '1', publicKey: 'abc', name: 'test', status: 'pending', createdAt: new Date().toISOString() }
      ])
    )
    const store = createDeviceStore(dataDir)
    const devices = store.load()
    expect(devices).toHaveLength(1)
    expect(devices[0].name).toBe('test')
  })

  it('writes devices to disk atomically', () => {
    const dataDir = tmpDir()
    const store = createDeviceStore(dataDir)
    store.save([{ id: '1', publicKey: 'abc', name: 'atomic', status: 'pending', createdAt: new Date().toISOString() }])
    const file = path.join(dataDir, 'auth', 'devices.json')
    expect(fs.existsSync(file)).toBe(true)
    const tmp = file + '.tmp'
    expect(fs.existsSync(tmp)).toBe(false) // tmp cleaned up
  })

  it('creates data directory if it does not exist', () => {
    const dataDir = tmpDir()
    const store = createDeviceStore(dataDir)
    store.save([])
    expect(fs.existsSync(path.join(dataDir, 'auth'))).toBe(true)
  })
})

describe('Auth Crypto', () => {
  it('verifies Ed25519 signature', () => {
    const kp = generateKeyPair()
    const challenge = generateChallenge()
    const sig = sign(kp.privateKey, challenge)
    expect(verifySignature(kp.publicKey, challenge, sig)).toBe(true)
  })

  it('rejects invalid Ed25519 signature', () => {
    const kp = generateKeyPair()
    const challenge = generateChallenge()
    expect(verifySignature(kp.publicKey, challenge, 'bad'.repeat(32))).toBe(false)
  })

  it('generates challenge nonce', () => {
    const c1 = generateChallenge()
    const c2 = generateChallenge()
    expect(c1).toHaveLength(64) // 32 bytes hex
    expect(c1).not.toBe(c2)
  })
})
