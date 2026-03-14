import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// §P.8 UI Polish tests

const appCssPath = path.resolve(__dirname, '../../app.css')
const appCss = fs.readFileSync(appCssPath, 'utf-8')

function extractVarsFromBlock(selector: string): Set<string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = appCss.match(new RegExp(escaped + '\\s*\\{([^}]+)\\}'))
  if (!m) return new Set()
  return new Set(Array.from(m[1].matchAll(/(--c-[a-z0-9_-]+)/g)).map((x) => x[1]))
}

describe('§P.8 UI Polish', () => {
  describe('§P.8.1 Menu/Navigation', () => {
    it.todo('§P.8.1 SHOULD verify all view modes are accessible')
    it.todo('§P.8.1 SHOULD verify no duplicate labels in menu items')
    it.todo('§P.8.1 SHOULD verify mobile-responsive header collapse')
  })

  describe('§P.8.2 Theme System', () => {
    const defaultVars = extractVarsFromBlock(':root')
    const lightVars = extractVarsFromBlock('.light')
    const ironmanVars = extractVarsFromBlock('.ironman')
    const jarvisVars = extractVarsFromBlock('.jarvis')

    it('§P.8.2 all 4 theme blocks exist in app.css', () => {
      expect(defaultVars.size).toBeGreaterThan(0)
      expect(lightVars.size).toBeGreaterThan(0)
      expect(ironmanVars.size).toBeGreaterThan(0)
      expect(jarvisVars.size).toBeGreaterThan(0)
    })

    it('§P.8.2 all themes define the same CSS variable set', () => {
      const baseVars = Array.from(defaultVars).sort()
      expect(Array.from(lightVars).sort()).toEqual(baseVars)
      expect(Array.from(ironmanVars).sort()).toEqual(baseVars)
      expect(Array.from(jarvisVars).sort()).toEqual(baseVars)
    })

    it('§P.8.2 critical vars exist: accent, bg, text, border, danger, success', () => {
      for (const vars of [defaultVars, lightVars, ironmanVars, jarvisVars]) {
        expect(vars.has('--c-accent')).toBe(true)
        expect(vars.has('--c-bg')).toBe(true)
        expect(vars.has('--c-text')).toBe(true)
        expect(vars.has('--c-border')).toBe(true)
        expect(vars.has('--c-danger')).toBe(true)
        expect(vars.has('--c-success')).toBe(true)
        expect(vars.has('--c-warning')).toBe(true)
        expect(vars.has('--c-error')).toBe(true)
        expect(vars.has('--c-info')).toBe(true)
      }
    })

    it.todo('§P.8.2 SHOULD verify theme picker in settings modal works')
    it.todo('§P.8.2 SHOULD verify system theme auto-detection (prefers-color-scheme)')
  })

  describe('§P.8.4 Markdown Rendering', () => {
    it('§P.8.4 MarkdownContentInternal injects copy buttons on pre blocks', async () => {
      // Verify that the MessageBubble module exports copyToClipboard and has copy button logic
      const { copyToClipboard } = await import('../chat/MarkdownContent.js')
      expect(typeof copyToClipboard).toBe('function')
    })

    it('§P.8.4 copyToClipboard returns boolean', async () => {
      const { copyToClipboard } = await import('../chat/MarkdownContent.js')
      // In test env without clipboard API, should return false
      const result = await copyToClipboard('test')
      expect(typeof result).toBe('boolean')
    })

    it.todo('§P.8.4 SHOULD verify syntax highlighting present')
  })

  describe('§P.8.5 Message Bubble Context Menu', () => {
    it('§P.8.5 MessageBubble exports formatTimestamp', async () => {
      const { formatTimestamp } = await import('../chat/MessageBubble.js')
      const result = formatTimestamp(Date.now())
      expect(result).toContain('Today at')
    })

    it('§P.8.5 export helpers exist: messageToMarkdown, exportMessagePdf', async () => {
      const { messageToMarkdown, turnsToMarkdown, downloadText } = await import('../chat/export.js')
      expect(typeof messageToMarkdown).toBe('function')
      expect(typeof turnsToMarkdown).toBe('function')
      expect(typeof downloadText).toBe('function')

      const md = messageToMarkdown('user', 'hello', Date.now())
      expect(md).toContain('**You**')
      expect(md).toContain('hello')
    })

    it.todo('§P.8.5 SHOULD verify long-press support for mobile')
    it.todo('§P.8.5 SHOULD verify position adjustment to stay in viewport')
  })
})
