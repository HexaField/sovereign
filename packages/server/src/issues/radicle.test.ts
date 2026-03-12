import { describe, it } from 'vitest'

describe('RadicleIssueProvider', () => {
  describe('list', () => {
    it.todo('lists issues via rad issue list')
    it.todo('parses rad CLI output into Issue objects')
    it.todo('maps all unified issue model fields')
    it.todo('filters by state')
  })

  describe('get', () => {
    it.todo('gets issue by id via rad issue show')
    it.todo('returns undefined for non-existent issue')
  })

  describe('create', () => {
    it.todo('creates issue via rad issue open')
    it.todo('passes title and body to rad CLI')
    it.todo('returns created Issue object')
  })

  describe('update', () => {
    it.todo('updates labels via rad issue label')
    it.todo('updates assignees via rad issue assign')
    it.todo('updates issue state')
  })

  describe('comments', () => {
    it.todo('lists comments for an issue')
    it.todo('adds comment via rad issue comment')
    it.todo('returns IssueComment object')
  })
})
