import fs from 'node:fs'
import path from 'node:path'
import type { Org, Project } from './types.js'

export interface OrgStoreData {
  orgs: Org[]
  projects: Project[]
}

export interface OrgStore {
  read(): OrgStoreData
  write(data: OrgStoreData): void
  readOrgConfig(orgId: string): Record<string, unknown>
  writeOrgConfig(orgId: string, config: Record<string, unknown>): void
}

export function createOrgStore(dataDir: string): OrgStore {
  const orgsDir = path.join(dataDir, 'orgs')
  const orgsFile = path.join(orgsDir, 'orgs.json')

  const ensureDir = (dir: string) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  }

  const read = (): OrgStoreData => {
    ensureDir(orgsDir)
    if (!fs.existsSync(orgsFile)) return { orgs: [], projects: [] }
    return JSON.parse(fs.readFileSync(orgsFile, 'utf-8'))
  }

  const write = (data: OrgStoreData): void => {
    ensureDir(orgsDir)
    const tmp = orgsFile + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, orgsFile)
  }

  const configPath = (orgId: string) => path.join(orgsDir, orgId, 'config.json')

  const readOrgConfig = (orgId: string): Record<string, unknown> => {
    const p = configPath(orgId)
    if (!fs.existsSync(p)) return {}
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  }

  const writeOrgConfig = (orgId: string, config: Record<string, unknown>): void => {
    const dir = path.join(orgsDir, orgId)
    ensureDir(dir)
    const tmp = configPath(orgId) + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2))
    fs.renameSync(tmp, configPath(orgId))
  }

  return { read, write, readOrgConfig, writeOrgConfig }
}
