import { describe, it, expect } from 'vitest'
import { parseCozempicOutput, parseSizeToChars } from './cozempic-parser.js'

describe('parseSizeToChars', () => {
  it('parses MB values', () => {
    expect(parseSizeToChars('10.20MB')).toBe(Math.round(10.2 * 1024 * 1024))
    expect(parseSizeToChars('11.63MB')).toBe(Math.round(11.63 * 1024 * 1024))
  })

  it('parses KB values', () => {
    expect(parseSizeToChars('77.4KB')).toBe(Math.round(77.4 * 1024))
    expect(parseSizeToChars('5.4KB')).toBe(Math.round(5.4 * 1024))
  })

  it('parses bare B values', () => {
    expect(parseSizeToChars('512B')).toBe(512)
  })

  it('returns 0 for unrecognised formats', () => {
    expect(parseSizeToChars('unknown')).toBe(0)
    expect(parseSizeToChars('')).toBe(0)
  })
})

describe('parseCozempicOutput', () => {
  const SAMPLE_OUTPUT = `
  Cozempic — standard prescription

  Before      61.0K tokens   11.63MB  3,803 messages
  After       31.8K tokens    1.33MB  220 messages
  Saved       29.3K tokens (47.9%)  10.30MB freed
  Context  [=-------------------] 3% of 1.00M

  What changed:
    compact-summary-collapse      10.20MB  3583 msgs
    tool-use-result-strip          77.4KB    18 msgs
    metadata-strip                 19.4KB    33 msgs
    stale-reads                     5.4KB     2 msgs
    thinking-blocks                 4.8KB     3 msgs

  Note: exact usage data was stripped — post-treatment token count is estimated.
  Dry run — pass --execute to apply.
`

  it('extracts originalChars from the Before line', () => {
    const result = parseCozempicOutput(SAMPLE_OUTPUT)
    expect(result).not.toBeNull()
    expect(result!.originalChars).toBe(Math.round(11.63 * 1024 * 1024))
  })

  it('extracts prunedChars from the Saved line', () => {
    const result = parseCozempicOutput(SAMPLE_OUTPUT)
    expect(result!.prunedChars).toBe(Math.round(10.3 * 1024 * 1024))
  })

  it('parses all strategies from the What changed block', () => {
    const result = parseCozempicOutput(SAMPLE_OUTPUT)
    expect(result!.strategies).toHaveLength(5)

    expect(result!.strategies[0].name).toBe('compact-summary-collapse')
    expect(result!.strategies[0].charsSaved).toBe(Math.round(10.2 * 1024 * 1024))
    expect(result!.strategies[0].messagesAffected).toBe(3583)

    expect(result!.strategies[1].name).toBe('tool-use-result-strip')
    expect(result!.strategies[1].charsSaved).toBe(Math.round(77.4 * 1024))
    expect(result!.strategies[1].messagesAffected).toBe(18)

    expect(result!.strategies[4].name).toBe('thinking-blocks')
    expect(result!.strategies[4].messagesAffected).toBe(3)
  })

  it('sums totalRemoved from all strategies', () => {
    const result = parseCozempicOutput(SAMPLE_OUTPUT)
    expect(result!.messagesRemoved).toBe(3583 + 18 + 33 + 2 + 3)
  })

  it('sets durationMs to 0 (cozempic does not report it)', () => {
    const result = parseCozempicOutput(SAMPLE_OUTPUT)
    expect(result!.durationMs).toBe(0)
  })

  it('returns null for output without a Before line', () => {
    expect(parseCozempicOutput('No valid output here')).toBeNull()
  })

  it('handles single-strategy output', () => {
    const output = `
  Before      5.0K tokens    2.50MB  100 messages
  After       4.0K tokens    1.50MB  80 messages
  Saved       1.0K tokens (20.0%)  1.00MB freed

  What changed:
    tool-use-result-strip          1.00MB    20 msgs
`
    const result = parseCozempicOutput(output)
    expect(result!.strategies).toHaveLength(1)
    expect(result!.strategies[0].name).toBe('tool-use-result-strip')
    expect(result!.messagesRemoved).toBe(20)
  })

  it('handles output with no strategies (no What changed block)', () => {
    const output = `
  Before      5.0K tokens    2.50MB  100 messages
  After       5.0K tokens    2.50MB  100 messages
  Saved       0 tokens (0.0%)  0B freed
`
    const result = parseCozempicOutput(output)
    expect(result).not.toBeNull()
    expect(result!.strategies).toEqual([])
    expect(result!.messagesRemoved).toBe(0)
  })
})
