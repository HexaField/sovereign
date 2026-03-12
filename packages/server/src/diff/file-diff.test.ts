import { describe, it } from 'vitest'

describe('diffFile', () => {
  describe('diff between commits', () => {
    it.todo('returns FileDiff for a modified file between two commits')
    it.todo('returns FileDiff for an added file')
    it.todo('returns FileDiff for a deleted file')
    it.todo('detects renamed/moved files')
    it.todo('reports binary files as binary with no line diff')
    it.todo('includes correct additions and deletions counts')
    it.todo('uses git module to retrieve file content at specific refs')
  })

  describe('working tree diff', () => {
    it.todo('returns unstaged changes (HEAD vs working tree)')
    it.todo('returns staged changes when opts.staged is true')
    it.todo('returns multiple FileDiffs for multiple changed files')
    it.todo('detects new untracked files as added')
    it.todo('detects deleted files')
  })

  describe('rename/move detection', () => {
    it.todo('detects file rename and sets oldPath')
    it.todo('sets status to "renamed" for moved files')
    it.todo('matches content across different paths')
  })

  describe('binary detection', () => {
    it.todo('sets binary to true for binary files')
    it.todo('returns empty hunks for binary files')
  })
})
