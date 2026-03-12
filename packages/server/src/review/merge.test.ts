import { describe, it } from 'vitest'

describe('MergeHandler', () => {
  describe('merge', () => {
    it.todo('calls provider merge (gh pr merge / rad patch merge)')
    it.todo('cleans up local worktree via injected removeWorktree')
    it.todo('updates change set status to "merged" via injected updateChangeSet')
    it.todo('emits review.merged event on the bus')
  })

  describe('cleanup on merge', () => {
    it.todo('removes worktree if linked')
    it.todo('skips worktree removal if no worktreeId')
    it.todo('updates change set status even if worktree removal fails')
  })

  describe('error handling', () => {
    it.todo('propagates provider merge errors')
    it.todo('handles missing change set gracefully')
  })
})
