import { describe, it } from 'vitest'

describe('System Module', () => {
  describe('§9.2 — System Endpoints', () => {
    it.todo('§9.2 — GET /api/system/architecture returns module graph with modules array')
    it.todo('§9.2 — each module has name, status, subscribes, publishes')
    it.todo('§9.2 — GET /api/system/health returns health metrics')
    it.todo('§9.2 — health includes uptime, connections (ws, agentBackend), jobs, disk')
    it.todo('§9.2 — aggregates module status() functions for health data')
  })

  describe('§0.1 — Global Workspace Bootstrap', () => {
    it.todo('§0.1 — ensures _global workspace exists on startup')
    it.todo('§0.1 — creates _global with name "Global" and provider "radicle" if missing')
    it.todo('§9.5 — rejects setting _global provider to "github"')
    it.todo('§9.5 — rejects deleting _global workspace with 403')
  })
})
