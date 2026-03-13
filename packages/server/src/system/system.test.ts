import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { createEventBus } from '@template/core'
import { createSystemModule, type SystemModule } from './system.js'
import { createSystemRoutes } from './routes.js'
import { createOrgManager, type OrgManager } from '../orgs/orgs.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-system-test-'))
}

let dataDir: string
let bus: ReturnType<typeof createEventBus>
let system: SystemModule

beforeEach(() => {
  dataDir = tmpDir()
  bus = createEventBus(dataDir)
  system = createSystemModule(bus, dataDir)
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('System Module', () => {
  describe('§9.2 — System Endpoints', () => {
    it('§9.2 — GET /api/system/architecture returns module graph with modules array', async () => {
      const app = express()
      app.use(createSystemRoutes(system))
      const res = await request(app).get('/api/system/architecture')
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('modules')
      expect(Array.isArray(res.body.modules)).toBe(true)
    })

    it('§9.2 — each module has name, status, subscribes, publishes', async () => {
      system.registerModule({
        name: 'threads',
        status: 'healthy',
        subscribes: ['org.*'],
        publishes: ['thread.created']
      })
      const arch = system.getArchitecture()
      const mod = arch.modules.find((m) => m.name === 'threads')
      expect(mod).toBeDefined()
      expect(mod!.name).toBe('threads')
      expect(mod!.status).toBe('healthy')
      expect(mod!.subscribes).toEqual(['org.*'])
      expect(mod!.publishes).toEqual(['thread.created'])
    })

    it('§9.2 — GET /api/system/health returns health metrics', async () => {
      const app = express()
      app.use(createSystemRoutes(system))
      const res = await request(app).get('/api/system/health')
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('uptime')
      expect(res.body).toHaveProperty('connections')
      expect(res.body.connections).toHaveProperty('ws')
      expect(res.body.connections).toHaveProperty('agentBackend')
    })

    it('§9.2 — health includes uptime, connections (ws, agentBackend), jobs, disk', () => {
      const health = system.getHealth()
      expect(typeof health.uptime).toBe('number')
      expect(health.connections).toHaveProperty('ws')
      expect(health.connections).toHaveProperty('agentBackend')
      expect(health.jobs).toHaveProperty('active')
      expect(health.jobs).toHaveProperty('lastErrors')
      expect(health.disk).toHaveProperty('dataDir')
      expect(health.disk).toHaveProperty('usedBytes')
    })

    it('§9.2 — aggregates module status() functions for health data', () => {
      system.registerModule({ name: 'orgs', status: 'healthy', subscribes: [], publishes: ['org.created'] })
      system.registerModule({ name: 'threads', status: 'degraded', subscribes: ['org.*'], publishes: [] })
      const arch = system.getArchitecture()
      expect(arch.modules.length).toBeGreaterThanOrEqual(3) // system + orgs + threads
      expect(arch.modules.find((m) => m.name === 'orgs')!.status).toBe('healthy')
      expect(arch.modules.find((m) => m.name === 'threads')!.status).toBe('degraded')
    })
  })

  describe('§0.1 — Global Workspace Bootstrap', () => {
    let orgManager: OrgManager

    beforeEach(() => {
      orgManager = createOrgManager(bus, dataDir)
    })

    it('§0.1 — ensures _global workspace exists on startup', () => {
      const org = orgManager.ensureGlobalWorkspace()
      expect(org).toBeDefined()
      expect(org.id).toBe('_global')
      expect(orgManager.getOrg('_global')).toBeDefined()
    })

    it('§0.1 — creates _global with name "Global" and provider "radicle" if missing', () => {
      const org = orgManager.ensureGlobalWorkspace()
      expect(org.name).toBe('Global')
      expect(org.provider).toBe('radicle')
    })

    it('§0.1 — does not duplicate _global if already exists', () => {
      orgManager.ensureGlobalWorkspace()
      orgManager.ensureGlobalWorkspace()
      const orgs = orgManager.listOrgs().filter((o) => o.id === '_global')
      expect(orgs.length).toBe(1)
    })

    it('§9.5 — rejects setting _global provider to "github"', () => {
      orgManager.ensureGlobalWorkspace()
      expect(() => orgManager.updateOrg('_global', { provider: 'github' })).toThrow()
      try {
        orgManager.updateOrg('_global', { provider: 'github' })
      } catch (e: any) {
        expect(e.status).toBe(403)
      }
    })

    it('§9.5 — allows updating _global name', () => {
      orgManager.ensureGlobalWorkspace()
      const updated = orgManager.updateOrg('_global', { name: 'My Global' })
      expect(updated.name).toBe('My Global')
    })

    it('§9.5 — rejects deleting _global workspace with 403', () => {
      orgManager.ensureGlobalWorkspace()
      expect(() => orgManager.deleteOrg('_global')).toThrow()
      try {
        orgManager.deleteOrg('_global')
      } catch (e: any) {
        expect(e.status).toBe(403)
      }
    })

    it('§9.5 — DELETE /orgs/_global returns 403 via routes', async () => {
      orgManager.ensureGlobalWorkspace()
      const { createOrgRoutes } = await import('../orgs/routes.js')
      const app = express()
      app.use(express.json())
      app.use(
        '/api',
        createOrgRoutes(orgManager, (_req: any, _res: any, next: any) => next())
      )
      const res = await request(app).delete('/api/orgs/_global')
      expect(res.status).toBe(403)
    })

    it('§9.5 — PUT /orgs/_global with provider=github returns 403 via routes', async () => {
      orgManager.ensureGlobalWorkspace()
      const { createOrgRoutes } = await import('../orgs/routes.js')
      const app = express()
      app.use(express.json())
      app.use(
        '/api',
        createOrgRoutes(orgManager, (_req: any, _res: any, next: any) => next())
      )
      const res = await request(app).put('/api/orgs/_global').send({ provider: 'github' })
      expect(res.status).toBe(403)
    })
  })
})
