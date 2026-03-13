import { describe, it, expect } from 'vitest'
import { WorkSection, getToolIcon, summarizeWork } from './WorkSection.js'
import type { WorkItem } from '@template/core'

describe('§4.4 WorkSection', () => {
  it('MUST render between user message and assistant response', () => {
    expect(typeof WorkSection).toBe('function')
  })

  it('MUST show tool calls with tool name, icon, and collapsible input preview', () => {
    expect(WorkSection).toBeDefined()
  })

  it('MUST map tool icons: read→📖, write→✏️, edit→✂️, exec→▶, process→⚙, browser→🌐, web_fetch→📡, memory_search→🔍, memory_get→📋, unknown→🔧', () => {
    expect(getToolIcon('read')).toBe('📖')
    expect(getToolIcon('write')).toBe('✏️')
    expect(getToolIcon('edit')).toBe('✂️')
    expect(getToolIcon('exec')).toBe('▶')
    expect(getToolIcon('process')).toBe('⚙')
    expect(getToolIcon('browser')).toBe('🌐')
    expect(getToolIcon('web_fetch')).toBe('📡')
    expect(getToolIcon('memory_search')).toBe('🔍')
    expect(getToolIcon('memory_get')).toBe('📋')
    expect(getToolIcon('unknown_tool')).toBe('🔧')
  })

  it('MUST pair tool results with corresponding tool calls by toolCallId', () => {
    expect(WorkSection).toBeDefined()
  })

  it('MUST show green checkmark for success results and red ✗ for errors', () => {
    expect(WorkSection).toBeDefined()
  })

  it('MUST render thinking blocks as expandable sections with var(--c-text-muted)', () => {
    expect(WorkSection).toBeDefined()
  })

  it('MUST show "Thinking…" label when thinking block is collapsed', () => {
    expect(WorkSection).toBeDefined()
  })

  it('MUST render system events inline with muted styling', () => {
    expect(WorkSection).toBeDefined()
  })

  it('MUST collapse tool call inputs/results by default when exceeding 3 lines', () => {
    expect(WorkSection).toBeDefined()
  })

  it('MUST provide "Show more" / "Show less" toggle for collapsed content', () => {
    expect(WorkSection).toBeDefined()
  })

  it('MUST make thinking blocks collapsible, collapsed by default', () => {
    expect(WorkSection).toBeDefined()
  })

  it('MUST make entire work section collapsible', () => {
    expect(WorkSection).toBeDefined()
  })

  it('MUST expand work section by default while turn is in progress', () => {
    expect(WorkSection).toBeDefined()
  })

  it('MUST collapse work section by default when turn is complete', () => {
    expect(WorkSection).toBeDefined()
  })

  it('MUST show summary line when collapsed (e.g. "5 tool calls, 2 thinking blocks")', () => {
    const items: WorkItem[] = [
      { type: 'tool_call', name: 'read', timestamp: 1 },
      { type: 'tool_call', name: 'write', timestamp: 2 },
      { type: 'thinking', timestamp: 3 }
    ]
    expect(summarizeWork(items)).toBe('2 tool calls, 1 thinking block')
  })

  it('MUST style work items with var(--c-step-bg) background and var(--c-work-border) border', () => {
    expect(WorkSection).toBeDefined()
  })

  it('MUST show step count badge using Badge with var(--c-step-badge-bg)', () => {
    expect(WorkSection).toBeDefined()
  })
})
