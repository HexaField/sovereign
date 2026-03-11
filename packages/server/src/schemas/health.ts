import { z } from 'zod'

/**
 * Schema for the health check API response.
 */
export const healthResponseSchema = z.object({
  status: z.string(),
  message: z.string()
})

/**
 * Type inferred from the healthResponseSchema.
 */
export type HealthResponse = z.infer<typeof healthResponseSchema>
