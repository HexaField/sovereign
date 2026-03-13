import { describe, it } from 'vitest'

describe('Dependency Parser', () => {
  describe('1.1 Dependency Parsing', () => {
    it.todo('MUST extract "depends on #42" references from issue bodies')
    it.todo('MUST extract "blocked by #42" references from issue bodies')
    it.todo('MUST extract "blocks #42" references from issue bodies')
    it.todo('MUST extract cross-repo references "depends on org/repo#42"')
    it.todo('MUST extract Radicle issue ID references "depends on <issue-id>"')
    it.todo('MUST recognise dependency patterns case-insensitively')
    it.todo('MUST support intra-project references (#42)')
    it.todo('MUST support cross-project references (org/repo#42 or rad:<rid>#<id>)')
    it.todo('MUST extract dependency direction: depends on / blocked by = this depends on referenced')
    it.todo('MUST extract dependency direction: blocks = referenced depends on this')
    it.todo('MUST return structured edges with EntityRef and type')
    it.todo('MUST return edge source field as "body" or "comment"')
    it.todo('SHOULD extract milestone references from issue metadata')
    it.todo('MAY extract effort/size from labels (e.g. size:small, effort:medium)')
  })
})
