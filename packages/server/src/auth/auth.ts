import crypto from 'node:crypto'
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose'
import type { EventBus } from '@template/core'
import type { Device, Session } from './types.js'
import { createDeviceStore, type DeviceStore } from './devices.js'
import { generateChallenge, verifySignature } from './crypto.js'

export interface AuthConfig {
  tokenExpiry: string // e.g. '1h', '7d'
  trustedProxies: string[] // Tailscale IPs
}

export interface Auth {
  registerDevice(publicKey: string, name: string): Device
  approveDevice(deviceId: string): Device
  rejectDevice(deviceId: string): void
  revokeDevice(deviceId: string): void
  devices(): Device[]
  createChallenge(publicKey: string): string
  authenticate(publicKey: string, challenge: string, signature: string): Promise<Session>
  validateToken(token: string): Promise<{ valid: boolean; deviceId?: string }>
  isTrustedProxy(ip: string): boolean
}

const JWT_SECRET = crypto.randomBytes(32)

export function createAuth(bus: EventBus, dataDir: string, config: AuthConfig): Auth {
  const store: DeviceStore = createDeviceStore(dataDir)
  let deviceList: Device[] = store.load()
  const activeSessions = new Map<string, Session>() // token -> Session
  const challenges = new Map<string, string>() // publicKey -> challenge

  function findDevice(id: string): Device | undefined {
    return deviceList.find((d) => d.id === id)
  }

  function findDeviceByKey(publicKey: string): Device | undefined {
    return deviceList.find((d) => d.publicKey === publicKey)
  }

  function persist(): void {
    store.save(deviceList)
  }

  function parseExpiry(exp: string): number {
    const match = exp.match(/^(\d+)([smhd])$/)
    if (!match) return 3600 * 1000
    const val = parseInt(match[1], 10)
    const unit = match[2]
    const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 }
    return val * (multipliers[unit] || 3600000)
  }

  return {
    registerDevice(publicKey: string, name: string): Device {
      const existing = findDeviceByKey(publicKey)
      if (existing) return existing

      const device: Device = {
        id: crypto.randomUUID(),
        publicKey,
        name,
        status: 'pending',
        createdAt: new Date().toISOString()
      }
      deviceList.push(device)
      persist()

      bus.emit({
        type: 'auth.device.pending',
        timestamp: new Date().toISOString(),
        source: 'auth',
        payload: { deviceId: device.id, name: device.name }
      })

      return device
    },

    approveDevice(deviceId: string): Device {
      const device = findDevice(deviceId)
      if (!device) throw new Error('Device not found')
      device.status = 'approved'
      device.approvedAt = new Date().toISOString()
      persist()

      bus.emit({
        type: 'auth.device.approved',
        timestamp: new Date().toISOString(),
        source: 'auth',
        payload: { deviceId: device.id }
      })

      return device
    },

    rejectDevice(deviceId: string): void {
      const device = findDevice(deviceId)
      if (!device) throw new Error('Device not found')
      deviceList = deviceList.filter((d) => d.id !== deviceId)
      persist()

      bus.emit({
        type: 'auth.device.rejected',
        timestamp: new Date().toISOString(),
        source: 'auth',
        payload: { deviceId }
      })
    },

    revokeDevice(deviceId: string): void {
      const device = findDevice(deviceId)
      if (!device) throw new Error('Device not found')
      device.status = 'revoked'
      persist()

      // Invalidate all sessions for this device
      for (const [token, session] of activeSessions) {
        if (session.deviceId === deviceId) {
          activeSessions.delete(token)
        }
      }

      bus.emit({
        type: 'auth.device.rejected',
        timestamp: new Date().toISOString(),
        source: 'auth',
        payload: { deviceId }
      })
    },

    devices(): Device[] {
      return [...deviceList]
    },

    createChallenge(publicKey: string): string {
      const challenge = generateChallenge()
      challenges.set(publicKey, challenge)
      return challenge
    },

    async authenticate(publicKey: string, challenge: string, signature: string): Promise<Session> {
      const storedChallenge = challenges.get(publicKey)
      if (!storedChallenge || storedChallenge !== challenge) {
        throw new Error('Invalid challenge')
      }

      if (!verifySignature(publicKey, challenge, signature)) {
        throw new Error('Invalid signature')
      }

      const device = findDeviceByKey(publicKey)
      if (!device) throw new Error('Device not found')
      if (device.status !== 'approved') throw new Error('Device not approved')

      challenges.delete(publicKey)

      const expiryMs = parseExpiry(config.tokenExpiry)
      const now = new Date()
      const expiresAt = new Date(now.getTime() + expiryMs)

      const token = await new SignJWT({ deviceId: device.id, jti: crypto.randomUUID() })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(expiresAt)
        .sign(JWT_SECRET)

      const session: Session = {
        token,
        deviceId: device.id,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString()
      }

      activeSessions.set(token, session)
      device.lastSeen = now.toISOString()
      persist()

      bus.emit({
        type: 'auth.session.created',
        timestamp: now.toISOString(),
        source: 'auth',
        payload: { deviceId: device.id, expiresAt: session.expiresAt }
      })

      return session
    },

    async validateToken(token: string): Promise<{ valid: boolean; deviceId?: string }> {
      try {
        const { payload } = await jwtVerify(token, JWT_SECRET)
        const deviceId = payload.deviceId as string

        // Check device not revoked
        const device = findDevice(deviceId)
        if (!device || device.status === 'revoked') {
          return { valid: false }
        }

        // Check session still active
        const session = activeSessions.get(token)
        if (!session) {
          return { valid: false }
        }

        return { valid: true, deviceId }
      } catch (err) {
        if (err instanceof joseErrors.JWTExpired) {
          // Find and clean up expired session
          const session = activeSessions.get(token)
          if (session) {
            activeSessions.delete(token)
            bus.emit({
              type: 'auth.session.expired',
              timestamp: new Date().toISOString(),
              source: 'auth',
              payload: { deviceId: session.deviceId }
            })
          }
        }
        return { valid: false }
      }
    },

    isTrustedProxy(ip: string): boolean {
      return config.trustedProxies.includes(ip)
    }
  }
}
