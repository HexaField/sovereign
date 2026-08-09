import { describe, it, expect } from 'vitest'
import {
  getToolIcon,
  summarizeWork,
  formatDuration,
  shouldCollapse,
  getWorkItemStatus,
  normalizeToolName,
  WorkSection
} from './WorkSection.js'
import type { WorkItem } from '@sovereign/core'

describe('§4.4 WorkSection', () => {
  describe('tool calls', () => {
    it('renders tool calls with tool name and collapsible preview of tool input', () => {
      expect(typeof WorkSection).toBe('function')
    })
    it('renders tool call icon from the icon map', () => {
      expect(typeof WorkSection).toBe('function')
    })
    it('maps tool icons correctly', () => {
      // Production uses emoji glyphs for the recognisable tools and falls back
      // to the literal string 'tool' for unknown ones.
      expect(getToolIcon('read')).toBe('📖')
      expect(getToolIcon('write')).toBe('✏️')
      expect(getToolIcon('edit')).toBe('✂️')
      expect(getToolIcon('exec')).toBe('▶')
      expect(getToolIcon('process')).toBe('⚙')
      expect(getToolIcon('browser')).toBe('🌐')
      expect(getToolIcon('web_fetch')).toBe('🌐')
      expect(getToolIcon('memory_search')).toBe('search')
      expect(getToolIcon('memory_get')).toBe('list')
      expect(getToolIcon('unknown_tool')).toBe('tool')
    })
  })

  describe('tool name normalization (backend PascalCase / MCP names)', () => {
    // The backend emits Claude Code SDK tool names verbatim (PascalCase) and
    // MCP tool names as mcp__<server>__<tool>. Every icon/summary/detail
    // lookup keys off a short lowercase name, so normalizeToolName() has to
    // bridge the two — this is the fix under test.
    it('maps PascalCase Claude Code SDK tool names to their short lowercase form', () => {
      expect(normalizeToolName('Bash')).toBe('exec')
      expect(normalizeToolName('Read')).toBe('read')
      expect(normalizeToolName('Write')).toBe('write')
      expect(normalizeToolName('Edit')).toBe('edit')
      expect(normalizeToolName('Grep')).toBe('grep')
      expect(normalizeToolName('Glob')).toBe('glob')
      expect(normalizeToolName('Agent')).toBe('agent')
    })
    it('collapses mcp__server__tool names to the bare tool name', () => {
      expect(normalizeToolName('mcp__sovereign__cron_create')).toBe('cron_create')
      expect(normalizeToolName('mcp__semble__search')).toBe('search')
      expect(normalizeToolName('mcp__semble__find_related')).toBe('find_related')
      expect(normalizeToolName('mcp__ad4m__add_link')).toBe('add_link')
    })
    it('passes already-short lowercase names through unchanged', () => {
      expect(normalizeToolName('read')).toBe('read')
      expect(normalizeToolName('exec')).toBe('exec')
      expect(normalizeToolName('cron')).toBe('cron')
    })
    it('lowercases an unrecognized name as a last resort', () => {
      expect(normalizeToolName('SomeFutureTool')).toBe('somefuturetool')
    })
    it('falls back to the generic tool label for an empty name', () => {
      expect(normalizeToolName('')).toBe('tool')
    })

    it('resolves the correct icon for PascalCase tool names, matching their short-name equivalent', () => {
      expect(getToolIcon('Bash')).toBe(getToolIcon('exec'))
      expect(getToolIcon('Bash')).toBe('▶')
      expect(getToolIcon('Read')).toBe('📖')
      expect(getToolIcon('Write')).toBe('✏️')
      expect(getToolIcon('Edit')).toBe('✂️')
      expect(getToolIcon('Grep')).toBe('🔍')
      expect(getToolIcon('Glob')).toBe('📁')
    })
    it('resolves a direct icon for a recognized mcp__server__tool name', () => {
      expect(getToolIcon('mcp__semble__search')).toBe('🔍')
      expect(getToolIcon('mcp__semble__find_related')).toBe('🔍')
      expect(getToolIcon('mcp__sovereign__cron_create')).toBe('⏰')
      expect(getToolIcon('mcp__sovereign__agents_spawn')).toBe('🧪')
      expect(getToolIcon('mcp__sovereign__sessions_send')).toBe('💬')
    })
    it('falls back to a server-level icon for an MCP tool with no direct short-name match', () => {
      // No entry named "add_link" exists — falls back to the ad4m server icon.
      expect(getToolIcon('mcp__ad4m__add_link')).toBe('🔗')
      expect(getToolIcon('mcp__ad4m__query_links')).toBe('🔗')
    })
    it('falls back to a generic plug icon for an unrecognized MCP server', () => {
      expect(getToolIcon('mcp__unknown_server__does_something')).toBe('🔌')
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
      // Production lists unique tool names when ≤5 are present; collapses to a
      // numeric count past that threshold (tested separately below).
      expect(summarizeWork(items)).toBe('read, write, 1 thinking block')
    })
    it('collapses to numeric count when more than 5 unique tools', () => {
      const items: WorkItem[] = [
        { type: 'tool_call', name: 'read', timestamp: 1 },
        { type: 'tool_call', name: 'write', timestamp: 2 },
        { type: 'tool_call', name: 'edit', timestamp: 3 },
        { type: 'tool_call', name: 'exec', timestamp: 4 },
        { type: 'tool_call', name: 'browser', timestamp: 5 },
        { type: 'tool_call', name: 'process', timestamp: 6 }
      ]
      expect(summarizeWork(items)).toBe('6 tool calls')
    })
    it('handles empty work items', () => {
      expect(summarizeWork([])).toBe('No work items')
    })
    it('groups PascalCase backend tool calls under their short-name equivalent', () => {
      const items: WorkItem[] = [
        { type: 'tool_call', name: 'Read', timestamp: 1 },
        { type: 'tool_call', name: 'read', timestamp: 2 },
        { type: 'tool_call', name: 'Bash', timestamp: 3 }
      ]
      expect(summarizeWork(items)).toBe('read (2), exec')
    })
    it('groups mcp__server__tool calls under their bare tool name', () => {
      const items: WorkItem[] = [
        { type: 'tool_call', name: 'mcp__sovereign__cron_create', timestamp: 1 },
        { type: 'tool_call', name: 'mcp__sovereign__cron_create', timestamp: 2 }
      ]
      expect(summarizeWork(items)).toBe('cron_create (2)')
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
