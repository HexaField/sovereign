import { describe, it, expect, afterEach } from 'vitest'
import { resolveEnvOverrides } from './env.js'

const cleanEnv = () => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('SOVEREIGN_')) delete process.env[key]
  }
}

afterEach(cleanEnv)

describe('Config Env Overrides', () => {
  it('resolves SOVEREIGN_SERVER__PORT to server.port', () => {
    process.env.SOVEREIGN_SERVER__PORT = '8080'
    const result = resolveEnvOverrides()
    expect(result).toEqual({ server: { port: 8080 } })
  })

  it('resolves SOVEREIGN_AD4M__HOST to ad4m.host', () => {
    process.env.SOVEREIGN_AD4M__HOST = 'https://example.com'
    const result = resolveEnvOverrides()
    expect(result).toEqual({ ad4m: { host: 'https://example.com' } })
  })

  it('ignores env vars without SOVEREIGN_ prefix', () => {
    process.env.OTHER_VAR = 'ignored'
    const result = resolveEnvOverrides()
    expect(result).toEqual({})
    delete process.env.OTHER_VAR
  })

  it('double underscore maps to nested path', () => {
    process.env.SOVEREIGN_SERVER__TLS__ENABLED = 'true'
    const result = resolveEnvOverrides()
    expect(result).toEqual({ server: { tls: { enabled: true } } })
  })

  it('returns empty object when no SOVEREIGN_ vars set', () => {
    const result = resolveEnvOverrides()
    expect(result).toEqual({})
  })

  it('coerces numeric string to number', () => {
    process.env.SOVEREIGN_SERVER__PORT = '3000'
    const result = resolveEnvOverrides()
    expect(result).toEqual({ server: { port: 3000 } })
    expect(typeof (result as any).server.port).toBe('number')
  })

  it('coerces boolean string to boolean', () => {
    process.env.SOVEREIGN_VOICE__AUTOTTS = 'true'
    const result = resolveEnvOverrides()
    expect((result as any).voice.autotts).toBe(true)
  })
})
