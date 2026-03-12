import { describe, it } from 'vitest'

describe('Config Env Overrides', () => {
  it.todo('resolves SOVEREIGN_SERVER__PORT to server.port')
  it.todo('resolves SOVEREIGN_TERMINAL__SHELL to terminal.shell')
  it.todo('ignores env vars without SOVEREIGN_ prefix')
  it.todo('double underscore maps to nested path')
  it.todo('returns empty object when no SOVEREIGN_ vars set')
  it.todo('coerces numeric string to number')
  it.todo('coerces boolean string to boolean')
})
