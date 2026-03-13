import { describe, it } from 'vitest'

describe('§1.5 UI Design System', () => {
  describe('Card', () => {
    it.todo('MUST render a container with var(--c-bg-raised) background')
    it.todo('MUST render var(--c-border) border and rounded corners')
    it.todo('MUST accept children and optional class prop')
  })

  describe('Badge', () => {
    it.todo('MUST render a small inline label with accent background')
    it.todo('MUST accept count and variant props')
    it.todo('MUST hide when count is 0 or undefined')
  })

  describe('Chip', () => {
    it.todo('MUST render a monospace text chip with optional leading icon')
    it.todo('MUST show var(--c-border) border')
    it.todo('MUST show var(--c-accent) border on hover')
    it.todo('MUST accept label, icon, and onRemove props')
  })

  describe('IconButton', () => {
    it.todo('MUST render an icon-only button with var(--c-hover-bg) on hover')
    it.todo('MUST show var(--c-active-bg) on active')
    it.todo('MUST accept icon, onClick, disabled, and title props')
    it.todo('MUST include aria-label derived from title')
  })

  describe('Spinner', () => {
    it.todo('MUST render a CSS-animated loading indicator using theme accent color')
  })

  describe('Tooltip', () => {
    it.todo('MUST render a hover-triggered tooltip positioned above or below the target')
    it.todo('MUST accept text, position, and children props')
  })

  describe('Modal', () => {
    it.todo('MUST render an overlay dialog with var(--c-backdrop) background')
    it.todo('MUST render centered content panel with var(--c-overlay-bg) background')
    it.todo('MUST accept open, onClose, title, and children props')
    it.todo('MUST trap focus inside the modal when open')
    it.todo('MUST close on Escape key')
    it.todo('MUST close on backdrop click')
  })
})
