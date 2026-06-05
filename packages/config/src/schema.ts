// Config JSON Schema definition and validation
//
// x-reload annotations classify each key:
//   'hot'     — picked up on next configStore.get()
//   'session' — applies to new sessions/connections only
//   'restart' — process restart required (PATCH still durable)

import Ajv from 'ajv'

const stringHot = { type: 'string', 'x-reload': 'hot' } as const
const stringSession = { type: 'string', 'x-reload': 'session' } as const
const stringRestart = { type: 'string', 'x-reload': 'restart' } as const

export const schema = {
  type: 'object',
  properties: {
    server: {
      type: 'object',
      properties: {
        port: { type: 'number', minimum: 0, maximum: 65535, 'x-reload': 'restart' },
        host: { ...stringRestart },
        tls: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean', 'x-reload': 'restart' }
          },
          required: ['enabled'],
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    terminal: {
      type: 'object',
      properties: {
        shell: { ...stringHot },
        gracePeriodMs: { type: 'number', minimum: 0, 'x-reload': 'session' },
        maxSessions: { type: 'number', minimum: 1, 'x-reload': 'restart' }
      },
      additionalProperties: false
    },
    worktrees: {
      type: 'object',
      properties: {
        staleDays: { type: 'number', minimum: 0, 'x-reload': 'hot' },
        autoCleanupMerged: { type: 'boolean', 'x-reload': 'hot' }
      },
      additionalProperties: false
    },
    projects: {
      type: 'object',
      properties: {
        defaults: {
          type: 'object',
          properties: {
            remotes: { type: 'array', items: { type: 'string' }, 'x-reload': 'hot' }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    workspace: {
      type: 'object',
      properties: {
        root: { ...stringSession },
        globalPath: { ...stringRestart }
      },
      additionalProperties: false
    },
    agentBackend: {
      type: 'object',
      properties: {
        enabled: {
          type: 'array',
          items: { type: 'string', enum: ['claude-code'] },
          'x-reload': 'restart'
        },
        default: { type: 'string', enum: ['claude-code'], 'x-reload': 'restart' },
        claudeCode: {
          type: 'object',
          properties: {
            cwd: { ...stringSession },
            agentDir: { ...stringSession },
            defaultModel: { ...stringSession },
            modelContextWindows: {
              type: 'object',
              additionalProperties: { type: 'number' },
              'x-reload': 'session'
            }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    ad4m: {
      type: 'object',
      properties: {
        host: { ...stringRestart },
        mcpUrl: { ...stringSession }
      },
      additionalProperties: false
    },
    voice: {
      type: 'object',
      properties: {
        transcribeUrl: { ...stringHot },
        ttsUrl: { ...stringHot }
      },
      additionalProperties: false
    },
    meetings: {
      type: 'object',
      properties: {
        summarizeUrl: { ...stringHot }
      },
      additionalProperties: false
    },
    identity: {
      type: 'object',
      properties: {
        agentName: { ...stringHot },
        agentIcon: { ...stringHot }
      },
      additionalProperties: false
    },
    models: {
      type: 'object',
      properties: {
        available: { type: 'array', items: { type: 'string' }, 'x-reload': 'hot' },
        default: { ...stringHot }
      },
      additionalProperties: false
    },
    personality: {
      type: 'object',
      properties: {
        sourceDir: { ...stringHot },
        files: { type: 'array', items: { type: 'string' }, 'x-reload': 'hot' },
        separator: { ...stringHot }
      },
      additionalProperties: false
    },
    seed: {
      type: 'object',
      properties: {
        membraneId: { ...stringRestart },
        membraneName: { ...stringRestart },
        threadLabel: { ...stringRestart }
      },
      additionalProperties: false
    }
  },
  additionalProperties: false
} as const

/** Secret keys live in {dataDir}/secrets.json, not config.json. */
export const secretsSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false
} as const

const ajv = new Ajv({ allErrors: true, strict: false })
const validateFn = ajv.compile(schema)
const validateSecretsFn = ajv.compile(secretsSchema)

export function validate(config: unknown): { valid: boolean; errors: string[] } {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return { valid: false, errors: ['config must be an object'] }
  }
  const valid = validateFn(config)
  if (valid) return { valid: true, errors: [] }
  const errors = (validateFn.errors ?? []).map((e) => `${e.instancePath || '/'}: ${e.message}`)
  return { valid: false, errors }
}

/**
 * For an invalid config, return the JSON-pointer paths of the offending nodes —
 * precise enough to prune just the bad keys and let defaults backfill, instead
 * of discarding the entire config. Returns [] when the config is valid.
 *
 * - `additionalProperties` violations point at the parent (e.g. `/agentBackend`)
 *   with the offending key in `params.additionalProperty`; we append it so the
 *   path addresses the dead key itself (`/agentBackend/openclaw`), not the whole
 *   section.
 * - Array-item violations carry the index (e.g. `/agentBackend/enabled/0`); we
 *   trim back to the array key (`/agentBackend/enabled`) so the field is dropped
 *   wholesale and defaults restore a coherent value rather than a holey array.
 */
export function invalidConfigPaths(config: unknown): string[] {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return []
  if (validateFn(config)) return []
  const paths = new Set<string>()
  for (const e of validateFn.errors ?? []) {
    if (e.keyword === 'additionalProperties') {
      const extra = (e.params as { additionalProperty?: string }).additionalProperty
      if (extra) paths.add(`${e.instancePath}/${extra}`)
      continue
    }
    // Trim a trailing array index (and anything after it) back to the array key.
    const segs = e.instancePath.split('/')
    const firstIdx = segs.findIndex((s, i) => i > 0 && /^\d+$/.test(s))
    paths.add(firstIdx === -1 ? e.instancePath : segs.slice(0, firstIdx).join('/'))
  }
  // Drop the empty-string path (whole-document error) — nothing precise to prune.
  paths.delete('')
  return [...paths]
}

export function validateSecrets(secrets: unknown): { valid: boolean; errors: string[] } {
  if (typeof secrets !== 'object' || secrets === null || Array.isArray(secrets)) {
    return { valid: false, errors: ['secrets must be an object'] }
  }
  const valid = validateSecretsFn(secrets)
  if (valid) return { valid: true, errors: [] }
  const errors = (validateSecretsFn.errors ?? []).map((e) => `${e.instancePath || '/'}: ${e.message}`)
  return { valid: false, errors }
}

/** Returns true if `dotPath` is a secret key. Keep this in sync with secretsSchema. */
export function isSecretPath(dotPath: string): boolean {
  return dotPath === 'secrets' || dotPath.startsWith('secrets.')
}
