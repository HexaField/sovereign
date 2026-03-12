import { describe, it } from 'vitest'

describe('ReviewSystem', () => {
  describe('create review', () => {
    it.todo('creates a review from worktree branch')
    it.todo('creates a local change set via diff engine')
    it.todo('pushes branch to remote if not already pushed')
    it.todo('creates PR/patch via provider')
    it.todo('links local change set to provider review')
    it.todo('sets initial status to "open"')
    it.todo('assigns reviewers if specified')
  })

  describe('multi-remote support', () => {
    it.todo('creates review on specified remote')
    it.todo('lists reviews across all remotes')
    it.todo('each review carries a remote field')
  })

  describe('get', () => {
    it.todo('returns review by id')
    it.todo('returns undefined for non-existent review')
  })

  describe('list', () => {
    it.todo('lists all reviews for an org')
    it.todo('filters by projectId')
    it.todo('filters by status')
    it.todo('aggregates across remotes')
  })

  describe('review actions', () => {
    it.todo('approve proxies to provider (gh pr review --approve)')
    it.todo('requestChanges proxies to provider with comment')
    it.todo('comment adds review comment (not approval/rejection)')
  })

  describe('merge', () => {
    it.todo('merges via provider (gh pr merge / rad patch merge)')
    it.todo('cleans up local worktree on merge')
    it.todo('updates local change set status to merged')
    it.todo('emits review.merged event on the bus')
  })

  describe('inline comments', () => {
    it.todo('adds inline comment with filePath, lineNumber, side')
    it.todo('syncs local comment to provider')
    it.todo('pulls provider comments into local cache on sync')
    it.todo('supports comment resolution state')
    it.todo('syncs resolution state where supported (GitHub)')
    it.todo('supports threaded replies via replyTo')
  })

  describe('offline support', () => {
    it.todo('reads from cache when provider unreachable')
  })

  describe('bus events', () => {
    it.todo('emits review.created on create')
    it.todo('emits review.updated on update')
    it.todo('emits review.comment.added on addComment')
    it.todo('emits review.comment.resolved on resolveComment')
    it.todo('emits review.approved on approve')
    it.todo('emits review.changes_requested on requestChanges')
    it.todo('emits review.merged on merge')
  })

  describe('dependency inversion', () => {
    it.todo('does NOT directly import from git module')
    it.todo('does NOT directly import from worktree module')
    it.todo('does NOT directly import from diff module')
    it.todo('uses injected deps for all cross-module interaction')
  })

  describe('sync', () => {
    it.todo('syncs reviews from all remotes for a project')
    it.todo('returns synced count and error count')
  })
})
