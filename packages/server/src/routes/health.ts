import { SHARED_CONSTANT } from '@template/core'
import { Router } from 'express'
import type { Request, Response } from 'express'
import { healthResponseSchema } from '../schemas/health'

const router = Router()

router.get('/', (_req: Request, res: Response) => {
  const result = healthResponseSchema.parse({
    status: 'ok',
    message: SHARED_CONSTANT
  })
  res.json(result)
})

/**
 * Router to handle health check requests.
 */
export default router
