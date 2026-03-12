import { describe, it } from 'vitest'

describe('GitHubReviewProvider', () => {
  describe('create', () => {
    it.todo('creates PR via gh pr create')
    it.todo('passes title, body, baseBranch, headBranch to gh CLI')
    it.todo('returns Review object')
  })

  describe('list', () => {
    it.todo('lists PRs via gh pr list')
    it.todo('filters by status')
    it.todo('parses gh CLI JSON output into Review objects')
  })

  describe('get', () => {
    it.todo('gets PR by id via gh pr view')
    it.todo('returns undefined for non-existent PR')
  })

  describe('approve', () => {
    it.todo('approves via gh pr review --approve')
    it.todo('includes optional body')
  })

  describe('requestChanges', () => {
    it.todo('requests changes via gh pr review --request-changes')
    it.todo('includes body')
  })

  describe('merge', () => {
    it.todo('merges via gh pr merge')
  })

  describe('comments', () => {
    it.todo('adds inline comment via gh pr comment')
    it.todo('lists comments for a PR')
    it.todo('resolves comment')
    it.todo('maps comment fields to ReviewComment')
  })
})
