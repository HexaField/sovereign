import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMetricsAccumulator,
  type ToolCallMetric,
  type CompactionMetric,
  type ContextSnapshotMetric
} from './metrics.js'

function toolMetric(overrides: Partial<ToolCallMetric> = {}): ToolCallMetric {
  return {
    ts: Date.now(),
    sessionKey: 'session-1',
    backendKind: 'claude-code',
    model: 'claude-sonnet-4-20250514',
    toolName: 'Read',
    inputChars: 100,
    outputChars: 5000,
    outputTrimmedChars: 0,
    durationMs: 42,
    isSubagent: false,
    ...overrides
  }
}

function compactionMetric(overrides: Partial<CompactionMetric> = {}): CompactionMetric {
  return {
    ts: Date.now(),
    sessionKey: 'session-1',
    backendKind: 'claude-code',
    model: 'claude-sonnet-4-20250514',
    preTokens: 100000,
    postTokens: 40000,
    tokensReclaimed: 60000,
    method: 'recycle',
    isSubagent: false,
    ...overrides
  }
}

function snapshotMetric(overrides: Partial<ContextSnapshotMetric> = {}): ContextSnapshotMetric {
  return {
    ts: Date.now(),
    sessionKey: 'session-1',
    backendKind: 'claude-code',
    model: 'claude-sonnet-4-20250514',
    totalTokens: 80000,
    contextWindow: 200000,
    fillPercent: 40,
    ...overrides
  }
}

describe('MetricsAccumulator', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('starts with zero global totals', () => {
    const m = createMetricsAccumulator()
    const g = m.globalTotals()
    expect(g.toolCalls).toBe(0)
    expect(g.totalInputChars).toBe(0)
    expect(g.totalOutputChars).toBe(0)
    expect(g.totalTrimmedChars).toBe(0)
    expect(g.compactions).toBe(0)
    expect(g.totalTokensReclaimed).toBe(0)
    expect(g.startedAt).toBeGreaterThan(0)
  })

  it('starts with empty ring buffers', () => {
    const m = createMetricsAccumulator()
    expect(m.recentToolCalls()).toEqual([])
    expect(m.recentCompactions()).toEqual([])
    expect(m.recentSnapshots()).toEqual([])
    expect(m.sessionAggregates()).toEqual([])
  })

  it('records tool calls and updates global + session aggregates', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const m = createMetricsAccumulator()

    m.recordToolCall(toolMetric({ inputChars: 100, outputChars: 5000, outputTrimmedChars: 200 }))
    m.recordToolCall(toolMetric({ toolName: 'Bash', inputChars: 50, outputChars: 3000, outputTrimmedChars: 0 }))

    const g = m.globalTotals()
    expect(g.toolCalls).toBe(2)
    expect(g.totalInputChars).toBe(150)
    expect(g.totalOutputChars).toBe(8000)
    expect(g.totalTrimmedChars).toBe(200)

    const sessions = m.sessionAggregates()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].toolCalls).toBe(2)
    expect(sessions[0].byTool['Read']).toEqual({ calls: 1, inputChars: 100, outputChars: 5000, trimmedChars: 200 })
    expect(sessions[0].byTool['Bash']).toEqual({ calls: 1, inputChars: 50, outputChars: 3000, trimmedChars: 0 })

    expect(m.recentToolCalls()).toHaveLength(2)
  })

  it('tracks separate sessions independently', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const m = createMetricsAccumulator()

    m.recordToolCall(toolMetric({ sessionKey: 'session-A' }))
    m.recordToolCall(toolMetric({ sessionKey: 'session-B', isSubagent: true }))
    m.recordToolCall(toolMetric({ sessionKey: 'session-A' }))

    const sessions = m.sessionAggregates()
    expect(sessions).toHaveLength(2)

    const sA = sessions.find((s) => s.sessionKey === 'session-A')!
    const sB = sessions.find((s) => s.sessionKey === 'session-B')!
    expect(sA.toolCalls).toBe(2)
    expect(sA.isSubagent).toBe(false)
    expect(sB.toolCalls).toBe(1)
    expect(sB.isSubagent).toBe(true)

    expect(m.globalTotals().toolCalls).toBe(3)
  })

  it('records compactions and updates global totals', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const m = createMetricsAccumulator()

    m.recordCompaction(compactionMetric({ tokensReclaimed: 60000 }))
    m.recordCompaction(compactionMetric({ tokensReclaimed: 20000, method: 'auto-recycle' }))

    expect(m.globalTotals().compactions).toBe(2)
    expect(m.globalTotals().totalTokensReclaimed).toBe(80000)
    expect(m.recentCompactions()).toHaveLength(2)

    const sessions = m.sessionAggregates()
    expect(sessions[0].compactions).toBe(2)
    expect(sessions[0].totalTokensReclaimed).toBe(80000)
  })

  it('records context snapshots without log output', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const m = createMetricsAccumulator()

    m.recordContextSnapshot(snapshotMetric({ fillPercent: 42.5 }))

    expect(m.recentSnapshots()).toHaveLength(1)
    expect(m.recentSnapshots()[0].fillPercent).toBe(42.5)
    // Snapshots should NOT produce log output (too frequent)
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('emits structured log lines for tool calls', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const m = createMetricsAccumulator()

    m.recordToolCall(toolMetric({ toolName: 'Grep', durationMs: 15 }))

    expect(logSpy).toHaveBeenCalledOnce()
    const line = logSpy.mock.calls[0][0] as string
    expect(line).toContain('[metrics] tool ')
    expect(line).toContain('tool=Grep')
    expect(line).toContain('dur=15ms')
  })

  it('tags subagent tool calls in log lines', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const m = createMetricsAccumulator()

    m.recordToolCall(toolMetric({ isSubagent: true }))

    const line = logSpy.mock.calls[0][0] as string
    expect(line).toContain('[metrics] subagent-tool ')
  })

  it('emits structured log lines for compactions', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const m = createMetricsAccumulator()

    m.recordCompaction(
      compactionMetric({ method: 'auto-recycle', preTokens: 90000, postTokens: 35000, tokensReclaimed: 55000 })
    )

    expect(logSpy).toHaveBeenCalledOnce()
    const line = logSpy.mock.calls[0][0] as string
    expect(line).toContain('[metrics] auto-recycle ')
    expect(line).toContain('pre=90000')
    expect(line).toContain('post=35000')
    expect(line).toContain('reclaimed=55000')
  })

  it('ring buffer wraps at capacity and preserves order', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const m = createMetricsAccumulator()

    // Snapshots ring: 200 capacity. Push 210.
    for (let i = 0; i < 210; i++) {
      m.recordContextSnapshot(snapshotMetric({ totalTokens: i }))
    }

    const snaps = m.recentSnapshots()
    expect(snaps).toHaveLength(200)
    // Oldest in buffer should start at 10 (0-9 evicted)
    expect(snaps[0].totalTokens).toBe(10)
    expect(snaps[199].totalTokens).toBe(209)
  })
})
