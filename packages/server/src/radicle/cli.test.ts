import { describe, it } from 'vitest'

describe('RadCli', () => {
  describe('isAvailable', () => {
    it.todo('returns true when rad CLI is installed')
    it.todo('returns false when rad CLI is not found')
  })

  describe('exec', () => {
    it.todo('executes rad command with arguments')
    it.todo('returns stdout output')
    it.todo('throws on non-zero exit code')
    it.todo('includes stderr in error')
  })

  describe('commands', () => {
    it.todo('wraps rad init')
    it.todo('wraps rad push')
    it.todo('wraps rad pull')
    it.todo('wraps rad clone')
    it.todo('wraps rad seed')
    it.todo('wraps rad unseed')
  })
})
