import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
// TODO: import { createDraftStore } from './store.js'
// TODO: import type { Draft, CreateDraft, UpdateDraft, DraftFilter } from './types.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'draft-store-'))
}

describe('DraftStore', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = tmpDir()
  })
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  describe('§1.1 Storage', () => {
    it.todo('1.1 MUST store drafts at {dataDir}/drafts/drafts.json as a single JSON array')
    it.todo('1.1 MUST NOT be scoped to any org — store is global')
    it.todo('1.1 published drafts MUST be retained for audit/history')
  })

  describe('§1.1 create', () => {
    it.todo('1.1 create MUST generate a UUID')
    it.todo('1.1 create MUST set status to draft')
    it.todo('1.1 create MUST set createdAt and updatedAt to now')
    it.todo('1.1 create MUST set publishedAs to null')
  })

  describe('§1.1 update', () => {
    it.todo('1.1 update MUST set updatedAt to now')
  })

  describe('§1.1 delete', () => {
    it.todo('1.1 delete MUST remove the draft permanently (not soft-delete)')
  })

  describe('§1.1 list', () => {
    it.todo('1.1 list with no filter MUST return all non-published drafts')
    it.todo('1.1 list with orgId filter MUST return drafts matching that orgId')
    it.todo('1.1 list with status filter MUST return drafts matching that status')
    it.todo('1.1 list with label filter MUST return drafts matching that label')
  })

  describe('§1.1 getByOrg', () => {
    it.todo('1.1 getByOrg(null) MUST return only unassigned drafts')
    it.todo('1.1 getByOrg(orgId) MUST return drafts assigned to that org')
  })

  describe('§1.1 atomic writes', () => {
    it.todo('1.1 all mutations MUST write to disk atomically (write temp then rename)')
  })
})
