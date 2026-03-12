import { describe, it } from 'vitest'

describe('RadicleReviewProvider', () => {
  describe('create', () => {
    it.todo('creates patch via rad patch create')
    it.todo('passes title, body, baseBranch, headBranch')
    it.todo('returns Review object')
  })

  describe('list', () => {
    it.todo('lists patches via rad patch list')
    it.todo('filters by status')
    it.todo('parses rad CLI output into Review objects')
  })

  describe('get', () => {
    it.todo('gets patch by id via rad patch show')
    it.todo('returns undefined for non-existent patch')
  })

  describe('approve', () => {
    it.todo('approves via rad patch review --accept')
  })

  describe('requestChanges', () => {
    it.todo('requests changes via rad patch review with comment')
  })

  describe('merge', () => {
    it.todo('merges via rad patch merge')
  })

  describe('comments', () => {
    it.todo('adds comment via rad patch comment')
    it.todo('lists comments for a patch')
    it.todo('maps comment fields to ReviewComment')
  })
})
