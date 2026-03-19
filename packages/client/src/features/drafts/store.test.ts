import { describe, it, expect, beforeEach, vi } from 'vitest'
// TODO: import { createDraftsStore } from './store.js'
// TODO: import type { Draft, UpdateDraft, DraftDep } from './types.js'

describe('Drafts Client Store', () => {
  describe('§3.4 Signals', () => {
    it.todo('3.4 MUST expose drafts() signal returning Draft[]')
    it.todo('3.4 MUST expose selectedDraftId() signal returning string | null')
  })

  describe('§3.4 fetchDrafts', () => {
    it.todo('3.4 fetchDrafts MUST be called when Planning tab becomes active')
    it.todo('3.4 fetchDrafts MUST be called when workspace changes')
    it.todo('3.4 fetchDrafts MUST accept optional orgId parameter')
  })

  describe('§3.4 createDraft', () => {
    it.todo('3.4 createDraft MUST create draft and return it')
    it.todo('3.4 store MUST refetch after create')
  })

  describe('§3.4 updateDraft', () => {
    it.todo('3.4 updateDraft MUST update draft by id with patch')
    it.todo('3.4 store MUST refetch after update')
  })

  describe('§3.4 deleteDraft', () => {
    it.todo('3.4 deleteDraft MUST delete draft by id')
    it.todo('3.4 store MUST refetch after delete')
  })

  describe('§3.4 publishDraft', () => {
    it.todo('3.4 publishDraft MUST publish draft with orgId and projectId')
    it.todo('3.4 store MUST refetch after publish')
  })

  describe('§3.4 selectDraft', () => {
    it.todo('3.4 selectDraft MUST set selectedDraftId signal')
  })

  describe('§3.4 addDependency', () => {
    it.todo('3.4 addDependency MUST add dependency to draft')
  })

  describe('§3.4 removeDependency', () => {
    it.todo('3.4 removeDependency MUST remove dependency by index')
  })
})
