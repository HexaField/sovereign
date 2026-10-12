import { describe, it, expect } from 'vitest'
import { formatSubagentResult, parseSubagentResult } from './subagent-result.js'

describe('subagent-result', () => {
  it('formats a success and parses it back', () => {
    const text = formatSubagentResult({
      label: 'fix',
      sessionKey: 'k1',
      durationMs: 150_000,
      result: '## Done\n\nAll good.'
    })
    expect(text).toBe('[Subagent done: fix] after 3 min\n\n## Done\n\nAll good.\n\nSession: k1')
    expect(parseSubagentResult(text)).toEqual({
      status: 'done',
      label: 'fix',
      minutes: 3,
      body: '## Done\n\nAll good.',
      sessionKey: 'k1'
    })
  })

  it('formats a failure with no report and parses it back', () => {
    const text = formatSubagentResult({
      label: 'slow',
      sessionKey: 'k2',
      durationMs: 1,
      error: 'timed out after 60 min'
    })
    expect(text).toBe('[Subagent failed: slow] after 1 min — timed out after 60 min\n\nSession: k2')
    expect(parseSubagentResult(text)).toEqual({
      status: 'failed',
      label: 'slow',
      minutes: 1,
      error: 'timed out after 60 min',
      body: '',
      sessionKey: 'k2'
    })
  })

  it('truncates a long report and points at the transcript', () => {
    const text = formatSubagentResult({ label: 'x', sessionKey: 'k', durationMs: 0, result: 'y'.repeat(12_001) })
    expect(text).toContain('… (truncated; full transcript in session k)')
    expect(parseSubagentResult(text)?.body.endsWith('(truncated; full transcript in session k)')).toBe(true)
  })

  it('keeps a "Session:" line inside the body', () => {
    const text = formatSubagentResult({ label: 'x', sessionKey: 'k', durationMs: 0, result: 'Session: notes\nmore' })
    expect(parseSubagentResult(text)?.body).toBe('Session: notes\nmore')
  })

  it('returns null for other text', () => {
    expect(parseSubagentResult('hello')).toBeNull()
    expect(parseSubagentResult('[Cron: x] hi')).toBeNull()
  })
})
