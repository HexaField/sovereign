import { describe, it, expect } from 'vitest'
import type { ParsedTurn } from '@sovereign/core'
import { subagentResultOf } from './SubagentResultCard.js'

const turn = (t: Partial<ParsedTurn>): ParsedTurn => ({
  role: 'system',
  content: '',
  timestamp: 0,
  workItems: [],
  thinkingBlocks: [],
  ...t
})

describe('subagentResultOf', () => {
  it('reads a classified history turn', () => {
    const r = subagentResultOf(
      turn({
        content: 'Report.',
        kind: {
          variant: 'subagent-result',
          label: 'fix',
          payload: { status: 'failed', minutes: 4, error: 'boom', sessionKey: 'k' }
        }
      })
    )
    expect(r).toEqual({ status: 'failed', label: 'fix', minutes: 4, error: 'boom', body: 'Report.', sessionKey: 'k' })
  })

  it('parses the raw live system turn', () => {
    const r = subagentResultOf(turn({ content: '[Subagent done: fix] after 1 min\n\nReport.\n\nSession: k' }))
    expect(r).toEqual({ status: 'done', label: 'fix', minutes: 1, body: 'Report.', sessionKey: 'k' })
  })

  it('ignores assistant turns, other kinds and plain text', () => {
    const raw = '[Subagent done: fix] after 1 min'
    expect(subagentResultOf(turn({ role: 'assistant', content: raw }))).toBeNull()
    expect(subagentResultOf(turn({ content: raw, kind: { variant: 'cron-fired', label: 'c' } }))).toBeNull()
    expect(subagentResultOf(turn({ role: 'user', content: 'hello' }))).toBeNull()
  })
})
