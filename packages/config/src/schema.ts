// Config JSON Schema definition and validation

import Ajv from 'ajv'

export const schema = {
  type: 'object',
  properties: {
    server: {
      type: 'object',
      properties: {
        port: { type: 'number', minimum: 0, maximum: 65535 },
        host: { type: 'string' },
        tls: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' }
          },
          required: ['enabled'],
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    workspace: {
      type: 'object',
      properties: {
        root: { type: 'string' },
        globalPath: { type: 'string' }
      },
      additionalProperties: false
    },
    agentBackend: {
      type: 'object',
      properties: {
        enabled: {
          type: 'array',
          items: { type: 'string', enum: ['claude-code', 'local-llm', 'mock'] }
        },
        default: { type: 'string', enum: ['claude-code', 'local-llm', 'mock'] },
        claudeCode: {
          type: 'object',
          properties: {
            cwd: { type: 'string' },
            agentDir: { type: 'string' },
            defaultModel: { type: 'string' },
            modelContextWindows: {
              type: 'object',
              additionalProperties: { type: 'number' }
            },
            litellm: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                apiKey: { type: 'string' }
              },
              required: ['url'],
              additionalProperties: false
            }
          },
          additionalProperties: false
        },
        localLlm: {
          type: 'object',
          properties: {
            baseUrl: { type: 'string' },
            model: { type: 'string' },
            contextWindow: { type: 'number', minimum: 1 },
            temperature: { type: 'number', minimum: 0, maximum: 2 },
            maxTokens: { type: 'number', minimum: 1 },
            timeoutMs: { type: 'number', minimum: 1000 },
            /** @deprecated — use reasoning instead; kept for backward-compat deserialization */
            thinking: { type: 'boolean' },
            reasoning: {
              type: 'object',
              properties: {
                enabled: { type: 'boolean' },
                effort: { type: 'string', enum: ['low', 'medium', 'high'] },
                maxTokens: { type: 'number', minimum: 0 }
              },
              required: ['enabled', 'effort', 'maxTokens'],
              additionalProperties: false
            },
            toolCallFormat: { type: 'string' },
            sandbox: {
              type: 'object',
              properties: {
                allowedCwds: { type: 'array', items: { type: 'string' } },
                bashTimeout: { type: 'number', minimum: 0 }
              },
              additionalProperties: false
            },
            endpoints: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  label: { type: 'string' },
                  baseUrl: { type: 'string' },
                  models: { type: 'array', items: { type: 'string' } },
                  defaultModel: { type: 'string' },
                  overrides: {
                    type: 'object',
                    properties: {
                      temperature: { type: 'number', minimum: 0, maximum: 2 },
                      maxTokens: { type: 'number', minimum: 1 },
                      contextWindow: { type: 'number', minimum: 1 },
                      compactThreshold: { type: 'number', minimum: 1 },
                      timeoutMs: { type: 'number', minimum: 1000 },
                      reasoning: {
                        type: 'object',
                        properties: {
                          enabled: { type: 'boolean' },
                          effort: { type: 'string' },
                          maxTokens: { type: 'number', minimum: 0 }
                        },
                        additionalProperties: false
                      }
                    },
                    additionalProperties: false
                  }
                },
                required: ['id', 'baseUrl', 'models'],
                additionalProperties: false
              }
            },
            compactThreshold: { type: 'number', minimum: 1 }
          },
          additionalProperties: false
        },
        subagentDefaults: {
          type: 'object',
          properties: {
            backend: { type: 'string' },
            model: { type: 'string' }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    ad4m: {
      type: 'object',
      properties: {
        host: { type: 'string' },
        mcpUrl: { type: 'string' }
      },
      additionalProperties: false
    },
    voice: {
      type: 'object',
      properties: {
        transcribeUrl: { type: 'string' },
        ttsUrl: { type: 'string' },
        autoTts: { type: 'boolean' },
        ackDelayMs: { type: 'number', minimum: 0, maximum: 10000 },
        conversationSummary: { type: 'boolean' },
        prompts: {
          type: 'object',
          properties: {
            ackSystem: { type: 'string' },
            summarySystem: { type: 'string' },
            conversationSummarySystem: { type: 'string' }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    meetings: {
      type: 'object',
      properties: {
        summarizeUrl: { type: 'string' }
      },
      additionalProperties: false
    },
    services: {
      type: 'object',
      properties: {
        external: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              label: { type: 'string' },
              healthUrl: { type: 'string' },
              port: { type: 'number', minimum: 1, maximum: 65535 },
              path: { type: 'string' }
            },
            required: ['name', 'healthUrl', 'port'],
            additionalProperties: false
          }
        }
      },
      additionalProperties: false
    },
    identity: {
      type: 'object',
      properties: {
        agentName: { type: 'string' },
        agentIcon: { type: 'string' }
      },
      additionalProperties: false
    },
    models: {
      type: 'object',
      properties: {
        available: { type: 'array', items: { type: 'string' } },
        default: { type: 'string' }
      },
      additionalProperties: false
    },
    personality: {
      type: 'object',
      properties: {
        sourceDir: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        separator: { type: 'string' }
      },
      additionalProperties: false
    },
    seed: {
      type: 'object',
      properties: {
        membraneId: { type: 'string' },
        membraneName: { type: 'string' },
        threadLabel: { type: 'string' }
      },
      additionalProperties: false
    },
    contextManagement: {
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            trimThresholdBytes: { type: 'number', minimum: 0 },
            trimMaxLines: { type: 'number', minimum: 1 },
            dedupMinBytes: { type: 'number', minimum: 0 },
            stripSignatures: { type: 'boolean' }
          },
          additionalProperties: false
        },
        recycle: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            thresholdPercent: { type: 'number', minimum: 0, maximum: 100 },
            minIntervalMs: { type: 'number', minimum: 0 },
            prescription: { type: 'string' },
            skipDuringSubagents: { type: 'boolean' }
          },
          additionalProperties: false
        },
        cleanup: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            maxSessionSizeMB: { type: 'number', minimum: 0 },
            schedule: { type: 'string' }
          },
          additionalProperties: false
        }
      },
      additionalProperties: false
    },
    summary: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        baseUrl: { type: 'string' },
        model: { type: 'string' },
        debounceMs: { type: 'number', minimum: 0 },
        maxSummaryWords: { type: 'number', minimum: 1 }
      },
      additionalProperties: false
    },
    deviceOverrides: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          sshHost: { type: 'string' },
          osHint: { type: 'string' },
          watchServices: { type: 'array', items: { type: 'string' } }
        },
        additionalProperties: false
      }
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
