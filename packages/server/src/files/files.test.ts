import { describe, it } from 'vitest'

describe('File Service', () => {
  it.todo('reads a file from a project repo')
  it.todo('reads a binary file as base64')
  it.todo('writes a file to a project repo')
  it.todo('detects language from file extension')
  it.todo('rejects path traversal attempts with error')
  it.todo('rejects paths outside project repo')
  it.todo('emits file.created on the bus when creating a new file')
  it.todo('emits file.deleted on the bus when deleting a file')
})

describe('File Tree', () => {
  it.todo('lists directory contents as FileTreeNode array')
  it.todo('returns type file or directory correctly')
  it.todo('includes file size')
  it.todo('does not recurse into children (lazy loading)')
  it.todo('excludes .git directory')
  it.todo('handles empty directories')
})

describe('File Tree (detailed)', () => {
  it.todo('sorts directories before files')
  it.todo('sorts entries alphabetically within groups')
})

describe('File Routes', () => {
  it.todo('GET /api/files?path=...&project=... returns file content')
  it.todo('PUT /api/files writes file content')
  it.todo('GET /api/files/tree?path=...&project=... returns directory listing')
  it.todo('rejects path traversal with 403')
  it.todo('rejects missing project parameter with 400')
  it.todo('all routes reject unauthenticated requests with 401')
})
