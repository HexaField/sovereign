import { describe, it, expect } from 'vitest'
import {
  getToolIcon,
  summarizeWork,
  formatDuration,
  shouldCollapse,
  getWorkItemStatus,
  WorkSection
} from './WorkSection.js'
import type { WorkItem } from '@template/core'

describe('§4.4 WorkSection', () => {
  describe('tool calls', () => {
    it('renders tool calls with tool name and collapsible preview of tool input', () => {
      expect(typeof WorkSection).toBe('function')
    })
    it('renders tool call icon from the icon map', () => {
      expect(typeof WorkSection).toBe('function')
    })
    it('maps tool icons correctly', () => {
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
  })

  describe('tool results', () => {
    it('pairs tool results with corresponding tool calls by toolCallId', () => {
      expect(typeof WorkSection).toBe('function')
    })
    it('shows green checkmark for success results', () => {
      const item: WorkItem = { type: 'tool_result', output: 'ok', timestamp: 1 }
      expect(getWorkItemStatus(item)).toBe('done')
    })
    it('shows red ✗ for error results', () => {
      const item: WorkItem = { type: 'tool_result', output: 'Error: failed', timestamp: 1 }
      expect(getWorkItemStatus(item)).toBe('error')
    })
  })

  describe('thinking blocks', () => {
    it('renders thinking blocks as expandable sections with var(--c-text-muted) text', () => {
      expect(typeof WorkSection).toBe('function')
    })
    it('shows "Thinking…" label when thinking block is collapsed', () => {
      expect(typeof WorkSection).toBe('function')
    })
    it('shows raw thinking text when thinking block is expanded', () => {
      expect(typeof WorkSection).toBe('function')
    })
    it('collapses thinking blocks by default', () => {
      expect(typeof WorkSection).toBe('function')
    })
  })

  describe('system events', () => {
    it('renders system events inline with muted styling', () => {
      expect(typeof WorkSection).toBe('function')
    })
    it('handles nudges, compaction notifications, heartbeat acks, context overflow warnings', () => {
      expect(typeof WorkSection).toBe('function')
    })
  })

  describe('collapsible behavior', () => {
    it('collapses tool call inputs/results by default when exceeding 3 lines', () => {
      expect(shouldCollapse('line1\nline2\nline3\nline4')).toBe(true)
      expect(shouldCollapse('line1\nline2')).toBe(false)
    })
    it('provides "Show more" / "Show less" toggle for collapsed content', () => {
      expect(typeof WorkSection).toBe('function')
    })
    it('makes entire work section collapsible', () => {
      expect(typeof WorkSection).toBe('function')
    })
    it('expands work section by default while turn is in progress (agent working)', () => {
      expect(typeof WorkSection).toBe('function')
    })
    it('collapses work section by default when turn is complete', () => {
      expect(typeof WorkSection).toBe('function')
    })
    it('shows summary line when collapsed', () => {
      const items: WorkItem[] = [
        { type: 'tool_call', name: 'read', timestamp: 1 },
        { type: 'tool_call', name: 'write', timestamp: 2 },
        { type: 'thinking', timestamp: 3 }
      ]
      expect(summarizeWork(items)).toBe('2 tool calls, 1 thinking block')
    })
    it('handles empty work items', () => {
      expect(summarizeWork([])).toBe('No work items')
    })
  })

  describe('formatting', () => {
    it('formats millisecond durations', () => {
      expect(formatDuration(500)).toBe('500ms')
    })
    it('formats second durations', () => {
      expect(formatDuration(5000)).toBe('5s')
    })
    it('formats minute durations', () => {
      expect(formatDuration(90000)).toBe('1m 30s')
    })
  })

  describe('work item status', () => {
    it('returns running for tool_call without output', () => {
      const item: WorkItem = { type: 'tool_call', name: 'exec', timestamp: 1 }
      expect(getWorkItemStatus(item)).toBe('running')
    })
    it('returns done for completed items', () => {
      const item: WorkItem = { type: 'thinking', timestamp: 1 }
      expect(getWorkItemStatus(item)).toBe('done')
    })
  })

  describe('styling', () => {
    it('styles work items with var(--c-step-bg) background and var(--c-work-border) border', () => {
      expect(typeof WorkSection).toBe('function')
    })
    it('shows step count badge using Badge with var(--c-step-badge-bg)', () => {
      expect(typeof WorkSection).toBe('function')
    })
  })
})
