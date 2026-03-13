import { describe, it, expect } from 'vitest'
import { exportAsMarkdown, exportAsPdf, exportAsText } from './export.js'
import type { ParsedTurn } from '@template/core'

const turns: ParsedTurn[] = [
  { role: 'user', content: 'Hello', timestamp: 1700000000000, workItems: [], thinkingBlocks: [] },
  { role: 'assistant', content: 'Hi there!', timestamp: 1700000001000, workItems: [], thinkingBlocks: [] }
]

describe('Message Export', () => {
  it('MUST export conversation as markdown format', () => {
    const md = exportAsMarkdown(turns)
    expect(md).toContain('### User')
    expect(md).toContain('### Assistant')
    expect(md).toContain('Hello')
    expect(md).toContain('Hi there!')
  })

  it('MUST export conversation as PDF format', () => {
    const blob = exportAsPdf(turns)
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('application/pdf')
  })

  it('MUST export conversation as plain text format', () => {
    const text = exportAsText(turns)
    expect(text).toContain('[User]')
    expect(text).toContain('[Assistant]')
    expect(text).toContain('Hello')
    expect(text).toContain('Hi there!')
  })

  it('MUST include message timestamps in exports', () => {
    const md = exportAsMarkdown(turns)
    // Should contain formatted timestamp
    expect(md).toContain('2023')
    const text = exportAsText(turns)
    expect(text).toContain('2023')
  })

  it('MUST include message roles (user/assistant/system) in exports', () => {
    const withSystem: ParsedTurn[] = [
      ...turns,
      { role: 'system', content: 'System msg', timestamp: 1700000002000, workItems: [], thinkingBlocks: [] }
    ]
    const md = exportAsMarkdown(withSystem)
    expect(md).toContain('User')
    expect(md).toContain('Assistant')
    expect(md).toContain('System')
  })
})
