// Config JSON Schema definition and validation

import Ajv from 'ajv'

export const schema = {
  type: 'object',
  properties: {
    server: {
      type: 'object',
      properties: {
        port: { type: 'number', minimum: 0, maximum: 65535 },
        host: { type: 'string' }
      },
      additionalProperties: false
    },
    terminal: {
      type: 'object',
      properties: {
        shell: { type: 'string' },
        gracePeriodMs: { type: 'number', minimum: 0 },
        maxSessions: { type: 'number', minimum: 1 }
      },
      additionalProperties: false
    },
    worktrees: {
      type: 'object',
      properties: {
        staleDays: { type: 'number', minimum: 0 },
        autoCleanupMerged: { type: 'boolean' }
      },
      additionalProperties: false
    },
    projects: {
      type: 'object',
      properties: {
        defaults: {
          type: 'object',
          properties: {
            remotes: { type: 'array', items: { type: 'string' } }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    }
  },
  additionalProperties: false
} as const

const ajv = new Ajv({ allErrors: true })
const validateFn = ajv.compile(schema)

export function validate(config: unknown): { valid: boolean; errors: string[] } {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return { valid: false, errors: ['config must be an object'] }
  }
  const valid = validateFn(config)
  if (valid) return { valid: true, errors: [] }
  const errors = (validateFn.errors ?? []).map((e) => `${e.instancePath || '/'}: ${e.message}`)
  return { valid: false, errors }
}
