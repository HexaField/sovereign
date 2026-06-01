import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normalizeClaudeCodeEntry,
  parseClaudeCodeTurns,
  readAllClaudeCodeMessages,
  computeUsageFromFile
} from './history.js'

describe('claude-code/history', () => {
  describe('normalizeClaudeCodeEntry', () => {
    it('returns null for unknown entries', () => {
      expect(normalizeClaudeCodeEntry({})).toBeNull()
      expect(normalizeClaudeCodeEntry({ type: 'summary' })).toBeNull()
    })

    it('normalizes user entries', () => {
      const out = normalizeClaudeCodeEntry({
        type: 'user',
        message: { role: 'user', content: 'hello' },
        timestamp: '2026-05-24T01:02:03.000Z'
      })
      expect(out).toMatchObject({ role: 'user', content: 'hello' })
      expect(out!.timestamp).toBeGreaterThan(0)
    })

    it('normalizes assistant entries', () => {
      const out = normalizeClaudeCodeEntry({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' }
      })
      expect(out).toMatchObject({ role: 'assistant', stopReason: 'end_turn' })
    })

    it('emits ⚙️ Compacted system turn for compact_boundary (snake_case legacy)', () => {
      const out = normalizeClaudeCodeEntry({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto', pre_tokens: 100000, post_tokens: 12000 }
      })
      expect(out?.role).toBe('system')
      expect(out?.content).toMatch(/⚙️ Compacted/)
      expect(out?.content).toMatch(/100,000/)
      expect(out?.content).toMatch(/auto/)
    })

    it('emits ⚙️ Compacted with correct trigger from camelCase compactMetadata (SDK shape)', () => {
      const out = normalizeClaudeCodeEntry({
        type: 'system',
        subtype: 'compact_boundary',
        compactMetadata: { trigger: 'manual', preTokens: 24092, postTokens: 2090, durationMs: 44583 }
      })
      expect(out?.role).toBe('system')
      expect(out?.content).toMatch(/24,092 → 2,090 tokens/)
      expect(out?.content).toMatch(/manual/)
    })

    it('drops the SDK rehydration / compact-summary user entry', () => {
      expect(
        normalizeClaudeCodeEntry({
          type: 'user',
          isCompactSummary: true,
          message: { role: 'user', content: 'This session is being continued…' }
        })
      ).toBeNull()
    })

    it('drops transcript-only-visible user entries', () => {
      expect(
        normalizeClaudeCodeEntry({
          type: 'user',
          isVisibleInTranscriptOnly: true,
          message: { role: 'user', content: 'internal marker' }
        })
      ).toBeNull()
    })

    it('drops slash-command synthetics (`<command-name>/compact</command-name>` etc.)', () => {
      for (const c of [
        '<local-command-caveat>Caveat: …</local-command-caveat>',
        '<command-name>/compact</command-name>\n<command-args></command-args>',
        '<local-command-stdout>some hook output</local-command-stdout>'
      ]) {
        expect(normalizeClaudeCodeEntry({ type: 'user', message: { role: 'user', content: c } })).toBeNull()
      }
    })

    it('does NOT drop a legitimate user message that happens to mention slash commands', () => {
      const out = normalizeClaudeCodeEntry({
        type: 'user',
        message: { role: 'user', content: 'How do I use the /compact command?' }
      })
      expect(out).toMatchObject({ role: 'user' })
    })
  })

  describe('parseClaudeCodeTurns', () => {
    it('classifies a [Cron: …] user turn as a cron-fired system card', () => {
      const turns = parseClaudeCodeTurns([
        { role: 'user', content: '[Cron: hello @ 2026-06-01T09:00:00Z] do the thing', timestamp: 1 }
      ])
      expect(turns).toHaveLength(1)
      const t = turns[0]
      expect(t.role).toBe('system')
      expect(t.content).toBe('do the thing')
      expect(t.kind?.variant).toBe('cron-fired')
      expect(t.kind?.label).toBe('Cron: hello')
      expect(t.kind?.firedAt).toBe(Date.UTC(2026, 5, 1, 9, 0, 0))
    })

    it('keeps assistant turns intact', () => {
      const turns = parseClaudeCodeTurns([
        { role: 'user', content: 'go', timestamp: 1 },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: 2 }
      ])
      expect(turns.map((t) => t.role)).toEqual(['user', 'assistant'])
      expect(turns[1].content).toBe('done')
    })
  })

  describe('readAllClaudeCodeMessages + computeUsageFromFile', () => {
    let dir: string
    let file: string

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'sov-cc-hist-'))
      file = join(dir, 'session.jsonl')
    })

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('reads valid lines and skips malformed ones', () => {
      writeFileSync(
        file,
        [
          JSON.stringify({ type: 'user', message: { role: 'user', content: 'a' } }),
          'not-json',
          JSON.stringify({
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] }
          })
        ].join('\n') + '\n'
      )
      const msgs = readAllClaudeCodeMessages(file)
      expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    })

    it('aggregates usage from result entries', () => {
      writeFileSync(
        file,
        [
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'x' }],
              usage: {
                input_tokens: 10,
                output_tokens: 5,
                cache_read_input_tokens: 100,
                cache_creation_input_tokens: 2
              }
            },
            total_cost_usd: 0.01
          }),
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'y' }],
              usage: { input_tokens: 3, output_tokens: 7 }
            }
          })
        ].join('\n') + '\n'
      )
      const usage = computeUsageFromFile(file)
      expect(usage.inputTokens).toBe(13)
      expect(usage.outputTokens).toBe(12)
      expect(usage.cacheRead).toBe(100)
      expect(usage.cacheWrite).toBe(2)
      expect(usage.costUsd).toBeCloseTo(0.01)
    })
  })
})
