import { describe, expect, it } from 'vitest'

describe('Server — health router', () => {
  it('exports a default Router from routes/health', async () => {
    const mod = await import('./routes/health.js')
    expect(mod.default).toBeTruthy()
    // Express routers expose a .stack array of route layers
    expect(Array.isArray((mod.default as any).stack)).toBe(true)
  })

  it('health router has a GET / handler', async () => {
    const mod = await import('./routes/health.js')
    const layers = (mod.default as any).stack as { route?: { path: string; methods: Record<string, boolean> } }[]
    const getRoot = layers.find((l) => l.route?.path === '/' && l.route?.methods?.get)
    expect(getRoot).toBeTruthy()
  })
})

describe('Server — bootstrap', () => {
  it('exports bootstrapServer as a function', async () => {
    const mod = await import('./bootstrap.js')
    expect(typeof mod.bootstrapServer).toBe('function')
  })
})

describe('Server — lockfile', () => {
  it('exports createLockfile and pidLooksLikeSovereign', async () => {
    const mod = await import('./lockfile.js')
    expect(typeof mod.createLockfile).toBe('function')
    expect(typeof mod.pidLooksLikeSovereign).toBe('function')
  })
})

describe('Server — health schema', () => {
  it('parses a valid health response', async () => {
    const { healthResponseSchema } = await import('./schemas/health.js')
    const result = healthResponseSchema.parse({ status: 'ok', message: 'sovereign' })
    expect(result.status).toBe('ok')
    expect(result.message).toBe('sovereign')
  })

  it('rejects a response missing required fields', async () => {
    const { healthResponseSchema } = await import('./schemas/health.js')
    expect(() => healthResponseSchema.parse({ status: 'ok' })).toThrow()
  })
})
