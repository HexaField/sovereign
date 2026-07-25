import { describe, it, expect } from 'vitest'
import type { ParsedTurn } from './agent-backend.js'
import { foldSystemEventsIntoWork, absorbFoldableTurn, foldableToWorkItem } from './fold-system-events.js'

function assistant(content: string, ts: number): ParsedTurn {
  return { role: 'assistant', content, timestamp: ts, workItems: [], thinkingBlocks: [] }
}
function user(content: string, ts: number): ParsedTurn {
  return { role: 'user', content, timestamp: ts, workItems: [], thinkingBlocks: [] }
}
function compaction(label: string, ts: number): ParsedTurn {
  return {
    role: 'system',
    content: label,
    timestamp: ts,
    workItems: [],
    thinkingBlocks: [],
    kind: { variant: 'compaction', label }
  }
}
function hook(hookEvent: string, body: string, ts: number): ParsedTurn {
  return {
    role: 'system',
    content: body,
    timestamp: ts,
    workItems: [],
    thinkingBlocks: [],
    kind: {
      variant: 'hook-output',
      label: `Hook: ${hookEvent}`,
      payload: { hookEvent, hookName: '', stdout: body }
    }
  }
}

describe('foldSystemEventsIntoWork', () => {
  it('attaches a compaction turn to the preceding assistant turn as a system_event', () => {
    const label = '⚙️ Compacted (366,035 → 7,644 tokens, manual)'
    const out = foldSystemEventsIntoWork([user('hi', 1), assistant('sure', 2), compaction(label, 3)])
    expect(out).toHaveLength(2)
    expect(out[1].role).toBe('assistant')
    expect(out[1].workItems).toHaveLength(1)
    expect(out[1].workItems[0]).toMatchObject({
      type: 'system_event',
      icon: 'compaction',
      name: label,
      output: label
    })
  })

  it('attaches a hook-output turn as a system_event with icon "hook"', () => {
    const out = foldSystemEventsIntoWork([assistant('done', 10), hook('SessionStart', 'Cozempic: guard active', 11)])
    expect(out).toHaveLength(1)
    expect(out[0].workItems).toHaveLength(1)
    expect(out[0].workItems[0]).toMatchObject({
      type: 'system_event',
      icon: 'hook',
      name: 'Hook: SessionStart',
      output: 'Cozempic: guard active'
    })
  })

  it('buffers pre-round framing and flushes it onto the next assistant turn', () => {
    const out = foldSystemEventsIntoWork([
      hook('SessionStart', 'Cozempic: guard active', 1),
      user('start work', 2),
      assistant('working…', 3)
    ])
    expect(out).toHaveLength(2)
    const asst = out[1]
    expect(asst.role).toBe('assistant')
    expect(asst.workItems[0]?.icon).toBe('hook')
  })

  it('leaves the standalone system turn in place when no assistant turn exists to anchor on', () => {
    const out = foldSystemEventsIntoWork([user('hi', 1), hook('SessionStart', 'nothing', 2)])
    expect(out).toHaveLength(2)
    expect(out[1].role).toBe('system')
    expect(out[1].kind?.variant).toBe('hook-output')
  })

  it('does not touch turns that are not compaction or hook-output', () => {
    const cron: ParsedTurn = {
      role: 'system',
      content: 'x',
      timestamp: 5,
      workItems: [],
      thinkingBlocks: [],
      kind: { variant: 'cron-fired', label: 'Cron: nightly' }
    }
    const out = foldSystemEventsIntoWork([assistant('ok', 1), cron])
    expect(out).toHaveLength(2)
    expect(out[1].role).toBe('system')
  })

  it('appends multiple framing turns in order onto the same assistant turn', () => {
    const out = foldSystemEventsIntoWork([
      assistant('reply', 1),
      hook('PostToolUse', 'log', 2),
      compaction('⚙️ Compacted (a → b, auto)', 3)
    ])
    expect(out).toHaveLength(1)
    expect(out[0].workItems.map((w) => w.icon)).toEqual(['hook', 'compaction'])
  })
})

describe('absorbFoldableTurn', () => {
  it('returns absorbed=true and appends to the last assistant turn', () => {
    const current = [user('hi', 1), assistant('sure', 2)]
    const label = '⚙️ Compacted (100 → 20 tokens, manual)'
    const result = absorbFoldableTurn(compaction(label, 3), current)
    expect(result.absorbed).toBe(true)
    if (result.absorbed) {
      expect(result.turns).toHaveLength(2)
      expect(result.turns[1].workItems).toHaveLength(1)
      expect(result.turns[1].workItems[0].name).toBe(label)
    }
  })

  it('returns absorbed=false for non-foldable turns', () => {
    const result = absorbFoldableTurn(user('hi', 1), [])
    expect(result.absorbed).toBe(false)
  })

  it('returns absorbed=false when no assistant turn exists to anchor', () => {
    const result = absorbFoldableTurn(compaction('x', 1), [user('hi', 0)])
    expect(result.absorbed).toBe(false)
  })
})

describe('foldableToWorkItem', () => {
  it('preserves the pre-formatted label as name and content as output', () => {
    const label = '⚙️ Compacted (366,035 → 7,644 tokens, manual)'
    const wi = foldableToWorkItem(compaction(label, 5))
    expect(wi.type).toBe('system_event')
    expect(wi.icon).toBe('compaction')
    expect(wi.name).toBe(label)
    expect(wi.output).toBe(label)
    expect(wi.timestamp).toBe(5)
  })
})
