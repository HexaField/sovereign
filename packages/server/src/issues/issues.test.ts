import { describe, it } from 'vitest'

describe('IssueTracker', () => {
  describe('list', () => {
    it.todo('lists issues across all remotes for a project')
    it.todo('filters by state')
    it.todo('filters by label')
    it.todo('filters by assignee')
    it.todo('filters by search query')
    it.todo('filters by remote')
    it.todo('supports limit and offset pagination')
    it.todo('aggregates issues across all configured remotes')
  })

  describe('cross-project listing', () => {
    it.todo('lists issues across all projects in an org when no projectId filter')
    it.todo('includes project as a filterable field')
  })

  describe('get', () => {
    it.todo('returns issue by id')
    it.todo('returns undefined for non-existent issue')
  })

  describe('create', () => {
    it.todo('creates issue on specified remote')
    it.todo('defaults to first remote when no remote specified')
    it.todo('proxies create to provider (provider is authoritative)')
  })

  describe('update', () => {
    it.todo('updates title')
    it.todo('updates body')
    it.todo('updates state')
    it.todo('updates labels')
    it.todo('updates assignees')
    it.todo('proxies update to provider')
  })

  describe('comments', () => {
    it.todo('lists comments for an issue')
    it.todo('adds a comment to an issue')
    it.todo('proxies comment operations to provider')
  })

  describe('sync', () => {
    it.todo('syncs issues from all remotes for a project')
    it.todo('returns synced count and error count')
    it.todo('updates local cache on sync')
  })

  describe('offline support', () => {
    it.todo('reads from cache when provider is unreachable')
    it.todo('includes staleness indicator for cached reads')
    it.todo('queues write operations when offline')
    it.todo('flushQueue replays queued writes when connectivity returns')
    it.todo('reports replayed and failed counts from flushQueue')
  })

  describe('bus events', () => {
    it.todo('emits issue.created on create')
    it.todo('emits issue.updated on update')
    it.todo('emits issue.comment.added on addComment')
    it.todo('emits issue.synced on sync')
  })

  describe('config change listener', () => {
    it.todo('listens for config.changed events to pick up provider changes')
    it.todo('reconfigures providers when remotes change')
  })
})
