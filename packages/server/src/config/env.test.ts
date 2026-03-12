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

  it('resolves SOVEREIGN_TERMINAL__SHELL to terminal.shell', () => {
    process.env.SOVEREIGN_TERMINAL__SHELL = '/bin/bash'
    const result = resolveEnvOverrides()
    expect(result).toEqual({ terminal: { shell: '/bin/bash' } })
  })

  it('ignores env vars without SOVEREIGN_ prefix', () => {
    process.env.OTHER_VAR = 'ignored'
    const result = resolveEnvOverrides()
    expect(result).toEqual({})
    delete process.env.OTHER_VAR
  })

  it('double underscore maps to nested path', () => {
    process.env.SOVEREIGN_PROJECTS__DEFAULTS__REMOTES = 'origin'
    const result = resolveEnvOverrides()
    expect(result).toEqual({ projects: { defaults: { remotes: 'origin' } } })
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
    process.env.SOVEREIGN_WORKTREES__AUTOCLEANUPMERGED = 'true'
    const result = resolveEnvOverrides()
    expect((result as any).worktrees.autocleanupmerged).toBe(true)
  })
})
