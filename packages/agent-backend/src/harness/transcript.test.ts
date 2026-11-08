import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { atifTurns, codexTurns, opencodeTurns } from './transcript.js'

const ATIF = path.join(import.meta.dirname, 'atif.fixture.json')

describe('atifTurns', () => {
  it('turns each agent step into an assistant turn with its reasoning, tool calls and results', () => {
    const turns = atifTurns(ATIF)
    expect(turns).toHaveLength(2)
    const [work, report] = turns
    expect(work).toMatchObject({
      role: 'assistant',
      content: "I'll look at the range helper first.",
      timestamp: Date.parse('2026-11-01T10:00:05.000Z'),
      thinkingBlocks: ['The bug is probably in the loop bound.']
    })
    expect(work.workItems).toEqual([
      expect.objectContaining({
        type: 'tool_call',
        name: 'read_file',
        toolCallId: 'call_1',
        input: JSON.stringify({ path: '/work/repo/src/range.ts' })
      }),
      // An MCP call carries its server and tool in the arguments: named as Claude names it.
      expect.objectContaining({
        type: 'tool_call',
        name: 'mcp__code__edit',
        toolCallId: 'call_2',
        input: JSON.stringify({ file: '/work/repo/src/range.ts', ops: [] })
      }),
      expect.objectContaining({ type: 'tool_result', toolCallId: 'call_1', output: expect.stringContaining('i <= n') }),
      expect.objectContaining({ type: 'tool_result', toolCallId: 'call_2', output: 'Edited src/range.ts' })
    ])
    expect(report).toMatchObject({ role: 'assistant', workItems: [], thinkingBlocks: [] })
    expect(report.content).toMatch(/^Fixed the loop bound/)
  })

  it('skips the system and user steps (the brief)', () => {
    expect(atifTurns(ATIF).some((t) => t.content.includes('Running as a Sovereign subagent'))).toBe(false)
  })

  it('yields nothing for a missing or non-ATIF file', () => {
    expect(atifTurns(path.join(import.meta.dirname, 'no-such-export'))).toEqual([])
    expect(atifTurns(path.join(import.meta.dirname, 'transcript.ts'))).toEqual([])
  })
})

describe('opencodeTurns', () => {
  it('groups text, reasoning and tool parts by message', () => {
    const stdout = [
      JSON.stringify({ type: 'step_start', timestamp: 1000, part: { messageID: 'm1' } }),
      JSON.stringify({ type: 'reasoning', timestamp: 1001, part: { messageID: 'm1', text: 'Check the file.' } }),
      JSON.stringify({
        type: 'tool_use',
        timestamp: 1002,
        part: {
          messageID: 'm1',
          tool: 'read',
          callID: 'c1',
          state: { status: 'completed', input: { filePath: '/work/repo/a.ts' }, output: 'const a = 1' }
        }
      }),
      'not json',
      JSON.stringify({ type: 'text', timestamp: 2000, part: { messageID: 'm2', text: 'Done: a is 1.' } })
    ].join('\n')
    const turns = opencodeTurns(stdout)
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ content: '', thinkingBlocks: ['Check the file.'] })
    expect(turns[0].workItems).toEqual([
      expect.objectContaining({ type: 'tool_call', name: 'read', toolCallId: 'c1' }),
      expect.objectContaining({ type: 'tool_result', toolCallId: 'c1', output: 'const a = 1' })
    ])
    expect(turns[1]).toMatchObject({ role: 'assistant', content: 'Done: a is 1.', workItems: [] })
  })
})

describe('codexTurns', () => {
  it('makes a turn of the work between messages and a turn of each message', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'Look first.' } }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'i1', type: 'command_execution', command: 'ls', aggregated_output: 'a.ts', status: 'completed' }
      }),
      JSON.stringify({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'Only a.ts.' } })
    ].join('\n')
    const turns = codexTurns(stdout, 5000)
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ content: '', thinkingBlocks: ['Look first.'], timestamp: 5000 })
    expect(turns[0].workItems).toEqual([
      expect.objectContaining({ type: 'tool_call', name: 'Bash', input: JSON.stringify({ command: 'ls' }) }),
      expect.objectContaining({ type: 'tool_result', output: 'a.ts' })
    ])
    expect(turns[1]).toMatchObject({ content: 'Only a.ts.', workItems: [] })
  })
})
