import { describe, it } from 'vitest'

describe('GitHubIssueProvider', () => {
  describe('list', () => {
    it.todo('lists issues via gh issue list')
    it.todo('passes state filter to gh CLI')
    it.todo('passes label filter to gh CLI')
    it.todo('passes assignee filter to gh CLI')
    it.todo('parses gh CLI JSON output into Issue objects')
    it.todo('maps all unified issue model fields')
  })

  describe('get', () => {
    it.todo('gets issue by id via gh issue view')
    it.todo('returns undefined for non-existent issue')
  })

  describe('create', () => {
    it.todo('creates issue via gh issue create')
    it.todo('passes title, body, labels, assignees to gh CLI')
    it.todo('returns created Issue object')
  })

  describe('update', () => {
    it.todo('updates issue via gh issue edit')
    it.todo('updates title')
    it.todo('updates body')
    it.todo('updates state (close/reopen)')
    it.todo('updates labels')
    it.todo('updates assignees')
  })

  describe('comments', () => {
    it.todo('lists comments via gh CLI')
    it.todo('adds comment via gh issue comment')
    it.todo('returns IssueComment object')
  })
})
