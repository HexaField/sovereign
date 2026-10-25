import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normalizeClaudeCodeEntry,
  parseClaudeCodeTurns,
  readAllClaudeCodeMessages,
  computeUsageFromFile,
  latestUsageFromFile,
  usageSinceFromFile
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

    it('emits a 🪝 hook-output system turn for a hook_success attachment', () => {
      const out = normalizeClaudeCodeEntry({
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          hookName: 'SessionStart:startup',
          hookEvent: 'SessionStart',
          stdout: 'Cozempic: guard active\n',
          stderr: '',
          exitCode: 0
        }
      })
      expect(out?.role).toBe('system')
      expect(out?.content).toContain('🪝 SessionStart · startup')
      expect(out?.content).toContain('Cozempic: guard active')
    })

    it('returns null for a hook_success attachment with empty stdout/stderr', () => {
      const out = normalizeClaudeCodeEntry({
        type: 'attachment',
        attachment: { type: 'hook_success', hookEvent: 'PostToolUse', stdout: '', stderr: '' }
      })
      expect(out).toBeNull()
    })

    it('surfaces stderr when a hook_success has stderr but no stdout', () => {
      const out = normalizeClaudeCodeEntry({
        type: 'attachment',
        attachment: { type: 'hook_success', hookEvent: 'Stop', stdout: '', stderr: 'warn: x' }
      })
      expect(out?.content).toContain('[stderr] warn: x')
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

    it('latestUsageFromFile returns only the last turn (not cumulative)', () => {
      writeFileSync(
        file,
        [
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'x' }],
              usage: {
                input_tokens: 1000,
                output_tokens: 50,
                cache_read_input_tokens: 500,
                cache_creation_input_tokens: 200
              }
            },
            total_cost_usd: 0.01
          }),
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'y' }],
              usage: {
                input_tokens: 2000,
                output_tokens: 80,
                cache_read_input_tokens: 800,
                cache_creation_input_tokens: 100
              }
            },
            total_cost_usd: 0.05
          })
        ].join('\n') + '\n'
      )
      const latest = latestUsageFromFile(file)
      // Must equal the LAST entry, not the sum.
      expect(latest.inputTokens).toBe(2000)
      expect(latest.outputTokens).toBe(80)
      expect(latest.cacheRead).toBe(800)
      expect(latest.cacheWrite).toBe(100)
      expect(latest.costUsd).toBeCloseTo(0.05)

      // Compare against computeUsageFromFile (cumulative) to prove they differ.
      const cumulative = computeUsageFromFile(file)
      expect(cumulative.inputTokens).toBe(3000)
      expect(cumulative.inputTokens).toBeGreaterThan(latest.inputTokens)
    })

    it('latestUsageFromFile returns zeros for a missing file', () => {
      const latest = latestUsageFromFile('/nonexistent/session.jsonl')
      expect(latest.inputTokens).toBe(0)
      expect(latest.outputTokens).toBe(0)
      expect(latest.cacheRead).toBe(0)
      expect(latest.cacheWrite).toBe(0)
      expect(latest.costUsd).toBe(0)
    })

    it('latestUsageFromFile skips entries without usage (user messages)', () => {
      writeFileSync(
        file,
        [
          JSON.stringify({
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'a' }],
              usage: { input_tokens: 5000, output_tokens: 100 }
            }
          }),
          JSON.stringify({
            type: 'user',
            message: { role: 'user', content: 'follow-up' }
          })
        ].join('\n') + '\n'
      )
      const latest = latestUsageFromFile(file)
      // User entries have no usage — latest stays at the assistant entry.
      expect(latest.inputTokens).toBe(5000)
      expect(latest.outputTokens).toBe(100)
    })
  })
})

describe('usageSinceFromFile', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-usage-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('sums API calls since a time, once per message id', () => {
    const file = join(dir, 's.jsonl')
    const line = (ts: string, id: string, usage: Record<string, number>) =>
      JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, role: 'assistant', content: [], usage } })
    writeFileSync(
      file,
      [
        line('2026-10-16T08:00:00.000Z', 'm0', { input_tokens: 999, output_tokens: 9 }),
        JSON.stringify({
          type: 'user',
          timestamp: '2026-10-16T08:30:00.000Z',
          message: { role: 'user', content: 'go' }
        }),
        line('2026-10-16T08:30:01.000Z', 'm1', {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20
        }),
        // The same message's second content block repeats its usage.
        line('2026-10-16T08:30:01.000Z', 'm1', {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20
        }),
        line('2026-10-16T08:30:05.000Z', 'm2', { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 120 }),
        'not json'
      ].join('\n') + '\n'
    )
    expect(usageSinceFromFile(file, Date.parse('2026-10-16T08:30:00.000Z'))).toEqual({
      inputTokens: 13,
      outputTokens: 45,
      cacheRead: 220,
      cacheWrite: 20,
      calls: 2,
      // m0's context (1008) is larger than m1's (135): a drop adds nothing; m2 adds 163 − 135.
      added: 28
    })
    expect(usageSinceFromFile(join(dir, 'missing.jsonl'), 0).calls).toBe(0)
  })

  const call = (ts: string, id: string, usage: Record<string, number>) =>
    JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, role: 'assistant', content: [], usage } })

  it('counts what the calls add to the context, not a cold cache rewriting what was there', () => {
    const file = join(dir, 's.jsonl')
    writeFileSync(
      file,
      [
        // Before the run: a 235,802-token context, served from the cache.
        call('2026-10-26T09:00:00.000Z', 'm0', {
          input_tokens: 2,
          cache_creation_input_tokens: 500,
          cache_read_input_tokens: 235_000,
          output_tokens: 300
        }),
        // Hours later the cache is cold: the first call writes the whole prompt again.
        call('2026-10-26T21:30:07.000Z', 'm1', {
          input_tokens: 2,
          cache_creation_input_tokens: 236_000,
          cache_read_input_tokens: 0,
          output_tokens: 700
        }),
        call('2026-10-26T21:30:18.000Z', 'm2', {
          input_tokens: 2,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 236_002,
          output_tokens: 400
        })
      ].join('\n') + '\n'
    )
    const u = usageSinceFromFile(file, Date.parse('2026-10-26T21:30:00.000Z'))
    expect(u.cacheWrite).toBe(237_000)
    // m1: 236,702 − 235,802 = 900; m2: 237,404 − 236,702 = 702.
    expect(u.added).toBe(1602)
  })

  it('counts a first call in full when nothing came before it, and growth after a compaction', () => {
    const file = join(dir, 's.jsonl')
    writeFileSync(
      file,
      [
        call('2026-10-26T21:30:01.000Z', 'm1', { input_tokens: 1000, output_tokens: 100 }),
        // A compaction shrinks the context: nothing added.
        call('2026-10-26T21:31:00.000Z', 'm2', { input_tokens: 300, output_tokens: 50 }),
        call('2026-10-26T21:31:10.000Z', 'm3', { input_tokens: 500, output_tokens: 20 })
      ].join('\n') + '\n'
    )
    // m1: 1100 − 0; m2: below 1100; m3: 520 − 350.
    expect(usageSinceFromFile(file, 0).added).toBe(1270)
  })
})
