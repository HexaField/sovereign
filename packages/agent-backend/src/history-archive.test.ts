import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { archiveJsonlBeforeRecycle, archiveRawToolOutput, archiveMessagesBeforeStrategies } from './history-archive.js'

describe('History Archive', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-archive-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('archiveJsonlBeforeRecycle', () => {
    it('copies the JSONL file to the archive directory', () => {
      const sessionId = 'test-session-1'
      const jsonlPath = path.join(tmpDir, 'session.jsonl')
      fs.writeFileSync(jsonlPath, '{"role":"user","content":"hello"}\n{"role":"assistant","content":"hi"}\n')

      const archivePath = archiveJsonlBeforeRecycle(tmpDir, sessionId, jsonlPath)

      expect(archivePath).not.toBeNull()
      expect(fs.existsSync(archivePath!)).toBe(true)

      // Archived content matches the original
      const original = fs.readFileSync(jsonlPath, 'utf-8')
      const archived = fs.readFileSync(archivePath!, 'utf-8')
      expect(archived).toBe(original)
    })

    it('creates timestamped snapshots for multiple recycles', async () => {
      const sessionId = 'test-session-2'
      const jsonlPath = path.join(tmpDir, 'session.jsonl')
      fs.writeFileSync(jsonlPath, '{"role":"user","content":"first"}\n')

      const first = archiveJsonlBeforeRecycle(tmpDir, sessionId, jsonlPath)

      // Wait 2ms so the next Date.now() differs
      await new Promise((r) => setTimeout(r, 2))

      // Simulate content change after prune
      fs.writeFileSync(jsonlPath, '{"role":"user","content":"[pruned]"}\n')
      const second = archiveJsonlBeforeRecycle(tmpDir, sessionId, jsonlPath)

      expect(first).not.toBe(second)

      // First archive has the original content
      expect(fs.readFileSync(first!, 'utf-8')).toContain('first')
      // Second archive has the pruned content
      expect(fs.readFileSync(second!, 'utf-8')).toContain('[pruned]')
    })

    it('returns null when the source file does not exist', () => {
      const result = archiveJsonlBeforeRecycle(tmpDir, 'missing', '/nonexistent/path.jsonl')
      expect(result).toBeNull()
    })
  })

  describe('archiveRawToolOutput', () => {
    it('appends entries to the raw-tool-output JSONL', () => {
      const sessionId = 'test-session-3'

      archiveRawToolOutput(tmpDir, sessionId, {
        ts: 1000,
        toolName: 'Bash',
        toolUseId: 'toolu_001',
        rawChars: 50000,
        trimmedChars: 40000,
        raw: { stdout: 'very long output...', stderr: '' }
      })

      archiveRawToolOutput(tmpDir, sessionId, {
        ts: 2000,
        toolName: 'Read',
        toolUseId: 'toolu_002',
        rawChars: 20000,
        trimmedChars: 12000,
        raw: 'large file content...'
      })

      const archiveFile = path.join(tmpDir, 'agent-backend', 'history-archive', sessionId, 'raw-tool-output.jsonl')
      expect(fs.existsSync(archiveFile)).toBe(true)

      const lines = fs.readFileSync(archiveFile, 'utf-8').trim().split('\n')
      expect(lines).toHaveLength(2)

      const entry1 = JSON.parse(lines[0])
      expect(entry1.toolName).toBe('Bash')
      expect(entry1.rawChars).toBe(50000)

      const entry2 = JSON.parse(lines[1])
      expect(entry2.toolName).toBe('Read')
    })
  })

  describe('archiveMessagesBeforeStrategies', () => {
    it('writes the full message array to a timestamped file', () => {
      const sessionKey = 'test-session-4'
      const messages = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
        { role: 'tool', content: 'some large tool output that will get pruned' }
      ]

      const archivePath = archiveMessagesBeforeStrategies(tmpDir, sessionKey, messages)

      expect(archivePath).not.toBeNull()
      expect(fs.existsSync(archivePath!)).toBe(true)

      const archived = JSON.parse(fs.readFileSync(archivePath!, 'utf-8'))
      expect(archived).toHaveLength(3)
      expect(archived[2].content).toBe('some large tool output that will get pruned')
    })

    it('preserves messages even after the source array gets mutated', () => {
      const sessionKey = 'test-session-5'
      const messages = [
        { role: 'user', content: 'hello' },
        { role: 'tool', content: 'original content' }
      ]

      const archivePath = archiveMessagesBeforeStrategies(tmpDir, sessionKey, messages)

      // Simulate strategy mutation
      messages[1].content = '[pruned]'
      messages.splice(0, 1) // remove first message

      // Archive still has the original
      const archived = JSON.parse(fs.readFileSync(archivePath!, 'utf-8'))
      expect(archived).toHaveLength(2)
      expect(archived[0].content).toBe('hello')
      expect(archived[1].content).toBe('original content')
    })
  })
})
