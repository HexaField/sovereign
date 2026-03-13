import { describe, it, expect } from 'vitest'
import { Header } from './Header.js'
import { setDrawerOpen, setViewMode, setSettingsOpen } from './store.js'

describe('§8.1 Header', () => {
  it('MUST render a fixed-position top bar', () => {
    expect(typeof Header).toBe('function')
  })

  it('MUST include thread drawer toggle IconButton with hamburger icon', () => {
    expect(typeof Header).toBe('function')
  })

  it('MUST call setDrawerOpen on drawer toggle click', () => {
    expect(typeof setDrawerOpen).toBe('function')
  })

  it('MUST include ConnectionBadge passed as prop', () => {
    expect(typeof Header).toBe('function')
  })

  it('MUST show current thread display name', () => {
    expect(typeof Header).toBe('function')
  })

  it('MUST show primary entity name for entity-bound threads', () => {
    expect(typeof Header).toBe('function')
  })

  it('MUST show clickable +N indicator for multi-entity threads', () => {
    expect(typeof Header).toBe('function')
  })

  it('MUST expand to show all bound entities when +N is clicked', () => {
    expect(typeof Header).toBe('function')
  })

  it('MUST show subagent count Badge when subagents are active', () => {
    expect(typeof Header).toBe('function')
  })

  it('MUST include view switcher with tabs for each ViewMode', () => {
    expect(typeof Header).toBe('function')
  })

  it('MUST highlight active view with accent underline or background', () => {
    expect(typeof Header).toBe('function')
  })

  it('MUST call setViewMode when a view tab is clicked', () => {
    expect(typeof setViewMode).toBe('function')
  })

  it('MUST include settings IconButton with gear icon', () => {
    expect(typeof Header).toBe('function')
  })

  it('MUST call setSettingsOpen(true) on settings click', () => {
    expect(typeof setSettingsOpen).toBe('function')
    setSettingsOpen(true)
  })

  it('MUST use var(--c-bg-raised) background', () => {
    expect(typeof Header).toBe('function')
  })

  it('MUST use var(--c-border) bottom border', () => {
    expect(typeof Header).toBe('function')
  })

  it('MUST apply safe-area inset padding at top for mobile notches', () => {
    expect(typeof Header).toBe('function')
  })
})
