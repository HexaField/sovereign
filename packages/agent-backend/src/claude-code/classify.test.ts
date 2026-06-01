import { describe, it, expect } from 'vitest'
import type { ParsedTurn } from '@sovereign/core'
import { classifyClaudeCodeTurn } from './classify.js'

function userTurn(content: string): ParsedTurn {
  return { role: 'user', content, timestamp: 0, workItems: [], thinkingBlocks: [] }
}

function systemTurn(content: string): ParsedTurn {
  return { role: 'system', content, timestamp: 0, workItems: [], thinkingBlocks: [] }
}

function assistantTurn(content: string): ParsedTurn {
  return { role: 'assistant', content, timestamp: 0, workItems: [], thinkingBlocks: [] }
}

describe('classifyClaudeCodeTurn', () => {
  describe('cron envelope', () => {
    it('flips a [Cron: label @ time] user turn to system + cron-fired kind', () => {
      const out = classifyClaudeCodeTurn(userTurn('[Cron: pr-followup @ 2026-06-15T09:00:00Z] Check PR status.'))
      expect(out.role).toBe('system')
      expect(out.content).toBe('Check PR status.')
      expect(out.kind?.variant).toBe('cron-fired')
      expect(out.kind?.label).toBe('Cron: pr-followup')
      expect(out.kind?.firedAt).toBe(Date.UTC(2026, 5, 15, 9, 0, 0))
    })

    it('handles a [Cron: label] envelope with no time', () => {
      const out = classifyClaudeCodeTurn(userTurn('[Cron: heartbeat] tick'))
      expect(out.role).toBe('system')
      expect(out.content).toBe('tick')
      expect(out.kind?.variant).toBe('cron-fired')
      expect(out.kind?.label).toBe('Cron: heartbeat')
      expect(out.kind?.firedAt).toBeUndefined()
    })

    it('leaves a non-cron user turn untouched', () => {
      const out = classifyClaudeCodeTurn(userTurn('hello world'))
      expect(out.role).toBe('user')
      expect(out.content).toBe('hello world')
      expect(out.kind).toBeUndefined()
    })

    it('preserves a nested task-notification inside a cron envelope', () => {
      const out = classifyClaudeCodeTurn(
        userTurn(
          '[Cron: nightly @ 2026-06-01T00:00:00Z] <task-notification>task: cleanup\nstatus: ok</task-notification>'
        )
      )
      expect(out.role).toBe('system')
      expect(out.kind?.variant).toBe('task-notification')
      expect(out.kind?.label).toBe('Task: cleanup — ok')
      expect(out.kind?.firedAt).toBe(Date.UTC(2026, 5, 1, 0, 0, 0))
    })
  })

  describe('<task-notification>', () => {
    it('extracts task + status fields', () => {
      const out = classifyClaudeCodeTurn(
        userTurn(
          '<task-notification>task: backfill-users\nstatus: complete\nat: 2026-06-01T10:00:00Z</task-notification>'
        )
      )
      expect(out.role).toBe('system')
      expect(out.kind?.variant).toBe('task-notification')
      expect(out.kind?.label).toBe('Task: backfill-users — complete')
      expect(out.kind?.firedAt).toBe(Date.UTC(2026, 5, 1, 10, 0, 0))
      expect(out.kind?.payload).toMatchObject({ task: 'backfill-users', status: 'complete' })
    })

    it('falls back when the body is free text', () => {
      const out = classifyClaudeCodeTurn(userTurn('<task-notification>something happened</task-notification>'))
      expect(out.role).toBe('system')
      expect(out.kind?.variant).toBe('task-notification')
      expect(out.kind?.label).toBe('Task notification')
      expect(out.content).toBe('something happened')
    })
  })

  describe('<invoke>', () => {
    it('extracts tool name and parameters', () => {
      const out = classifyClaudeCodeTurn(
        userTurn(
          '<invoke name="Read">\n<parameter name="file_path">/tmp/a.txt</parameter>\n<parameter name="limit">10</parameter>\n</invoke>'
        )
      )
      expect(out.role).toBe('system')
      expect(out.kind?.variant).toBe('sdk-invoke')
      expect(out.kind?.label).toBe('Invoke: Read')
      expect(out.kind?.payload).toMatchObject({
        tool: 'Read',
        params: { file_path: '/tmp/a.txt', limit: '10' }
      })
    })
  })

  describe('compaction marker', () => {
    it('tags an existing system "⚙️ Compacted" turn', () => {
      const out = classifyClaudeCodeTurn(systemTurn('⚙️ Compacted (24,092 → 2,090 tokens, manual)'))
      expect(out.role).toBe('system')
      expect(out.kind?.variant).toBe('compaction')
      expect(out.kind?.label).toBe('⚙️ Compacted (24,092 → 2,090 tokens, manual)')
    })
  })

  describe('agent error', () => {
    it('tags an "Error: …" system turn', () => {
      const out = classifyClaudeCodeTurn(systemTurn('Error: rate limited'))
      expect(out.role).toBe('system')
      expect(out.content).toBe('rate limited')
      expect(out.kind?.variant).toBe('agent-error')
      expect(out.kind?.label).toBe('Agent Error')
    })
  })

  describe('assistant turns', () => {
    it('never card-classifies an assistant turn even when its text contains an envelope', () => {
      const out = classifyClaudeCodeTurn(assistantTurn('<invoke name="Foo"></invoke>'))
      expect(out.role).toBe('assistant')
      expect(out.kind).toBeUndefined()
    })
  })
})
