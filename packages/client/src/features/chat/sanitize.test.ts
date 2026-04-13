import { describe, it, expect } from 'vitest'
import { sanitizeContent, isCompactionMessage } from './sanitize.js'

describe('sanitizeContent', () => {
  describe('assistant messages', () => {
    it('strips internal context blocks', () => {
      const input = `Here is my response.\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nOpenClaw runtime context (internal): stuff\n[Internal task completion event]\nsource: subagent\nsession_key: agent:main:subagent:xxx\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>`
      expect(sanitizeContent('assistant', input)).toBe('Here is my response.')
    })

    it('strips System (untrusted) exec notifications', () => {
      const input = `Some response text.\nSystem (untrusted): [2026-04-13 13:58:22 GMT+10] Exec completed (grand-pi, code 0) :: output\nMore text here.`
      expect(sanitizeContent('assistant', input)).toBe('Some response text.\n\nMore text here.')
    })

    it('strips tool call summary lines', () => {
      const input = `▶ ✓ exec (4), process, sessions_spawn, sessions_yield\n\nHere is the actual response.`
      expect(sanitizeContent('assistant', input)).toBe('Here is the actual response.')
    })

    it('strips ▶ ! ▶ style summaries', () => {
      const input = `▶ ! ▶ exec (26), process (5)\n\nActual content.`
      expect(sanitizeContent('assistant', input)).toBe('Actual content.')
    })

    it('handles all patterns combined', () => {
      const input = `▶ ✓ exec (4), process\n\nHere is the response.\nSystem (untrusted): [2026-04-13 14:08:02 GMT+10] Exec failed (neat-wil, code 0) :: output\nMore content.\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nstuff\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>`
      expect(sanitizeContent('assistant', input)).toBe('Here is the response.\n\nMore content.')
    })

    it('returns empty content as-is', () => {
      expect(sanitizeContent('assistant', '')).toBe('')
    })

    it('leaves clean messages untouched', () => {
      expect(sanitizeContent('assistant', 'Hello world')).toBe('Hello world')
    })
  })

  describe('user messages', () => {
    it('strips sender envelope with JSON metadata', () => {
      const input = `Sender (untrusted metadata):\n\`\`\`json\n{\n  "label": "openclaw-control-ui",\n  "id": "openclaw-control-ui"\n}\n\`\`\`\n\n[Mon 2026-04-13 14:08 GMT+10] Actual message here`
      expect(sanitizeContent('user', input)).toBe('Actual message here')
    })

    it('strips just the timestamp prefix', () => {
      const input = `[Mon 2026-04-13 14:08 GMT+10] Hello there`
      expect(sanitizeContent('user', input)).toBe('Hello there')
    })

    it('leaves clean user messages untouched', () => {
      expect(sanitizeContent('user', 'Just a normal message')).toBe('Just a normal message')
    })
  })

  describe('system messages', () => {
    it('passes through system messages unchanged', () => {
      const input = 'Some system message'
      expect(sanitizeContent('system', input)).toBe(input)
    })
  })
})

describe('isCompactionMessage', () => {
  it('detects compaction messages', () => {
    expect(isCompactionMessage('⚙️ Compacted (485k → 4.0k) • Context 4.0k/1.0m (0%)')).toBe(true)
  })

  it('rejects non-compaction messages', () => {
    expect(isCompactionMessage('Hello world')).toBe(false)
  })
})
