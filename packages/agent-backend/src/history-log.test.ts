import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  historyLogPath,
  appendToHistoryLog,
  appendBatchToHistoryLog,
  readHistoryLog,
  historyLogExists,
  seedHistoryLog,
  mergeIntoHistoryLog
} from './history-log.js'

let dataDir: string

beforeEach(() => {
  dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'history-log-test-')))
})
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('historyLogPath', () => {
  it('returns correct path structure', () => {
    const result = historyLogPath(dataDir, 'my-session')
    expect(result).toBe(path.join(dataDir, 'agent-backend', 'history', 'my-session.jsonl'))
  })

  it('URL-encodes sessionKey with special characters', () => {
    const result = historyLogPath(dataDir, 'agent:main:thread:abc-123')
    expect(result).toBe(path.join(dataDir, 'agent-backend', 'history', 'agent%3Amain%3Athread%3Aabc-123.jsonl'))
  })
})

describe('appendToHistoryLog', () => {
  it('creates directories and file on first call', () => {
    const msg = { role: 'user', content: 'hello' }
    appendToHistoryLog(dataDir, 'sess-1', msg)

    const filePath = historyLogPath(dataDir, 'sess-1')
    expect(fs.existsSync(filePath)).toBe(true)
  })

  it('appends a single JSON line with newline terminator', () => {
    const msg = { role: 'user', content: 'hello' }
    appendToHistoryLog(dataDir, 'sess-2', msg)

    const raw = fs.readFileSync(historyLogPath(dataDir, 'sess-2'), 'utf-8')
    expect(raw).toBe(JSON.stringify(msg) + '\n')
  })

  it('multiple calls produce multiple lines', () => {
    appendToHistoryLog(dataDir, 'sess-3', { role: 'user', content: 'one' })
    appendToHistoryLog(dataDir, 'sess-3', { role: 'assistant', content: 'two' })
    appendToHistoryLog(dataDir, 'sess-3', { role: 'user', content: 'three' })

    const raw = fs.readFileSync(historyLogPath(dataDir, 'sess-3'), 'utf-8')
    const lines = raw.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(3)
  })

  it('handles JSON-serialisable objects correctly', () => {
    const msg = {
      role: 'assistant',
      content: 'reply',
      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'Read', arguments: '{}' } }],
      timestamp: 1718900000000
    }
    appendToHistoryLog(dataDir, 'sess-4', msg)

    const raw = fs.readFileSync(historyLogPath(dataDir, 'sess-4'), 'utf-8')
    const parsed = JSON.parse(raw.trim())
    expect(parsed).toEqual(msg)
  })
})

describe('appendBatchToHistoryLog', () => {
  it('empty array does nothing — no file created', () => {
    appendBatchToHistoryLog(dataDir, 'empty-batch', [])
    expect(fs.existsSync(historyLogPath(dataDir, 'empty-batch'))).toBe(false)
  })

  it('multiple messages produce correct number of lines', () => {
    const messages = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' }
    ]
    appendBatchToHistoryLog(dataDir, 'batch-1', messages)

    const raw = fs.readFileSync(historyLogPath(dataDir, 'batch-1'), 'utf-8')
    const lines = raw.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0])).toEqual(messages[0])
    expect(JSON.parse(lines[1])).toEqual(messages[1])
    expect(JSON.parse(lines[2])).toEqual(messages[2])
  })

  it('creates directory on first call', () => {
    appendBatchToHistoryLog(dataDir, 'batch-dir', [{ role: 'user', content: 'x' }])
    expect(fs.existsSync(historyLogPath(dataDir, 'batch-dir'))).toBe(true)
  })
})

describe('readHistoryLog', () => {
  it('returns empty array when file does not exist', () => {
    const result = readHistoryLog(dataDir, 'nonexistent')
    expect(result).toEqual([])
  })

  it('reads back messages appended by appendToHistoryLog', () => {
    appendToHistoryLog(dataDir, 'read-1', { role: 'user', content: 'hi' })
    appendToHistoryLog(dataDir, 'read-1', { role: 'assistant', content: 'hello' })

    const result = readHistoryLog(dataDir, 'read-1')
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ role: 'user', content: 'hi' })
    expect(result[1]).toEqual({ role: 'assistant', content: 'hello' })
  })

  it('skips malformed JSON lines (crash recovery)', () => {
    const filePath = historyLogPath(dataDir, 'malformed')
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(
      filePath,
      '{"role":"user","content":"good"}\n' + 'this is not json\n' + '{"role":"assistant","content":"also good"}\n'
    )

    const result = readHistoryLog(dataDir, 'malformed')
    expect(result).toHaveLength(2)
    expect(result[0].content).toBe('good')
    expect(result[1].content).toBe('also good')
  })

  it('skips blank lines', () => {
    const filePath = historyLogPath(dataDir, 'blanks')
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, '{"role":"user","content":"a"}\n' + '\n' + '  \n' + '{"role":"user","content":"b"}\n')

    const result = readHistoryLog(dataDir, 'blanks')
    expect(result).toHaveLength(2)
  })

  it('preserves message properties (role, content, timestamp, tool_calls)', () => {
    const msg = {
      role: 'assistant',
      content: null,
      timestamp: 1718900000000,
      tool_calls: [{ id: 'call_42', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }]
    }
    appendToHistoryLog(dataDir, 'props', msg)

    const result = readHistoryLog(dataDir, 'props')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(msg)
    expect(result[0].tool_calls[0].id).toBe('call_42')
    expect(result[0].timestamp).toBe(1718900000000)
    expect(result[0].content).toBeNull()
  })
})

describe('historyLogExists', () => {
  it('returns false when no log exists', () => {
    expect(historyLogExists(dataDir, 'ghost')).toBe(false)
  })

  it('returns true after writing', () => {
    appendToHistoryLog(dataDir, 'exists-check', { role: 'user', content: 'x' })
    expect(historyLogExists(dataDir, 'exists-check')).toBe(true)
  })
})

describe('seedHistoryLog', () => {
  it('seeds messages when log does not exist', () => {
    const messages = [
      { role: 'system', content: 'you help' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' }
    ]
    seedHistoryLog(dataDir, 'seed-1', messages)

    expect(historyLogExists(dataDir, 'seed-1')).toBe(true)
    const result = readHistoryLog(dataDir, 'seed-1')
    expect(result).toHaveLength(3)
    expect(result).toEqual(messages)
  })

  it('does NOT overwrite an existing log (idempotent)', () => {
    appendToHistoryLog(dataDir, 'seed-idem', { role: 'user', content: 'original' })

    seedHistoryLog(dataDir, 'seed-idem', [
      { role: 'user', content: 'should not appear' },
      { role: 'assistant', content: 'also should not appear' }
    ])

    const result = readHistoryLog(dataDir, 'seed-idem')
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('original')
  })

  it('seeded messages are readable via readHistoryLog', () => {
    const messages = [
      { role: 'user', content: 'q', timestamp: 1000 },
      { role: 'assistant', content: 'a', timestamp: 2000 }
    ]
    seedHistoryLog(dataDir, 'seed-read', messages)

    const result = readHistoryLog(dataDir, 'seed-read')
    expect(result).toEqual(messages)
  })
})

describe('mergeIntoHistoryLog', () => {
  it('creates log and writes all messages when log does not exist', () => {
    const messages = [
      { role: 'user', content: 'hello', timestamp: 1000 },
      { role: 'assistant', content: 'hi', timestamp: 2000 }
    ]
    mergeIntoHistoryLog(dataDir, 'merge-fresh', messages)

    const result = readHistoryLog(dataDir, 'merge-fresh')
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual(messages[0])
    expect(result[1]).toEqual(messages[1])
  })

  it('skips messages with timestamps already in the log', () => {
    appendToHistoryLog(dataDir, 'merge-dedup', { role: 'user', content: 'existing', timestamp: 1000 })

    mergeIntoHistoryLog(dataDir, 'merge-dedup', [
      { role: 'user', content: 'existing', timestamp: 1000 },
      { role: 'assistant', content: 'new reply', timestamp: 2000 }
    ])

    const result = readHistoryLog(dataDir, 'merge-dedup')
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ role: 'user', content: 'existing', timestamp: 1000 })
    expect(result[1]).toEqual({ role: 'assistant', content: 'new reply', timestamp: 2000 })
  })

  it('appends messages without timestamps (treated as always-new)', () => {
    appendToHistoryLog(dataDir, 'merge-no-ts', { role: 'user', content: 'first' })

    mergeIntoHistoryLog(dataDir, 'merge-no-ts', [
      { role: 'assistant', content: 'no timestamp here' },
      { role: 'user', content: 'also no timestamp' }
    ])

    const result = readHistoryLog(dataDir, 'merge-no-ts')
    expect(result).toHaveLength(3)
    expect(result[1].content).toBe('no timestamp here')
    expect(result[2].content).toBe('also no timestamp')
  })

  it('empty array produces no file', () => {
    mergeIntoHistoryLog(dataDir, 'merge-empty', [])
    expect(historyLogExists(dataDir, 'merge-empty')).toBe(false)
  })

  it('handles mixed existing and new timestamps', () => {
    appendBatchToHistoryLog(dataDir, 'merge-mixed', [
      { role: 'user', content: 'a', timestamp: 100 },
      { role: 'assistant', content: 'b', timestamp: 200 }
    ])

    mergeIntoHistoryLog(dataDir, 'merge-mixed', [
      { role: 'user', content: 'a', timestamp: 100 },
      { role: 'assistant', content: 'b', timestamp: 200 },
      { role: 'user', content: 'c', timestamp: 300 },
      { role: 'assistant', content: 'd', timestamp: 400 }
    ])

    const result = readHistoryLog(dataDir, 'merge-mixed')
    expect(result).toHaveLength(4)
    expect(result[0]).toEqual({ role: 'user', content: 'a', timestamp: 100 })
    expect(result[1]).toEqual({ role: 'assistant', content: 'b', timestamp: 200 })
    expect(result[2]).toEqual({ role: 'user', content: 'c', timestamp: 300 })
    expect(result[3]).toEqual({ role: 'assistant', content: 'd', timestamp: 400 })
  })

  it('idempotent: calling twice with same data produces no duplicates', () => {
    const messages = [
      { role: 'user', content: 'one', timestamp: 1000 },
      { role: 'assistant', content: 'two', timestamp: 2000 },
      { role: 'user', content: 'three', timestamp: 3000 }
    ]
    mergeIntoHistoryLog(dataDir, 'merge-idem', messages)
    mergeIntoHistoryLog(dataDir, 'merge-idem', messages)

    const result = readHistoryLog(dataDir, 'merge-idem')
    expect(result).toHaveLength(3)
  })

  it('preserves message shape through merge', () => {
    const messages = [
      {
        role: 'assistant',
        content: null,
        timestamp: 5000,
        tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'Read', arguments: '{}' } }],
        metadata: { tokens: 100, model: 'test-model' }
      },
      {
        role: 'user',
        content: 'follow-up',
        timestamp: 6000,
        extra_field: [1, 2, 3]
      }
    ]
    mergeIntoHistoryLog(dataDir, 'merge-shape', messages)

    const result = readHistoryLog(dataDir, 'merge-shape')
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual(messages[0])
    expect(result[0].tool_calls[0].id).toBe('tc_1')
    expect(result[0].metadata).toEqual({ tokens: 100, model: 'test-model' })
    expect(result[0].content).toBeNull()
    expect(result[1]).toEqual(messages[1])
    expect(result[1].extra_field).toEqual([1, 2, 3])
  })

  it('cross-backend simulation: local-llm seed then CC merge', () => {
    const seeded = [
      { role: 'system', content: 'system prompt', timestamp: 100 },
      { role: 'user', content: 'local user msg', timestamp: 200 },
      { role: 'assistant', content: 'local reply', timestamp: 300 }
    ]
    seedHistoryLog(dataDir, 'merge-cross', seeded)

    const ccMessages = [
      { role: 'user', content: 'local user msg', timestamp: 200 },
      { role: 'assistant', content: 'local reply', timestamp: 300 },
      { role: 'user', content: 'cc user msg', timestamp: 400 },
      { role: 'assistant', content: 'cc reply', timestamp: 500 }
    ]
    mergeIntoHistoryLog(dataDir, 'merge-cross', ccMessages)

    const result = readHistoryLog(dataDir, 'merge-cross')
    expect(result).toHaveLength(5)
    expect(result[0]).toEqual(seeded[0])
    expect(result[1]).toEqual(seeded[1])
    expect(result[2]).toEqual(seeded[2])
    expect(result[3]).toEqual({ role: 'user', content: 'cc user msg', timestamp: 400 })
    expect(result[4]).toEqual({ role: 'assistant', content: 'cc reply', timestamp: 500 })
  })
})

describe('integration', () => {
  it('append then read round-trip preserves exact message shape', () => {
    const msg = {
      role: 'assistant',
      content: 'complex reply',
      timestamp: Date.now(),
      tool_calls: [
        {
          id: 'tc_99',
          type: 'function',
          function: { name: 'Write', arguments: '{"file_path":"/tmp/x","content":"y"}' }
        }
      ],
      metadata: { tokens: 42 }
    }
    appendToHistoryLog(dataDir, 'roundtrip', msg)

    const result = readHistoryLog(dataDir, 'roundtrip')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(msg)
  })

  it('seed then append then read returns both seeded and appended messages', () => {
    const seeded = [
      { role: 'system', content: 'sys prompt' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'first reply' }
    ]
    seedHistoryLog(dataDir, 'combo', seeded)

    appendToHistoryLog(dataDir, 'combo', { role: 'user', content: 'second' })
    appendToHistoryLog(dataDir, 'combo', { role: 'assistant', content: 'second reply' })

    const result = readHistoryLog(dataDir, 'combo')
    expect(result).toHaveLength(5)
    expect(result[0]).toEqual(seeded[0])
    expect(result[1]).toEqual(seeded[1])
    expect(result[2]).toEqual(seeded[2])
    expect(result[3].content).toBe('second')
    expect(result[4].content).toBe('second reply')
  })

  it('system-role messages are stored faithfully (no filtering at the log level)', () => {
    const sysMsg = {
      role: 'system',
      content: '[CONTEXT COMPACTION] summary of prior conversation',
      timestamp: Date.now()
    }
    appendToHistoryLog(dataDir, 'sys-role', sysMsg)

    const result = readHistoryLog(dataDir, 'sys-role')
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe('system')
    expect(result[0].content).toContain('[CONTEXT COMPACTION]')
  })
})
