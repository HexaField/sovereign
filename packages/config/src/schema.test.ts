import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validate, invalidConfigPaths, validateSecrets } from './schema.js'
import { createSecretsStore } from './secrets.js'
import { defaults } from './defaults.js'

describe('Config Schema', () => {
  describe('validation', () => {
    it('accepts valid full config', () => {
      const result = validate(defaults)
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it('accepts a full forge section and rejects bad forge values', () => {
      const forge = {
        ...defaults.forge,
        enabled: true,
        identities: { github: 'hex-agent' },
        repos: { acme: ['acme-labs/widget', 'git.example.org/acme-labs/gadget'] },
        githubApiUrl: 'http://mock-github:8910',
        githubToken: 'test-token',
        trustedAuthors: { acme: ['alex-dev', 'sam-reporter'], '*': ['alex-dev'] }
      }
      expect(defaults.forge.trustedAuthors).toEqual({})
      expect(validate({ forge }).valid).toBe(true)
      expect(validate({ forge: { ...forge, trustedAuthors: { acme: [''] } } }).valid).toBe(false)
      expect(validate({ forge: { ...forge, trustedAuthors: { acme: 'alex-dev' } } }).valid).toBe(false)
      expect(validate({ forge: { ...forge, rethink: { ...forge.rethink, times: ['25:00'] } } }).valid).toBe(false)
      expect(validate({ forge: { ...forge, pollOpenMs: 10 } }).valid).toBe(false)
      expect(validate({ forge: { ...forge, identities: { gitlab: 'x' } } }).valid).toBe(false)
      expect(invalidConfigPaths({ forge: { ...forge, unknown: 1 } })).toContain('/forge/unknown')
      const classifier = { url: 'http://127.0.0.1:8080', model: 'decider', timeoutMs: 3000 }
      expect(validate({ forge: { ...forge, classifier } }).valid).toBe(true)
      expect(validate({ forge: { ...forge, classifier: { model: 'decider' } } }).valid).toBe(false)
      expect(validate({ forge: { ...forge, classifier: { ...classifier, timeoutMs: 1 } } }).valid).toBe(false)
      expect(invalidConfigPaths({ forge: { ...forge, classifier: { ...classifier, extra: 1 } } })).toContain(
        '/forge/classifier/extra'
      )
    })

    it('accepts harness profiles and model endpoints, and rejects bad ones', () => {
      expect(Object.keys(defaults.agentBackend.harnesses)).toEqual(['claude', 'devin'])
      expect(defaults.agentBackend.harnesses.devin).toEqual({
        adapter: 'devin',
        model: 'swe-2-high',
        sandbox: 'harness',
        allowedRoots: ['~/workspaces/coasys'],
        configFile: '~/.config/devin/executor.json',
        mcp: true
      })
      expect(defaults.agentBackend.endpoints).toEqual({})
      const ab = defaults.agentBackend
      const endpoints = {
        studio: { api: 'openai', baseUrl: 'http://studio.example:8080/v1', local: true },
        cloud: { api: 'anthropic', baseUrl: 'https://llm.example/v1', apiKeySecret: 'cloudKey', local: false }
      }
      const harnesses = {
        ...ab.harnesses,
        pi: { adapter: 'pi', model: 'qwen3', endpoint: 'studio', sandbox: 'bwrap', allowedRoots: ['~/w'] },
        codex: {
          adapter: 'codex',
          model: 'gpt-x',
          endpoint: 'cloud',
          extraArgs: ['--x'],
          extraEnv: { A: 'b' },
          timeoutMinutes: 30
        }
      }
      expect(validate({ agentBackend: { ...ab, harnesses, endpoints } }).valid).toBe(true)
      expect(validate({ agentBackend: { ...ab, subagentDefaults: { harness: 'pi' } } }).valid).toBe(true)
      // An unknown adapter, a sandbox mode that does not exist, an endpoint without a URL.
      expect(validate({ agentBackend: { ...ab, harnesses: { x: { adapter: 'cursor', model: 'm' } } } }).valid).toBe(
        false
      )
      expect(
        validate({ agentBackend: { ...ab, harnesses: { x: { adapter: 'pi', model: 'm', sandbox: 'docker' } } } }).valid
      ).toBe(false)
      expect(validate({ agentBackend: { ...ab, endpoints: { e: { api: 'openai', local: true } } } }).valid).toBe(false)
      // A key belongs in the secret store, never in config.json.
      expect(
        invalidConfigPaths({ agentBackend: { ...ab, endpoints: { e: { ...endpoints.studio, apiKey: 'sk-1' } } } })
      ).toContain('/agentBackend/endpoints/e/apiKey')
      // The key itself lives in the secret store under the name apiKeySecret gives.
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-test-'))
      try {
        createSecretsStore(dataDir).set('cloudKey', 'sk-1')
        expect(createSecretsStore(dataDir).get('cloudKey')).toBe('sk-1')
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true })
      }
      expect(validateSecrets({ cloudKey: 'sk-1' }).valid).toBe(true)
      expect(validateSecrets({ cloudKey: 1 }).valid).toBe(false)
      // The 26cea62 Devin section is gone: its fields live in the devin profile.
      expect(invalidConfigPaths({ agentBackend: { ...ab, devin: { defaultModel: 'swe-2-high' } } })).toContain(
        '/agentBackend/devin'
      )
    })

    it('accepts the graphcoder flag, off by default, and rejects bad values', () => {
      expect(defaults.graphcoder).toEqual({ enabled: false })
      expect(validate({ graphcoder: { enabled: true } }).valid).toBe(true)
      expect(validate({ graphcoder: { enabled: 'yes' } }).valid).toBe(false)
      expect(invalidConfigPaths({ graphcoder: { enabled: true, repos: [] } })).toContain('/graphcoder/repos')
    })

    it('accepts config with only some keys (defaults fill rest)', () => {
      const result = validate({ server: { port: 3001, host: 'localhost' } })
      expect(result.valid).toBe(true)
    })

    it('rejects non-object config', () => {
      expect(validate('string').valid).toBe(false)
      expect(validate(null).valid).toBe(false)
      expect(validate(42).valid).toBe(false)
    })

    it('rejects invalid server.port type', () => {
      const result = validate({ server: { port: 'not-a-number', host: 'localhost' } })
      expect(result.valid).toBe(false)
      expect(result.errors.length).toBeGreaterThan(0)
    })

    it('rejects negative port number', () => {
      const result = validate({ server: { port: -1, host: 'localhost' } })
      expect(result.valid).toBe(false)
    })

    it('returns detailed error messages for each violation', () => {
      const result = validate({ server: { port: 'bad', host: 123 } })
      expect(result.valid).toBe(false)
      expect(result.errors.length).toBeGreaterThanOrEqual(2)
    })

    it('rejects unknown top-level keys', () => {
      const result = validate({ unknownKey: true })
      expect(result.valid).toBe(false)
    })
  })

  describe('invalidConfigPaths', () => {
    it('returns [] for valid config', () => {
      expect(invalidConfigPaths(defaults)).toEqual([])
      expect(invalidConfigPaths({ server: { port: 3001, host: 'localhost' } })).toEqual([])
    })

    it('returns [] for a non-object', () => {
      expect(invalidConfigPaths('nope')).toEqual([])
    })

    it('points at the bad leaf for a type/enum violation', () => {
      expect(invalidConfigPaths({ server: { port: 'bad' } })).toContain('/server/port')
    })

    it('points at the offending child key for additionalProperties violations', () => {
      // The dead key itself, not the whole /agentBackend section.
      const paths = invalidConfigPaths({ agentBackend: { openclaw: { gatewayUrl: 'ws://x' } } })
      expect(paths).toContain('/agentBackend/openclaw')
      expect(paths).not.toContain('/agentBackend')
    })

    it('trims an invalid array item back to the array key', () => {
      // /agentBackend/enabled/0 → /agentBackend/enabled, so the field is dropped
      // wholesale and defaults restore a coherent value.
      const paths = invalidConfigPaths({ agentBackend: { enabled: ['openclaw'] } })
      expect(paths).toContain('/agentBackend/enabled')
      expect(paths).not.toContain('/agentBackend/enabled/0')
    })
  })
})
