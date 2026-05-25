export interface Device {
  id: string
  publicKey: string
  name: string
  status: 'pending' | 'approved' | 'revoked'
  createdAt: string
  approvedAt?: string
  lastSeen?: string
}

export interface Session {
  token: string
  deviceId: string
  createdAt: string
  expiresAt: string
}
