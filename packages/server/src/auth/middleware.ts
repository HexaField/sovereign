import type { Request, Response, NextFunction } from 'express'
import type { Auth } from './auth.js'

export function createAuthMiddleware(auth: Auth) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Check trusted proxy
    const ip = req.ip || req.socket.remoteAddress || ''
    if (auth.isTrustedProxy(ip)) {
      return next()
    }

    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const token = authHeader.slice(7)
    const result = await auth.validateToken(token)
    if (!result.valid) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    ;(req as unknown as Record<string, unknown>).deviceId = result.deviceId
    next()
  }
}
