import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
// TODO: import { registerDraftRoutes } from './routes.js'
// TODO: import { createDraftStore } from './store.js'
// TODO: import type { Draft } from './types.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'draft-routes-'))
}

describe('Draft REST API', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = tmpDir()
  })
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  describe('§1.2 GET /api/drafts', () => {
    it.todo('1.2 MUST support ?orgId=<id> — return drafts assigned to this workspace')
    it.todo('1.2 MUST support ?unassigned=true — return drafts with orgId null')
    it.todo('1.2 MUST support ?status=draft (default)')
    it.todo('1.2 MUST support ?status=published')
    it.todo('1.2 MUST support ?status=all')
    it.todo('1.2 no filter MUST return all non-published drafts')
    it.todo('1.2 ?orgId=<id> MUST also include unassigned drafts')
  })

  describe('§1.2 POST /api/drafts', () => {
    it.todo('1.2 MUST validate that title is non-empty')
    it.todo('1.2 MUST return 400 if title is empty')
    it.todo('1.2 MUST create draft and return it on success')
  })

  describe('§1.2 GET /api/drafts/:id', () => {
    it.todo('1.2 MUST return the draft if found')
    it.todo('1.2 MUST return 404 if not found')
  })

  describe('§1.2 PATCH /api/drafts/:id', () => {
    it.todo('1.2 MUST return 404 if draft not found')
    it.todo('1.2 MUST update draft and return it on success')
  })

  describe('§1.2 DELETE /api/drafts/:id', () => {
    it.todo('1.2 MUST return 204 on success')
    it.todo('1.2 MUST return 404 if not found')
  })

  describe('§1.2 POST /api/drafts/:id/dependencies', () => {
    it.todo('1.2 MUST add dependency to draft')
  })

  describe('§1.2 DELETE /api/drafts/:id/dependencies/:index', () => {
    it.todo('1.2 MUST remove dependency by index')
  })

  describe('§4.1 POST /api/drafts/:id/publish', () => {
    it.todo('4.1 MUST validate that draft exists and has status draft')
    it.todo('4.1 MUST accept { orgId, projectId } in body')
    it.todo('4.1 MUST determine correct provider for the project via getRemotes')
    it.todo('4.1 MUST create issue on provider via issueTracker.create()')
    it.todo('4.1 MUST set draft status to published and set publishedAs')
    it.todo('4.1 MUST update other drafts that depended on this draft to point at new provider ref')
    it.todo('4.1 MUST return the created issue and updated draft')
    it.todo('4.1 MUST return 502 if provider create fails and MUST NOT change draft status')
    it.todo('4.1 MUST emit planning.draft.published on the event bus')
  })
})
