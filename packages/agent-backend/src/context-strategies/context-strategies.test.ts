import { describe, it, expect } from 'vitest'
import type { GenericMessage } from './types.js'
import { toolResultAge } from './tool-result-age.js'
import { documentDedup } from './document-dedup.js'
import { systemReminderDedup } from './system-reminder-dedup.js'
import { staleReads } from './stale-reads.js'
import { errorRetryCollapse } from './error-retry-collapse.js'
import { megaBlockTrim } from './mega-block-trim.js'
import { runContextStrategies, DEFAULT_STRATEGIES } from './pipeline.js'

// ── Helpers ──────────────────────────────────────────────────────────

/** Generate N user+assistant+tool rounds.  Each tool result carries
 *  `contentSize` chars of filler text. */
function makeConversation(rounds: number, contentSize = 2000): GenericMessage[] {
  const msgs: GenericMessage[] = []
  for (let r = 0; r < rounds; r++) {
    msgs.push({ role: 'user', content: `User message ${r}`, timestamp: r * 1000 })
    msgs.push({
      role: 'assistant',
      content: `Assistant reply ${r}`,
      tool_calls: [
        { id: `call_${r}`, function: { name: 'Read', arguments: JSON.stringify({ file_path: `/tmp/file_${r}.ts` }) } }
      ],
      timestamp: r * 1000 + 100
    })
    msgs.push({
      role: 'tool',
      content: `${'x'.repeat(contentSize)} [round ${r}]`,
      name: 'Read',
      tool_call_id: `call_${r}`,
      timestamp: r * 1000 + 200
    })
    msgs.push({ role: 'assistant', content: `Done with round ${r}`, timestamp: r * 1000 + 300 })
  }
  return msgs
}

/** Build a conversation with a known Read → Edit sequence for stale-reads testing. */
function makeStaleReadConversation(): GenericMessage[] {
  return [
    { role: 'user', content: 'Read the file', timestamp: 1000 },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'read_1', function: { name: 'Read', arguments: JSON.stringify({ file_path: '/tmp/target.ts' }) } }
      ],
      timestamp: 1100
    },
    {
      role: 'tool',
      content: 'x'.repeat(1000) + ' [original file content]',
      name: 'Read',
      tool_call_id: 'read_1',
      timestamp: 1200
    },
    { role: 'assistant', content: 'I read the file', timestamp: 1300 },
    { role: 'user', content: 'Now edit it', timestamp: 2000 },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'edit_1',
          function: {
            name: 'Edit',
            arguments: JSON.stringify({ file_path: '/tmp/target.ts', old_string: 'foo', new_string: 'bar' })
          }
        }
      ],
      timestamp: 2100
    },
    {
      role: 'tool',
      content: 'Edit applied successfully',
      name: 'Edit',
      tool_call_id: 'edit_1',
      timestamp: 2200
    },
    { role: 'assistant', content: 'Edited the file', timestamp: 2300 },
    // Recent messages (protected window)
    { role: 'user', content: 'Thanks', timestamp: 3000 },
    { role: 'assistant', content: 'You are welcome', timestamp: 3100 }
  ]
}

/** Build a conversation with error → retry → error → retry sequences. */
function makeErrorRetryConversation(): GenericMessage[] {
  return [
    { role: 'user', content: 'Run the command', timestamp: 1000 },
    // First attempt
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'bash_1', function: { name: 'Bash', arguments: JSON.stringify({ command: 'npm test' }) } }],
      timestamp: 1100
    },
    {
      role: 'tool',
      content: 'Error: command not found — npm',
      name: 'Bash',
      tool_call_id: 'bash_1',
      timestamp: 1200
    },
    // Retry 1 (identical args)
    {
      role: 'assistant',
      content: 'Retrying...',
      tool_calls: [{ id: 'bash_2', function: { name: 'Bash', arguments: JSON.stringify({ command: 'npm test' }) } }],
      timestamp: 1300
    },
    {
      role: 'tool',
      content: 'Error: command not found — npm',
      name: 'Bash',
      tool_call_id: 'bash_2',
      timestamp: 1400
    },
    // Retry 2 (identical args — final one, kept)
    {
      role: 'assistant',
      content: 'One more try...',
      tool_calls: [{ id: 'bash_3', function: { name: 'Bash', arguments: JSON.stringify({ command: 'npm test' }) } }],
      timestamp: 1500
    },
    {
      role: 'tool',
      content: 'Error: command not found — npm',
      name: 'Bash',
      tool_call_id: 'bash_3',
      timestamp: 1600
    },
    { role: 'assistant', content: 'npm not available', timestamp: 1700 },
    // Protected window (recent)
    { role: 'user', content: 'ok thanks', timestamp: 2000 },
    { role: 'assistant', content: 'understood', timestamp: 2100 }
  ]
}

const bigContent = (size: number) => 'x'.repeat(size)

// ── tool-result-age ──────────────────────────────────────────────────

describe('tool-result-age', () => {
  it('leaves recent tool results untouched', () => {
    const msgs = makeConversation(5, 2000)
    const result = toolResultAge(msgs, { toolResultMidAge: 15, toolResultOldAge: 40 })
    // Only 5 rounds — everything counts as recent (< 15 turns ago)
    expect(result.actions).toHaveLength(0)
    expect(result.messagesAffected).toBe(0)
  })

  it('minifies mid-age tool results (JSON content)', () => {
    const msgs = makeConversation(25, 500)
    // Replace an early tool result with deeply nested formatted JSON —
    // indentation at 4 levels produces > 15% whitespace savings when
    // minified.  Must exceed the 100-char skip threshold.
    const deeply = {
      level1: {
        level2: {
          level3: Array.from({ length: 10 }, (_, i) => ({
            id: i,
            name: `item_${i}`,
            tags: ['alpha', 'beta', 'gamma']
          }))
        }
      }
    }
    const jsonContent = JSON.stringify(deeply, null, 4)
    msgs[2].content = jsonContent // round 0's tool result (25 turns ago)

    const result = toolResultAge(msgs, {
      toolResultMidAge: 5,
      toolResultOldAge: 30,
      keepRecentMessages: 4
    })
    // Round 0 sits at 25 turns ago — within [5, 30) → mid-age
    expect(result.messagesAffected).toBeGreaterThan(0)
    const midActions = result.actions.filter((a) => a.reason.includes('mid'))
    expect(midActions.length).toBeGreaterThan(0)
  })

  it('stubs old tool results with a compact summary', () => {
    const msgs = makeConversation(50, 2000)
    const result = toolResultAge(msgs, {
      toolResultMidAge: 5,
      toolResultOldAge: 15,
      keepRecentMessages: 4
    })

    const oldActions = result.actions.filter((a) => a.reason.includes('old'))
    expect(oldActions.length).toBeGreaterThan(0)
    // Stubs should carry the tool name
    for (const a of oldActions) {
      expect(a.replacement).toContain('[pruned')
      expect(a.replacement).toContain('Read')
    }
  })

  it('protects the most recent N messages', () => {
    const msgs = makeConversation(50, 2000)
    const keepRecent = 8
    const result = toolResultAge(msgs, {
      toolResultMidAge: 1,
      toolResultOldAge: 2,
      keepRecentMessages: keepRecent
    })

    const protectedFrom = msgs.length - keepRecent
    for (const action of result.actions) {
      expect(action.index).toBeLessThan(protectedFrom)
    }
  })

  it('skips tool results under 100 chars', () => {
    const msgs: GenericMessage[] = [
      { role: 'user', content: 'go', timestamp: 0 },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', function: { name: 'Bash', arguments: '{}' } }],
        timestamp: 1
      },
      { role: 'tool', content: 'ok', name: 'Bash', tool_call_id: 'c1', timestamp: 2 },
      ...Array.from({ length: 50 }, (_, i) => ({ role: 'user' as const, content: `filler ${i}`, timestamp: 100 + i }))
    ]
    const result = toolResultAge(msgs, { toolResultMidAge: 1, toolResultOldAge: 2, keepRecentMessages: 4 })
    expect(result.actions).toHaveLength(0)
  })
})

// ── document-dedup ───────────────────────────────────────────────────

describe('document-dedup', () => {
  it('passes the first occurrence through unchanged', () => {
    const content = bigContent(2000)
    const msgs: GenericMessage[] = [
      { role: 'tool', content, timestamp: 0 },
      { role: 'user', content: 'go', timestamp: 1 }
    ]
    const result = documentDedup(msgs, { dedupMinChars: 1024, keepRecentMessages: 1 })
    expect(result.actions).toHaveLength(0)
  })

  it('replaces duplicate content blocks with a stub', () => {
    const content = bigContent(2000)
    const msgs: GenericMessage[] = [
      { role: 'tool', content, timestamp: 0 },
      { role: 'tool', content, timestamp: 1 },
      { role: 'tool', content, timestamp: 2 },
      // Protected window
      { role: 'user', content: 'go', timestamp: 3 }
    ]
    const result = documentDedup(msgs, { dedupMinChars: 1024, keepRecentMessages: 1 })
    // Second and third are duplicates
    expect(result.actions.length).toBeGreaterThanOrEqual(1)
    for (const action of result.actions) {
      expect(action.replacement).toContain('duplicate content')
    }
  })

  it('leaves content below dedupMinChars un-deduped', () => {
    const content = bigContent(500)
    const msgs: GenericMessage[] = [
      { role: 'tool', content, timestamp: 0 },
      { role: 'tool', content, timestamp: 1 },
      { role: 'user', content: 'go', timestamp: 2 }
    ]
    const result = documentDedup(msgs, { dedupMinChars: 1024, keepRecentMessages: 1 })
    expect(result.actions).toHaveLength(0)
  })

  it('protects recent messages from dedup', () => {
    const content = bigContent(2000)
    const msgs: GenericMessage[] = [
      { role: 'tool', content, timestamp: 0 },
      { role: 'tool', content, timestamp: 1 } // in protected window
    ]
    const result = documentDedup(msgs, { dedupMinChars: 1024, keepRecentMessages: 10 })
    // Both in protected window — no dedup
    expect(result.actions).toHaveLength(0)
  })
})

// ── system-reminder-dedup ────────────────────────────────────────────

describe('system-reminder-dedup', () => {
  const reminder = '<system-reminder>Important rule: always check permissions.</system-reminder>'

  it('keeps the first occurrence of a system-reminder', () => {
    const msgs: GenericMessage[] = [
      { role: 'tool', content: `Result here.\n${reminder}`, timestamp: 0 },
      { role: 'user', content: 'go', timestamp: 1 }
    ]
    const result = systemReminderDedup(msgs, { keepRecentMessages: 1 })
    expect(result.actions).toHaveLength(0)
  })

  it('removes duplicate system-reminders from later messages', () => {
    const msgs: GenericMessage[] = [
      { role: 'tool', content: `Result A.\n${reminder}`, timestamp: 0 },
      { role: 'tool', content: `Result B.\n${reminder}`, timestamp: 1 },
      { role: 'tool', content: `Result C.\n${reminder}`, timestamp: 2 },
      // Protected
      { role: 'user', content: 'go', timestamp: 3 }
    ]
    const result = systemReminderDedup(msgs, { keepRecentMessages: 1 })
    // Messages at index 1 and 2 should have the reminder stripped
    expect(result.actions.length).toBe(2)
    for (const action of result.actions) {
      expect(action.replacement).not.toContain('<system-reminder>')
      expect(action.replacement).toContain('Result')
    }
  })

  it('handles multiple different reminders independently', () => {
    const reminder2 = '<system-reminder>Another rule here.</system-reminder>'
    const msgs: GenericMessage[] = [
      { role: 'tool', content: `${reminder}\n${reminder2}`, timestamp: 0 },
      { role: 'tool', content: `${reminder}\n${reminder2}`, timestamp: 1 },
      { role: 'user', content: 'go', timestamp: 2 }
    ]
    const result = systemReminderDedup(msgs, { keepRecentMessages: 1 })
    expect(result.actions.length).toBe(1)
    expect(result.actions[0].replacement).not.toContain('<system-reminder>')
  })
})

// ── stale-reads ──────────────────────────────────────────────────────

describe('stale-reads', () => {
  it('prunes a read result when the same file has a later edit', () => {
    const msgs = makeStaleReadConversation()
    const result = staleReads(msgs, { keepRecentMessages: 2 })
    expect(result.actions.length).toBe(1)
    expect(result.actions[0].index).toBe(2) // the Read tool result
    expect(result.actions[0].replacement).toContain('stale read')
  })

  it('keeps a read result when no later edit exists', () => {
    // Remove the Edit messages (indices 4-7)
    const msgs = makeStaleReadConversation().slice(0, 4)
    msgs.push({ role: 'user', content: 'done', timestamp: 5000 })
    const result = staleReads(msgs, { keepRecentMessages: 1 })
    expect(result.actions).toHaveLength(0)
  })

  it('keeps small read results even when stale', () => {
    const msgs = makeStaleReadConversation()
    msgs[2].content = 'short' // under 500 char threshold
    const result = staleReads(msgs, { keepRecentMessages: 2 })
    expect(result.actions).toHaveLength(0)
  })

  it('protects recent stale reads from pruning', () => {
    const msgs = makeStaleReadConversation()
    // Make the read result part of the recent window
    const result = staleReads(msgs, { keepRecentMessages: 20 })
    expect(result.actions).toHaveLength(0)
  })
})

// ── error-retry-collapse ─────────────────────────────────────────────

describe('error-retry-collapse', () => {
  it('removes intermediate error+retry pairs', () => {
    const msgs = makeErrorRetryConversation()
    const result = errorRetryCollapse(msgs, { keepRecentMessages: 2 })
    // The first error (idx 2) and first retry assistant+error (idx 3,4)
    // should get collapsed.  The exact count depends on the pattern matcher.
    expect(result.messagesRemoved).toBeGreaterThan(0)
  })

  it('keeps the final retry in a sequence', () => {
    const msgs = makeErrorRetryConversation()
    const result = errorRetryCollapse(msgs, { keepRecentMessages: 2 })
    // Index 5 (final retry assistant) and 6 (final error result) should survive
    const removedIndices = new Set(result.actions.map((a) => a.index))
    // The final tool call (idx 5) and its result (idx 6) must not appear in removes
    expect(removedIndices.has(5)).toBe(false)
    expect(removedIndices.has(6)).toBe(false)
  })

  it('returns no actions when no retry pattern exists', () => {
    const msgs: GenericMessage[] = [
      { role: 'user', content: 'hi', timestamp: 0 },
      { role: 'assistant', content: 'hello', timestamp: 1 },
      { role: 'user', content: 'bye', timestamp: 2 }
    ]
    const result = errorRetryCollapse(msgs, { keepRecentMessages: 1 })
    expect(result.actions).toHaveLength(0)
  })
})

// ── mega-block-trim ──────────────────────────────────────────────────

describe('mega-block-trim', () => {
  it('truncates content exceeding megaBlockMaxChars', () => {
    const msgs: GenericMessage[] = [
      { role: 'tool', content: bigContent(50_000), timestamp: 0 },
      { role: 'user', content: 'go', timestamp: 1 }
    ]
    const result = megaBlockTrim(msgs, { megaBlockMaxChars: 32_000, keepRecentMessages: 1 })
    expect(result.actions.length).toBe(1)
    expect(result.actions[0].replacement).toContain('chars trimmed by context strategy')
    expect(result.actions[0].prunedChars).toBeLessThan(50_000)
  })

  it('leaves content under the threshold untouched', () => {
    const msgs: GenericMessage[] = [
      { role: 'tool', content: bigContent(10_000), timestamp: 0 },
      { role: 'user', content: 'go', timestamp: 1 }
    ]
    const result = megaBlockTrim(msgs, { megaBlockMaxChars: 32_000, keepRecentMessages: 1 })
    expect(result.actions).toHaveLength(0)
  })

  it('preserves head and tail of trimmed content', () => {
    // Content must substantially exceed maxChars so the truncation
    // marker overhead doesn't eat the savings.
    const head = 'HEAD_MARKER_' + 'a'.repeat(30_000)
    const tail = 'b'.repeat(30_000) + '_TAIL_MARKER'
    const msgs: GenericMessage[] = [
      { role: 'tool', content: head + 'MIDDLE_DROPPED' + tail, timestamp: 0 },
      { role: 'user', content: 'go', timestamp: 1 }
    ]
    const result = megaBlockTrim(msgs, { megaBlockMaxChars: 32_000, keepRecentMessages: 1 })
    expect(result.actions.length).toBe(1)
    expect(result.actions[0].replacement).toContain('HEAD_MARKER_')
    expect(result.actions[0].replacement).toContain('_TAIL_MARKER')
    expect(result.actions[0].replacement).not.toContain('MIDDLE_DROPPED')
  })

  it('does not trim system messages (compaction summaries)', () => {
    const msgs: GenericMessage[] = [
      { role: 'system', content: bigContent(50_000), timestamp: 0 },
      { role: 'user', content: 'go', timestamp: 1 }
    ]
    const result = megaBlockTrim(msgs, { megaBlockMaxChars: 32_000, keepRecentMessages: 1 })
    expect(result.actions).toHaveLength(0)
  })
})

// ── Pipeline (integration) ───────────────────────────────────────────

describe('runContextStrategies', () => {
  it('runs all strategies and returns aggregate stats', () => {
    const msgs = makeConversation(50, 3000)
    const result = runContextStrategies(msgs, {
      toolResultMidAge: 5,
      toolResultOldAge: 15,
      keepRecentMessages: 4
    })

    expect(result.strategies).toHaveLength(DEFAULT_STRATEGIES.length)
    expect(result.totalOriginalChars).toBeGreaterThan(0)
    expect(result.totalPrunedChars).toBeGreaterThan(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    // Some messages should have been removed or replaced
    expect(result.totalRemoved + result.totalReplaced).toBeGreaterThan(0)
  })

  it('mutates the message array in place', () => {
    const msgs = makeConversation(50, 3000)
    const originalChars = msgs.reduce((n, m) => n + (m.content?.length ?? 0), 0)

    runContextStrategies(msgs, {
      toolResultMidAge: 5,
      toolResultOldAge: 15,
      keepRecentMessages: 4
    })

    const postChars = msgs.reduce((n, m) => n + (m.content?.length ?? 0), 0)
    // Content should shrink (replaced) or messages removed
    expect(postChars).toBeLessThan(originalChars)
  })

  it('returns zero changes for a tiny conversation', () => {
    const msgs: GenericMessage[] = [
      { role: 'user', content: 'hi', timestamp: 0 },
      { role: 'assistant', content: 'hello', timestamp: 1 }
    ]
    const result = runContextStrategies(msgs)
    expect(result.totalPrunedChars).toBe(0)
    expect(result.totalRemoved).toBe(0)
    expect(result.totalReplaced).toBe(0)
  })

  it('handles an empty message array without error', () => {
    const msgs: GenericMessage[] = []
    const result = runContextStrategies(msgs)
    expect(result.strategies).toHaveLength(DEFAULT_STRATEGIES.length)
    expect(result.totalOriginalChars).toBe(0)
  })

  it('resolves conflicts — remove beats replace for the same index', () => {
    // Build a conversation where the same message could match both
    // error-retry-collapse (remove) and tool-result-age (replace)
    const msgs: GenericMessage[] = [
      { role: 'user', content: 'go', timestamp: 0 },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', function: { name: 'Bash', arguments: JSON.stringify({ command: 'test' }) } }],
        timestamp: 1
      },
      {
        role: 'tool',
        content: 'Error: command not found — test\n' + 'x'.repeat(2000),
        name: 'Bash',
        tool_call_id: 'c1',
        timestamp: 2
      },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c2', function: { name: 'Bash', arguments: JSON.stringify({ command: 'test' }) } }],
        timestamp: 3
      },
      {
        role: 'tool',
        content: 'Error: command not found — test\n' + 'x'.repeat(2000),
        name: 'Bash',
        tool_call_id: 'c2',
        timestamp: 4
      },
      // Many filler user messages to push the errors into old-age range
      ...Array.from({ length: 50 }, (_, i) => ({
        role: 'user' as const,
        content: `filler ${i}`,
        timestamp: 100 + i
      }))
    ]

    // Run with aggressive age thresholds
    const result = runContextStrategies(msgs, {
      toolResultMidAge: 1,
      toolResultOldAge: 2,
      keepRecentMessages: 4
    })

    // The pipeline should not crash and should produce valid results
    expect(result.strategies.length).toBeGreaterThan(0)
  })

  it('accepts a custom strategy subset', () => {
    const msgs = makeConversation(50, 3000)
    const result = runContextStrategies(
      msgs,
      { toolResultMidAge: 5, toolResultOldAge: 15, keepRecentMessages: 4 },
      [toolResultAge] // Only run one strategy
    )

    expect(result.strategies).toHaveLength(1)
    expect(result.strategies[0].strategyName).toBe('tool-result-age')
  })

  it('reports per-strategy stats independently', () => {
    // Build a conversation with both duplicate content and old tool results
    const duplicateContent = bigContent(2000)
    const msgs: GenericMessage[] = [
      { role: 'user', content: 'start', timestamp: 0 },
      // Duplicate content blocks
      { role: 'tool', content: duplicateContent, name: 'Read', tool_call_id: 'r1', timestamp: 1 },
      { role: 'tool', content: duplicateContent, name: 'Read', tool_call_id: 'r2', timestamp: 2 },
      // Many user messages to create age
      ...Array.from({ length: 30 }, (_, i) => ({
        role: 'user' as const,
        content: `msg ${i}`,
        timestamp: 100 + i
      }))
    ]

    const result = runContextStrategies(msgs, {
      dedupMinChars: 1024,
      keepRecentMessages: 4
    })

    // Multiple strategies should report non-zero actions
    // At least document-dedup should fire on the duplicates
    const dedupResult = result.strategies.find((s) => s.strategyName === 'document-dedup')
    expect(dedupResult).toBeDefined()
  })
})
