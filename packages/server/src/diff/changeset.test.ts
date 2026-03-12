import { describe, it } from 'vitest'

describe('ChangeSetManager', () => {
  describe('create change set', () => {
    it.todo('creates a change set from worktree (compares worktree branch to base)')
    it.todo('creates a change set from two arbitrary refs')
    it.todo('assigns a unique id')
    it.todo('sets initial status to "open"')
    it.todo('sets createdAt and updatedAt timestamps')
    it.todo('populates files list with changed file paths and statuses')
    it.todo('includes additions and deletions per file')
  })

  describe('cross-project change sets', () => {
    it.todo('supports change sets spanning multiple projects within an org')
  })

  describe('get change set', () => {
    it.todo('returns change set by id')
    it.todo('returns undefined for non-existent id')
  })

  describe('list change sets', () => {
    it.todo('lists all change sets')
    it.todo('filters by orgId')
    it.todo('filters by status')
    it.todo('filters by orgId and status combined')
  })

  describe('update change set', () => {
    it.todo('updates status')
    it.todo('updates title and description')
    it.todo('updates updatedAt timestamp')
    it.todo('returns the updated change set')
  })

  describe('delete change set', () => {
    it.todo('removes change set by id')
    it.todo('removes persisted JSON file')
  })

  describe('get change set file diff', () => {
    it.todo('returns FileDiff for a specific file in the change set')
  })

  describe('persistence', () => {
    it.todo('persists change sets as JSON files at {dataDir}/reviews/{changeSetId}.json')
    it.todo('loads persisted change sets on startup')
    it.todo('survives restart')
  })

  describe('bus events', () => {
    it.todo('emits changeset.created on create')
    it.todo('emits changeset.updated on update')
    it.todo('emits changeset.closed when status set to closed')
  })
})
