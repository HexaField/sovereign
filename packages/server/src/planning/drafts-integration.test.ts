import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'
// TODO: import { createPlanningService } from './planning.js'
// TODO: import { createDraftStore } from '../drafts/store.js'
// TODO: import type { Draft } from '../drafts/types.js'
// TODO: import type { PlanningDeps } from './types.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'draft-integration-'))
}

describe('Drafts — DAG Integration', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = tmpDir()
  })

  describe('§2.1 GraphNode abstraction', () => {
    it.todo('2.1 GraphNode MUST have a source discriminator (provider | draft)')
    it.todo(
      '2.1 EntityRef for drafts MUST use synthetic format { orgId: _drafts, projectId: _local, remote: _local, issueId: draft.id }'
    )
    it.todo('2.1 graph engine MUST NOT distinguish between draft and provider nodes for graph computations')
  })

  describe('§2.2 Draft injection into graph build', () => {
    it.todo('2.2 buildGraph() MUST load drafts from draft store after loading provider issues')
    it.todo('2.2 drafts with orgId matching requested org MUST be included')
    it.todo('2.2 unassigned drafts (orgId null) MUST be included in every graph build')
    it.todo('2.2 each draft MUST be converted to IssueSnapshot equivalent using synthetic EntityRef')
    it.todo('2.2 draft dependencies { kind: draft, draftId } MUST resolve to draft synthetic EntityRef')
    it.todo('2.2 draft dependencies { kind: provider, ref } MUST be used directly as EntityRef')
    it.todo('2.2 drafts MUST appear as state open in the graph')
    it.todo('2.2 published drafts MUST NOT appear in future graph builds')
  })

  describe('§2.3 Dependency edges between drafts and provider issues', () => {
    it.todo('2.3 draft depending on provider issue MUST create edge { from: draft.syntheticRef, to: providerRef }')
    it.todo(
      '2.3 draft depending on another draft MUST create edge { from: draft.syntheticRef, to: otherDraft.syntheticRef }'
    )
    it.todo(
      '2.3 provider issue referencing draft via body text "depends on draft:<uuid>" MUST resolve to draft synthetic EntityRef'
    )
    it.todo(
      '2.3 when draft is published, other drafts depending on it MUST have dependencies updated to new provider EntityRef'
    )
  })
})
